import { hasActiveEntitlement, planLimit } from './entitlements.js';
import { Body, Controller, Delete, ForbiddenException, Get, Inject, NotFoundException, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Database } from './database.js';
import { SessionGuard, TenantPolicy } from './security.js';
import type { ActorRequest } from './security.js';
import { uuid } from './organizations.js';
import { lockOrganization } from './credits.js';

export const projectSchema = z.object({ name: z.string().trim().min(2).max(100), description: z.string().trim().min(20).max(5000), website: z.url().optional(), industry: z.string().max(100).optional(), targetMarket: z.string().max(300).optional() }).strict();

@Controller('organizations/:orgId/projects')
@UseGuards(SessionGuard)
export class ProjectsController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(TenantPolicy) private readonly policy: TenantPolicy) {}
  @Get() async list(@Req() req: ActorRequest, @Param('orgId') orgId: string) {
    await this.policy.authorize(req.actor.id, uuid(orgId));
    return this.db.project.findMany({ where: { organizationId: orgId, deletedAt: null }, orderBy: { updatedAt: 'desc' }, take: 100, include: { _count: { select: { competitors: true, sources: true, reports: true } }, runs: { take: 1, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, createdAt: true } } } });
  }
  @Get('archived') async archived(@Req() req: ActorRequest, @Param('orgId') orgId: string) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'edit'); return this.db.project.findMany({ where: { organizationId: orgId, deletedAt: { not: null } }, orderBy: { deletedAt: 'desc' }, take: 100, select: { id: true, name: true, deletedAt: true } });
  }
  @Post(':id/restore') async restore(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'edit');
    await this.db.$transaction(async tx => {
      await lockOrganization(tx, orgId); const sub = await tx.subscription.findUniqueOrThrow({ where: { organizationId: orgId }, include: { plan: { include: { entitlements: true } } } });
      if (!hasActiveEntitlement(sub)) throw new ForbiddenException('An active subscription or grace period is required');
      const project = await tx.project.findFirstOrThrow({ where: { organizationId: orgId, id: uuid(id), deletedAt: { not: null } } });
      if (await tx.project.count({ where: { organizationId: orgId, deletedAt: null } }) >= planLimit(sub.plan, 'projectLimit')) throw new ForbiddenException('Your plan project limit has been reached');
      await tx.project.update({ where: { id: project.id }, data: { deletedAt: null } });
      await tx.auditLog.create({ data: { organizationId: orgId, actorId: req.actor.id, action: 'project.restored', resourceId: project.id } });
    }); return { message: 'Project restored. Review and enable monitors separately.' };
  }
  @Post() async create(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Body() input: unknown) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'research');
    const data = projectSchema.parse(input);
    return this.db.$transaction(async tx => {
      await lockOrganization(tx, orgId);
      const sub = await tx.subscription.findUniqueOrThrow({ where: { organizationId: orgId }, include: { plan: { include: { entitlements: true } } } });
      if (!hasActiveEntitlement(sub)) throw new ForbiddenException('An active subscription or grace period is required');
      if (await tx.project.count({ where: { organizationId: orgId, deletedAt: null } }) >= planLimit(sub.plan, 'projectLimit')) throw new ForbiddenException('Your plan project limit has been reached');
      const project = await tx.project.create({ data: { organizationId: orgId, ...data } });
      await tx.auditLog.create({ data: { organizationId: orgId, actorId: req.actor.id, action: 'project.created', resourceId: project.id } }); return project;
    });
  }
  @Get(':id') async get(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string) {
    await this.policy.authorize(req.actor.id, uuid(orgId));
    const project = await this.db.project.findFirst({ where: { id: uuid(id), organizationId: orgId, deletedAt: null }, include: { competitors: true, runs: { orderBy: { createdAt: 'desc' }, take: 20, include: { stages: true } }, reports: { where: { run: { status: 'COMPLETED' } }, orderBy: { createdAt: 'desc' }, take: 10 }, sources: { orderBy: { retrievedAt: 'desc' }, take: 100, select: { id: true, url: true, title: true, retrievedAt: true, verification: true, runId: true } }, findings: { where: { run: { status: 'COMPLETED' } }, take: 200, orderBy: { createdAt: 'desc' }, include: { evidence: { include: { source: { select: { url: true, title: true } } } } } } } });
    if (!project) throw new NotFoundException('Project not found'); return project;
  }
  @Patch(':id') async update(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string, @Body() input: unknown) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'edit');
    const data = projectSchema.partial().extend({ website: z.url().nullable().optional(), industry: z.string().max(100).nullable().optional(), targetMarket: z.string().max(300).nullable().optional() }).strict().parse(input);
    await this.db.$transaction(async tx => { const result = await tx.project.updateMany({ where: { id: uuid(id), organizationId: orgId, deletedAt: null }, data }); if (!result.count) throw new NotFoundException('Project not found'); await tx.auditLog.create({ data: { organizationId: orgId, actorId: req.actor.id, action: 'project.updated', resourceId: id } }); }); return { message: 'Project updated' };
  }
  @Delete(':id') async remove(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'edit');
    const projectId = uuid(id);
    await this.db.$transaction(async tx => {
      if (await tx.researchRun.count({ where: { organizationId: orgId, projectId, status: { in: ['QUEUED', 'RUNNING'] } } })) throw new ForbiddenException('Cancel active research before archiving');
      const result = await tx.project.updateMany({ where: { id: projectId, organizationId: orgId, deletedAt: null }, data: { deletedAt: new Date() } });
      if (!result.count) throw new NotFoundException('Project not found');
      await tx.monitor.updateMany({ where: { projectId, organizationId: orgId }, data: { enabled: false } });
      await tx.auditLog.create({ data: { organizationId: orgId, actorId: req.actor.id, action: 'project.archived', resourceId: id } });
    }); return { message: 'Project archived' };
  }
  @Get(':id/comments') async comments(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string) {
    await this.policy.authorize(req.actor.id, uuid(orgId)); return this.db.comment.findMany({ where: { organizationId: orgId, projectId: uuid(id) }, orderBy: { createdAt: 'asc' }, take: 100 });
  }
  @Post(':id/comments') async comment(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string, @Body() input: unknown) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'edit');
    const { body } = z.object({ body: z.string().trim().min(1).max(4000) }).strict().parse(input);
    await this.db.project.findFirstOrThrow({ where: { id: uuid(id), organizationId: orgId, deletedAt: null } });
    return this.db.comment.create({ data: { organizationId: orgId, projectId: id, authorId: req.actor.id, body } });
  }
}
