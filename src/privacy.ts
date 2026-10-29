import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import { Database } from './database.js';
import { SessionGuard, TenantPolicy, cookieOptions, SESSION_COOKIE, newToken } from './security.js';
import type { ActorRequest } from './security.js';
import { AccountSecurityService, reauthentication } from './account-security.js';
import { BillingService } from './billing.js';

@Controller('privacy')
@UseGuards(SessionGuard)
export class PrivacyController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(TenantPolicy) private readonly policy: TenantPolicy, @Inject(AccountSecurityService) private readonly security: AccountSecurityService, @Inject(BillingService) private readonly billing: BillingService) {}
  @Get('account/export') async accountExport(@Req() req: ActorRequest, @Res() res: Response) {
    const data = await this.db.user.findUniqueOrThrow({ where: { id: req.actor.id }, select: { id: true, name: true, email: true, createdAt: true, emailVerifiedAt: true, memberships: { select: { role: true, organization: { select: { id: true, name: true } } } }, sessions: { select: { id: true, label: true, createdAt: true, expiresAt: true } }, bookmarks: true, oauthAccounts: { select: { provider: true, createdAt: true } } } });
    return res.setHeader('Cache-Control', 'no-store').attachment('rivalscope-account.json').json({ exportedAt: new Date(), account: data });
  }
  @Post('account/delete') async deleteAccount(@Req() req: ActorRequest, @Body() input: unknown, @Res({ passthrough: true }) res: Response) {
    const data = reauthentication.extend({ confirmation: z.literal('DELETE MY ACCOUNT') }).strict().parse(input); await this.security.reauthenticate(req.actor.id, data);
    const passwordHash = await argon2.hash(newToken());
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.actor.id}::uuid FOR UPDATE`;
      if (await tx.membership.count({ where: { userId: req.actor.id, role: 'OWNER', organization: { deletedAt: null } } })) throw new ForbiddenException('Transfer ownership or delete every owned workspace before deleting your account');
      const memberships = await tx.membership.findMany({ where: { userId: req.actor.id } });
      for (const membership of memberships) await tx.auditLog.create({ data: { organizationId: membership.organizationId, actorId: req.actor.id, action: 'account.deleted' } });
      await tx.session.deleteMany({ where: { userId: req.actor.id } }); await tx.verificationToken.deleteMany({ where: { userId: req.actor.id } });
      await tx.loginChallenge.deleteMany({ where: { userId: req.actor.id } }); await tx.mFAFactor.deleteMany({ where: { userId: req.actor.id } });
      await tx.recoveryCode.deleteMany({ where: { userId: req.actor.id } }); await tx.oAuthAccount.deleteMany({ where: { userId: req.actor.id } });
      await tx.notificationRead.deleteMany({ where: { userId: req.actor.id } }); await tx.notificationPreference.deleteMany({ where: { userId: req.actor.id } });
      await tx.emailDelivery.deleteMany({ where: { recipient: req.actor.email } }); await tx.membership.deleteMany({ where: { userId: req.actor.id } });
      await tx.comment.deleteMany({ where: { authorId: req.actor.id } });
      await tx.bookmark.deleteMany({ where: { userId: req.actor.id } }); await tx.projectMember.deleteMany({ where: { userId: req.actor.id } });
      await tx.oAuthState.deleteMany({ where: { linkUserId: req.actor.id } });
      await tx.user.update({ where: { id: req.actor.id }, data: { name: 'Deleted account', email: `deleted-${req.actor.id}@removed.invalid`, passwordHash, deletedAt: new Date(), platformAdmin: false } });
    });
    res.clearCookie(SESSION_COOKIE, cookieOptions); return { message: 'Account personal data removed; required pseudonymous accounting/audit references retained' };
  }
  @Get('organizations/:id/export') async organizationExport(@Req() req: ActorRequest, @Param('id') id: string, @Res() res: Response) {
    await this.policy.authorize(req.actor.id, z.uuid().parse(id), 'owner');
    const data = await this.db.organization.findUniqueOrThrow({ where: { id }, select: { id: true, name: true, slug: true, industry: true, website: true, timezone: true, createdAt: true, credits: true, reservedCredits: true, subscription: { include: { plan: { include: { entitlements: true } } } }, memberships: { select: { role: true, user: { select: { name: true, email: true } } } }, ledger: true, invoices: true, creditPurchases: true, audit: true, projects: { include: { competitors: { include: { products: true, features: { include: { feature: true } }, pricing: { include: { history: true } } } }, members: true, sources: true, findings: { include: { evidence: true } }, reports: true, comments: true, monitors: { include: { runs: true, changes: true, snapshots: true } }, threads: { include: { messages: true } }, runs: { include: { stages: true } } } } } });
    return res.setHeader('Cache-Control', 'no-store').attachment('rivalscope-workspace.json').json({ exportedAt: new Date(), workspace: data });
  }
  @Post('organizations/:id/delete') async deleteOrganization(@Req() req: ActorRequest, @Param('id') id: string, @Body() input: unknown) {
    await this.policy.authorize(req.actor.id, z.uuid().parse(id), 'owner');
    const data = reauthentication.extend({ confirmation: z.literal('DELETE THIS WORKSPACE') }).strict().parse(input); await this.security.reauthenticate(req.actor.id, data);
    if (await this.db.researchRun.count({ where: { organizationId: id, status: { in: ['QUEUED', 'RUNNING'] } } })) throw new ForbiddenException('Cancel active research and wait for it to finish before deleting this workspace');
    const sub = await this.db.subscription.findUnique({ where: { organizationId: id } });
    if (sub?.stripeSubscriptionId && sub.status !== 'canceled') await this.billing.stripe().subscriptions.cancel(sub.stripeSubscriptionId);
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${id}::uuid FOR UPDATE`;
      if (await tx.researchRun.count({ where: { organizationId: id, status: { in: ['QUEUED', 'RUNNING'] } } })) throw new ForbiddenException('Research is still active');
      await tx.auditLog.create({ data: { organizationId: id, actorId: req.actor.id, action: 'organization.deleted' } });
      await tx.comparison.deleteMany({ where: { organizationId: id } });
      await tx.project.deleteMany({ where: { organizationId: id } }); await tx.feature.deleteMany({ where: { organizationId: id } }); await tx.membership.deleteMany({ where: { organizationId: id } });
      await tx.invitation.deleteMany({ where: { organizationId: id } }); await tx.integration.deleteMany({ where: { organizationId: id } });
      await tx.notification.deleteMany({ where: { organizationId: id } }); await tx.webhookEndpoint.deleteMany({ where: { organizationId: id } });
      await tx.notificationPreference.deleteMany({ where: { organizationId: id } });
      await tx.apiKey.deleteMany({ where: { organizationId: id } });
      await tx.subscription.updateMany({ where: { organizationId: id }, data: { status: 'canceled' } });
      await tx.organization.update({ where: { id }, data: { name: 'Deleted workspace', industry: null, website: null, deletedAt: new Date() } });
    }); return { message: 'Workspace research and access removed. Pseudonymous billing/accounting/audit records are retained.' };
  }
}
