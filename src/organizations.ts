import { Body, Controller, Delete, ForbiddenException, Get, Inject, NotFoundException, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Database } from './database.js';
import { SessionGuard, TenantPolicy, hashToken, newToken } from './security.js';
import type { ActorRequest } from './security.js';
import { MailService } from './mail.js';
import { env } from './config.js';
import { AccountSecurityService, reauthentication } from './account-security.js';
import { hasActiveEntitlement, planLimit } from './entitlements.js';

export const uuid = (value: string) => z.uuid().parse(value);
const inviteRoles = z.enum(['ADMIN', 'ANALYST', 'EDITOR', 'VIEWER', 'BILLING_MANAGER']);

@Controller('organizations')
@UseGuards(SessionGuard)
export class OrganizationsController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(TenantPolicy) private readonly policy: TenantPolicy, @Inject(MailService) private readonly mail: MailService, @Inject(AccountSecurityService) private readonly security: AccountSecurityService) {}
  @Post(':id/transfer-ownership') async transfer(@Req() req: ActorRequest, @Param('id') id: string, @Body() input: unknown) {
    await this.policy.authorize(req.actor.id, uuid(id), 'owner');
    const data = reauthentication.extend({ userId: z.uuid() }).strict().parse(input); await this.security.reauthenticate(req.actor.id, data);
    if (data.userId === req.actor.id) throw new ForbiddenException('Select a different existing member');
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${data.userId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.membership.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: id, userId: req.actor.id } } });
      if (current.role !== 'OWNER') throw new ForbiddenException('Ownership has changed');
      const target = await tx.membership.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: id, userId: data.userId } }, include: { user: true } });
      if (!target.user.emailVerifiedAt || target.user.deletedAt) throw new ForbiddenException('The new owner must have a verified active account');
      await tx.membership.update({ where: { id: current.id }, data: { role: 'ADMIN' } }); await tx.membership.update({ where: { id: target.id }, data: { role: 'OWNER' } });
      await tx.auditLog.create({ data: { organizationId: id, actorId: req.actor.id, action: 'organization.ownership_transferred', resourceId: target.userId } });
    }); return { message: 'Ownership transferred. Your role is now ADMIN.' };
  }
  @Get() list(@Req() req: ActorRequest) { return this.db.membership.findMany({ where: { userId: req.actor.id }, select: { role: true, organization: { select: { id: true, name: true, slug: true } } } }); }
  @Post() async create(@Req() req: ActorRequest, @Body() input: unknown) {
    const data = z.object({ name: z.string().trim().min(2).max(100) }).strict().parse(input);
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.actor.id}::uuid FOR UPDATE`;
      const account = await tx.user.findUniqueOrThrow({ where: { id: req.actor.id } }); if (account.deletedAt) throw new ForbiddenException('Account is unavailable');
      const count = await tx.membership.count({ where: { userId: req.actor.id, role: 'OWNER' } });
      if (count >= 10) throw new ForbiddenException('Workspace creation limit reached');
      const plan = await tx.plan.findUniqueOrThrow({ where: { id: 'free' }, include: { entitlements: true } });
      const org = await tx.organization.create({ data: { name: data.name, slug: randomUUID(), credits: planLimit(plan, 'monthlyCredits'), memberships: { create: { userId: req.actor.id, role: 'OWNER' } }, subscription: { create: { planId: 'free' } } } });
      await tx.creditLedger.create({ data: { organizationId: org.id, kind: 'GRANT', amount: planLimit(plan, 'monthlyCredits'), balanceAfter: org.credits, idempotencyKey: `create-${org.id}` } });
      return org;
    });
  }
  @Get(':id') async get(@Req() req: ActorRequest, @Param('id') id: string) {
    const membership = await this.db.membership.findUnique({ where: { organizationId_userId: { organizationId: uuid(id), userId: req.actor.id } } });
    if (!membership) throw new ForbiddenException('Workspace access denied');
    const org = await this.db.organization.findUniqueOrThrow({ where: { id }, include: { subscription: { include: { plan: { include: { entitlements: true } } } }, _count: { select: { projects: { where: { deletedAt: null } }, memberships: true } } } });
    return { ...org, role: membership.role };
  }
  @Patch(':id') async update(@Req() req: ActorRequest, @Param('id') id: string, @Body() input: unknown) {
    await this.policy.authorize(req.actor.id, uuid(id), 'team');
    const data = z.object({ name: z.string().trim().min(2).max(100).optional(), industry: z.string().max(100).optional(), website: z.url().optional(), timezone: z.string().refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }).optional() }).strict().parse(input);
    return this.db.$transaction(async tx => {
      const org = await tx.organization.update({ where: { id }, data });
      await tx.auditLog.create({ data: { organizationId: id, actorId: req.actor.id, action: 'organization.updated', resourceId: id } }); return org;
    });
  }
  @Get(':id/team') async team(@Req() req: ActorRequest, @Param('id') id: string) {
    await this.policy.authorize(req.actor.id, uuid(id), 'team');
    return this.db.membership.findMany({ where: { organizationId: id }, select: { id: true, role: true, user: { select: { id: true, email: true, name: true } } } });
  }
  @Post(':id/invitations') async invite(@Req() req: ActorRequest, @Param('id') id: string, @Body() input: unknown) {
    const actor = await this.policy.authorize(req.actor.id, uuid(id), 'team');
    if (!req.actor.verified) throw new ForbiddenException('Verify your email before inviting members');
    const data = z.object({ email: z.email().transform(s => s.toLowerCase()), role: inviteRoles }).strict().parse(input);
    if (data.role === 'ADMIN' && actor.role !== 'OWNER') throw new ForbiddenException('Only the owner can invite administrators');
    const token = newToken();
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${id}::uuid FOR UPDATE`;
      const subscription = await tx.subscription.findUniqueOrThrow({ where: { organizationId: id }, include: { plan: { include: { entitlements: true } } } });
      if (!hasActiveEntitlement(subscription)) throw new ForbiddenException('An active subscription or grace period is required');
      const seats = await tx.membership.count({ where: { organizationId: id } });
      const invited = await tx.invitation.count({ where: { organizationId: id, acceptedAt: null, expiresAt: { gt: new Date() } } });
      if (seats + invited >= planLimit(subscription.plan, 'seatLimit')) throw new ForbiddenException('Your plan seat limit has been reached');
      await tx.invitation.create({ data: { organizationId: id, email: data.email, role: data.role, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 7 * 24 * 3600_000) } });
      await this.mail.enqueue(tx, data.email, 'Join your team on RivalScope', `Accept the invitation: ${env.APP_ORIGIN}/?invite=${token}\nSign in with ${data.email}. This invitation expires in seven days.`);
      await tx.auditLog.create({ data: { organizationId: id, actorId: req.actor.id, action: 'team.invited' } });
    });
    return { message: 'Invitation queued for delivery' };
  }
  @Post('invitations/accept') async accept(@Req() req: ActorRequest, @Body() input: unknown) {
    if (!req.actor.verified) throw new ForbiddenException('Verify your email first');
    const { token } = z.object({ token: z.string().min(40).max(100) }).strict().parse(input);
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.actor.id}::uuid FOR UPDATE`;
      const account = await tx.user.findUniqueOrThrow({ where: { id: req.actor.id } }); if (account.deletedAt) throw new ForbiddenException('Account is unavailable');
      const invite = await tx.invitation.findUnique({ where: { tokenHash: hashToken(token) } });
      if (!invite || invite.email !== req.actor.email || invite.acceptedAt || invite.expiresAt <= new Date()) throw new ForbiddenException('Invitation is invalid or expired');
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${invite.organizationId}::uuid FOR UPDATE`;
      const sub = await tx.subscription.findUniqueOrThrow({ where: { organizationId: invite.organizationId }, include: { plan: { include: { entitlements: true } } } });
      if (!hasActiveEntitlement(sub)) throw new ForbiddenException('Workspace subscription does not permit new members');
      if (await tx.membership.count({ where: { organizationId: invite.organizationId } }) >= planLimit(sub.plan, 'seatLimit')) throw new ForbiddenException('Workspace seat limit reached');
      const used = await tx.invitation.updateMany({ where: { id: invite.id, acceptedAt: null }, data: { acceptedAt: new Date() } });
      if (!used.count) throw new ForbiddenException('Invitation already accepted');
      return tx.membership.upsert({ where: { organizationId_userId: { organizationId: invite.organizationId, userId: req.actor.id } }, create: { organizationId: invite.organizationId, userId: req.actor.id, role: invite.role }, update: {} });
    });
  }
  @Patch(':id/team/:memberId') async changeRole(@Req() req: ActorRequest, @Param('id') id: string, @Param('memberId') memberId: string, @Body() input: unknown) {
    const actor = await this.policy.authorize(req.actor.id, uuid(id), 'team');
    const { role } = z.object({ role: inviteRoles }).strict().parse(input);
    const member = await this.db.membership.findFirst({ where: { id: uuid(memberId), organizationId: id } });
    if (!member) throw new NotFoundException();
    if (member.role === 'OWNER' || member.userId === req.actor.id || (actor.role !== 'OWNER' && (member.role === 'ADMIN' || role === 'ADMIN'))) throw new ForbiddenException('Only the owner can manage administrators; owners cannot be demoted');
    return this.db.$transaction(async tx => {
      const result = await tx.membership.update({ where: { id: memberId }, data: { role } });
      await tx.auditLog.create({ data: { organizationId: id, actorId: req.actor.id, action: 'team.role_changed', resourceId: memberId } }); return result;
    });
  }
  @Delete(':id/team/:memberId') async remove(@Req() req: ActorRequest, @Param('id') id: string, @Param('memberId') memberId: string) {
    const actor = await this.policy.authorize(req.actor.id, uuid(id), 'team');
    const member = await this.db.membership.findFirst({ where: { id: uuid(memberId), organizationId: id } });
    if (!member) throw new NotFoundException();
    if (member.role === 'OWNER' || (actor.role !== 'OWNER' && member.role === 'ADMIN')) throw new ForbiddenException('Cannot remove this member');
    await this.db.$transaction([this.db.membership.delete({ where: { id: memberId } }), this.db.auditLog.create({ data: { organizationId: id, actorId: req.actor.id, action: 'team.removed', resourceId: memberId } })]); return { message: 'Member removed' };
  }
  @Get(':id/audit') async audit(@Req() req: ActorRequest, @Param('id') id: string) { await this.policy.authorize(req.actor.id, uuid(id), 'team'); return this.db.auditLog.findMany({ where: { organizationId: id }, orderBy: { createdAt: 'desc' }, take: 100 }); }
  @Get(':id/usage') async usage(@Req() req: ActorRequest, @Param('id') id: string) { await this.policy.authorize(req.actor.id, uuid(id), 'billing'); return this.db.creditLedger.findMany({ where: { organizationId: id }, orderBy: { createdAt: 'desc' }, take: 100 }); }
  @Get(':id/notifications') async notifications(@Req() req: ActorRequest, @Param('id') id: string) { await this.policy.authorize(req.actor.id, uuid(id)); const notifications = await this.db.notification.findMany({ where: { organizationId: id }, include: { reads: { where: { userId: req.actor.id } } }, orderBy: { createdAt: 'desc' }, take: 100 }); return notifications.map(({ reads, ...notification }) => ({ ...notification, readAt: reads[0]?.readAt ?? null })); }
  @Post(':id/notifications/:notificationId/read') async readNotification(@Req() req: ActorRequest, @Param('id') id: string, @Param('notificationId') notificationId: string) { await this.policy.authorize(req.actor.id, uuid(id)); await this.db.notification.findFirstOrThrow({ where: { id: uuid(notificationId), organizationId: id } }); return this.db.notificationRead.upsert({ where: { notificationId_userId: { notificationId, userId: req.actor.id } }, create: { organizationId: id, notificationId, userId: req.actor.id }, update: { readAt: new Date() } }); }
}
