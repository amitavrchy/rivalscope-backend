import { Body, Controller, Delete, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import { Database } from './database.js';
import { SessionGuard, TenantPolicy, newToken, hashToken, SESSION_COOKIE, can } from './security.js';
import type { ActorRequest } from './security.js';
import { env } from './config.js';

@Controller('organizations/:orgId')
@UseGuards(SessionGuard)
export class CollaborationController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(TenantPolicy) private readonly policy: TenantPolicy) {}
  @Get('invitations') async invitations(@Req() req: ActorRequest, @Param('orgId') orgId: string) {
    await this.policy.authorize(req.actor.id, z.uuid().parse(orgId), 'team'); return this.db.invitation.findMany({ where: { organizationId: orgId }, select: { id: true, email: true, role: true, expiresAt: true, acceptedAt: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 100 });
  }
  @Delete('invitations/:id') async revokeInvitation(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string) {
    const actor = await this.policy.authorize(req.actor.id, z.uuid().parse(orgId), 'team');
    const invite = await this.db.invitation.findFirstOrThrow({ where: { id: z.uuid().parse(id), organizationId: orgId, acceptedAt: null } });
    if (invite.role === 'ADMIN' && actor.role !== 'OWNER') throw new ForbiddenException('Only the owner can manage administrator invitations');
    await this.db.$transaction([this.db.invitation.update({ where: { id }, data: { expiresAt: new Date() } }), this.db.auditLog.create({ data: { organizationId: orgId, actorId: req.actor.id, action: 'invitation.revoked', resourceId: id } })]); return { message: 'Invitation revoked' };
  }
  @Get('projects/:projectId/collaboration') async project(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('projectId') projectId: string) {
    await this.policy.authorize(req.actor.id, z.uuid().parse(orgId));
    const project = await this.db.project.findFirst({ where: { id: z.uuid().parse(projectId), organizationId: orgId, deletedAt: null }, include: { members: { include: { user: { select: { id: true, name: true, email: true } } } }, bookmarks: { where: { userId: req.actor.id }, orderBy: { createdAt: 'desc' } }, comments: { orderBy: { createdAt: 'desc' }, take: 100 } } });
    if (!project) throw new NotFoundException('Project not found'); return { members: project.members, bookmarks: project.bookmarks, comments: project.comments };
  }
  @Post('projects/:projectId/members') async addMember(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('projectId') projectId: string, @Body() input: unknown) {
    await this.policy.authorize(req.actor.id, z.uuid().parse(orgId), 'team'); const { userId } = z.object({ userId: z.uuid() }).strict().parse(input);
    await this.db.project.findFirstOrThrow({ where: { id: z.uuid().parse(projectId), organizationId: orgId, deletedAt: null } });
    await this.db.membership.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: orgId, userId } } });
    return this.db.projectMember.upsert({ where: { organizationId_projectId_userId: { organizationId: orgId, projectId, userId } }, create: { organizationId: orgId, projectId, userId }, update: {} });
  }
  @Delete('projects/:projectId/members/:userId') async removeMember(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('projectId') projectId: string, @Param('userId') userId: string) {
    await this.policy.authorize(req.actor.id, z.uuid().parse(orgId), 'team'); await this.db.projectMember.deleteMany({ where: { organizationId: orgId, projectId: z.uuid().parse(projectId), userId: z.uuid().parse(userId) } }); return { message: 'Project participant removed; workspace permissions still apply' };
  }
  @Post('projects/:projectId/bookmarks') async bookmark(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('projectId') projectId: string, @Body() input: unknown) {
    await this.policy.authorize(req.actor.id, z.uuid().parse(orgId)); const { note } = z.object({ note: z.string().trim().min(1).max(2000) }).strict().parse(input);
    await this.db.project.findFirstOrThrow({ where: { id: z.uuid().parse(projectId), organizationId: orgId, deletedAt: null } }); return this.db.bookmark.create({ data: { organizationId: orgId, projectId, userId: req.actor.id, note } });
  }
  @Delete('bookmarks/:id') async removeBookmark(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string) { await this.policy.authorize(req.actor.id, z.uuid().parse(orgId)); await this.db.bookmark.deleteMany({ where: { id: z.uuid().parse(id), organizationId: orgId, userId: req.actor.id } }); return { message: 'Bookmark removed' }; }
  @Get('reports/:id/shares') async shares(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string) { await this.policy.authorize(req.actor.id, z.uuid().parse(orgId), 'edit'); return this.db.shareLink.findMany({ where: { organizationId: orgId, reportId: z.uuid().parse(id) }, select: { id: true, audience: true, expiresAt: true, revokedAt: true, createdAt: true } }); }
  @Post('reports/:id/shares') async share(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string, @Body() input: unknown) {
    await this.policy.authorize(req.actor.id, z.uuid().parse(orgId), 'edit');
    const data = z.object({ audience: z.enum(['WORKSPACE', 'PUBLIC']), password: z.string().min(12).max(128).optional(), days: z.number().int().min(1).max(30), confirmPublic: z.boolean().default(false) }).strict().parse(input);
    if (data.audience === 'PUBLIC' && !data.confirmPublic) throw new ForbiddenException('Explicit public sharing confirmation is required');
    const flag = await this.db.featureFlag.findUnique({ where: { id: 'public_sharing' } }); if (data.audience === 'PUBLIC' && flag && !flag.enabled) throw new ForbiddenException('Public sharing is disabled by the platform operator');
    await this.db.report.findFirstOrThrow({ where: { id: z.uuid().parse(id), organizationId: orgId, run: { status: 'COMPLETED' }, project: { deletedAt: null } } });
    const token = newToken(); const link = await this.db.shareLink.create({ data: { organizationId: orgId, reportId: id, createdBy: req.actor.id, audience: data.audience, passwordHash: data.password ? await argon2.hash(data.password) : null, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + data.days * 86400_000) } });
    await this.db.auditLog.create({ data: { organizationId: orgId, actorId: req.actor.id, action: `report.shared.${data.audience.toLowerCase()}`, resourceId: id } }); return { id: link.id, url: `${env.APP_ORIGIN}/shared/${token}`, expiresAt: link.expiresAt };
  }
  @Delete('shares/:id') async revokeShare(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string) { await this.policy.authorize(req.actor.id, z.uuid().parse(orgId), 'edit'); await this.db.shareLink.updateMany({ where: { id: z.uuid().parse(id), organizationId: orgId }, data: { revokedAt: new Date() } }); return { message: 'Share link revoked' }; }
}

@Controller('shared')
@Throttle({ default: { limit: 10, ttl: 60000 } })
export class SharedReportsController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Post(':token') async read(@Req() req: Request, @Param('token') token: string, @Body() input: unknown) {
    z.string().min(40).max(100).parse(token); const { password } = z.object({ password: z.string().max(128).optional() }).strict().parse(input);
    const link = await this.db.shareLink.findUnique({ where: { tokenHash: hashToken(token) }, include: { report: { include: { project: true } } } });
    if (!link || link.revokedAt || link.expiresAt <= new Date() || link.report.project.deletedAt) throw new NotFoundException('Share link is unavailable or expired');
    const flag = await this.db.featureFlag.findUnique({ where: { id: 'public_sharing' } }); if (link.audience === 'PUBLIC' && flag && !flag.enabled) throw new ForbiddenException('Public sharing is currently disabled');
    if (link.passwordHash && (!password || !await argon2.verify(link.passwordHash, password))) throw new ForbiddenException('Report password is required or incorrect');
    if (link.audience === 'WORKSPACE') {
      const token = (req.cookies as Record<string, string>)[SESSION_COOKIE] || '';
      const session = await this.db.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
      if (!session || session.expiresAt <= new Date() || session.user.deletedAt) throw new ForbiddenException('Sign in to the shared workspace first');
      const member = await this.db.membership.findUnique({ where: { organizationId_userId: { organizationId: link.organizationId, userId: session.userId } } });
      if (!member || !can(member.role, 'read')) throw new ForbiddenException('Workspace research permission is required');
    }
    const sources = await this.db.source.findMany({ where: { organizationId: link.organizationId, runId: link.report.runId }, select: { id: true, url: true, title: true, retrievedAt: true } });
    return { title: link.report.title, createdAt: link.report.createdAt, content: link.report.content, sources };
  }
}
