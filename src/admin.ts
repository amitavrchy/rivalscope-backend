import { Body, Controller, ForbiddenException, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Database } from './database.js';
import { SessionGuard } from './security.js';
import type { ActorRequest } from './security.js';
import { uuid } from './organizations.js';
import { lockOrganization } from './credits.js';
import { ResearchService } from './research.js';
import { MonitoringService } from './monitoring.js';
import { randomUUID } from 'node:crypto';
import { AccountSecurityService, reauthentication } from './account-security.js';

@Controller('admin')
@UseGuards(SessionGuard)
export class AdminController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(ResearchService) private readonly research: ResearchService, @Inject(MonitoringService) private readonly monitoring: MonitoringService, @Inject(AccountSecurityService) private readonly security: AccountSecurityService) {}
  private check(req: ActorRequest) { if (!req.actor.platformAdmin || !req.actor.verified) throw new ForbiddenException('Verified platform administrator access required'); }
  @Get('overview') async overview(@Req() req: ActorRequest) {
    this.check(req);
    const [organizations, users, runs, recentAudit, researchQueue, monitorQueue] = await Promise.all([this.db.organization.count(), this.db.user.count(), this.db.researchRun.groupBy({ by: ['status'], _count: { id: true }, _sum: { providerTokens: true, consumedCredits: true } }), this.db.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 30, select: { id: true, action: true, createdAt: true } }), this.research.queue.getJobCounts('active', 'waiting', 'failed', 'completed'), this.monitoring.queue.getJobCounts('active', 'waiting', 'failed')]);
    return { organizations, users, runs: runs.map(r => ({ status: r.status, count: r._count.id, tokens: r._sum.providerTokens, credits: r._sum.consumedCredits })), recentAudit, queues: { research: researchQueue, monitoring: monitorQueue } };
  }
  @Get('organizations') async organizations(@Req() req: ActorRequest) { this.check(req); return this.db.organization.findMany({ take: 100, select: { id: true, name: true, credits: true, reservedCredits: true, createdAt: true, subscription: { select: { planId: true, status: true } } } }); }
  @Get('users') async users(@Req() req: ActorRequest) { this.check(req); return this.db.user.findMany({ where: { deletedAt: null }, take: 100, select: { id: true, name: true, email: true, emailVerifiedAt: true, platformAdmin: true, createdAt: true, _count: { select: { memberships: true, sessions: true } } } }); }
  @Post('users/:id/revoke-sessions') async revokeSessions(@Req() req: ActorRequest, @Param('id') id: string) {
    this.check(req); uuid(id);
    await this.db.$transaction([this.db.session.deleteMany({ where: { userId: id } }), this.db.platformAuditLog.create({ data: { actorId: req.actor.id, action: 'user.sessions_revoked', resourceId: id } })]); return { message: 'User sessions revoked' };
  }
  @Patch('users/:id/platform-role') async platformRole(@Req() req: ActorRequest, @Param('id') id: string, @Body() input: unknown) {
    this.check(req); uuid(id); const data = reauthentication.extend({ platformAdmin: z.boolean() }).strict().parse(input); await this.security.reauthenticate(req.actor.id, data);
    if (id === req.actor.id) throw new ForbiddenException('Ask another administrator to change your platform role');
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(915600679)`;
      const actor = await tx.user.findUniqueOrThrow({ where: { id: req.actor.id } }); if (!actor.platformAdmin || actor.deletedAt) throw new ForbiddenException('Platform administrator access has changed');
      const user = await tx.user.findUniqueOrThrow({ where: { id } }); if (!user.emailVerifiedAt || user.deletedAt) throw new ForbiddenException('Choose an active verified user');
      if (!data.platformAdmin && user.platformAdmin && await tx.user.count({ where: { platformAdmin: true, deletedAt: null } }) <= 1) throw new ForbiddenException('Cannot revoke the final platform administrator');
      await tx.user.update({ where: { id }, data: { platformAdmin: data.platformAdmin } }); await tx.platformAuditLog.create({ data: { actorId: req.actor.id, action: 'user.platform_role_changed', resourceId: id, details: { platformAdmin: data.platformAdmin } } });
    }); return { message: 'Platform role updated' };
  }
  @Get('plans') async plans(@Req() req: ActorRequest) { this.check(req); return this.db.plan.findMany({ orderBy: { monthlyPriceCents: 'asc' } }); }
  @Get('credit-packs') async packs(@Req() req: ActorRequest) { this.check(req); return this.db.creditPack.findMany({ orderBy: { amountCents: 'asc' } }); }
  @Patch('credit-packs/:id') async pack(@Req() req: ActorRequest, @Param('id') id: string, @Body() input: unknown) {
    this.check(req); z.string().min(1).max(80).regex(/^[a-z0-9-]+$/).parse(id);
    const data = z.object({ name: z.string().min(2).max(100), credits: z.number().int().min(1).max(1000000), amountCents: z.number().int().min(1).max(100000000), currency: z.string().regex(/^[a-z]{3}$/), stripePriceId: z.string().startsWith('price_').nullable().optional(), enabled: z.boolean() }).strict().parse(input);
    return this.db.$transaction(async tx => { const result = await tx.creditPack.upsert({ where: { id }, create: { id, ...data }, update: data }); await tx.platformAuditLog.create({ data: { actorId: req.actor.id, action: 'credit_pack.updated', resourceId: id, details: data } }); return result; });
  }
  @Get('subscriptions') async subscriptions(@Req() req: ActorRequest) { this.check(req); return this.db.subscription.findMany({ take: 100, include: { organization: { select: { id: true, name: true } }, plan: { include: { entitlements: true } } }, orderBy: { updatedAt: 'desc' } }); }
  @Get('jobs') async jobs(@Req() req: ActorRequest) { this.check(req); return this.db.researchRun.findMany({ take: 100, orderBy: { createdAt: 'desc' }, select: { id: true, organizationId: true, projectId: true, status: true, createdAt: true, error: true, consumedCredits: true, providerTokens: true, stages: { select: { name: true, status: true, attempts: true, error: true } } } }); }
  @Post('jobs/:id/cancel') async cancelJob(@Req() req: ActorRequest, @Param('id') id: string) {
    this.check(req); const run = await this.db.researchRun.findUniqueOrThrow({ where: { id: uuid(id) } });
    await this.db.$transaction([this.db.researchRun.updateMany({ where: { id, status: { in: ['QUEUED', 'RUNNING'] } }, data: { cancelRequested: true } }), this.db.auditLog.create({ data: { organizationId: run.organizationId, actorId: req.actor.id, action: 'platform.research_cancel_requested', resourceId: id } })]); return { message: 'Cancellation requested' };
  }
  @Post('jobs/:id/retry') async retryJob(@Req() req: ActorRequest, @Param('id') id: string) {
    this.check(req); const run = await this.db.researchRun.findUniqueOrThrow({ where: { id: uuid(id) } });
    if (!['FAILED', 'CANCELLED'].includes(run.status)) throw new ForbiddenException('Only failed or cancelled runs can be restarted');
    const options = run.options as Record<string, unknown>;
    return this.research.create(run.organizationId, run.projectId, req.actor.id, { ...options, idempotencyKey: randomUUID() });
  }
  @Get('provider-usage') async providers(@Req() req: ActorRequest) { this.check(req); const records = await this.db.providerUsage.findMany({ take: 200, orderBy: { createdAt: 'desc' } }); return records.map(r => ({ ...r, estimatedCostMicros: r.estimatedCostMicros?.toString() ?? null })); }
  @Get('audit') async audit(@Req() req: ActorRequest) { this.check(req); const [workspace, platform] = await Promise.all([this.db.auditLog.findMany({ take: 100, orderBy: { createdAt: 'desc' } }), this.db.platformAuditLog.findMany({ take: 100, orderBy: { createdAt: 'desc' } })]); return { workspace, platform }; }
  @Get('flags') async flags(@Req() req: ActorRequest) { this.check(req); return this.db.featureFlag.findMany(); }
  @Patch('flags/:id') async flag(@Req() req: ActorRequest, @Param('id') id: string, @Body() input: unknown) {
    this.check(req); z.enum(['research', 'monitoring', 'copilot', 'public_sharing']).parse(id); const data = z.object({ enabled: z.boolean(), description: z.string().min(3).max(300) }).strict().parse(input);
    return this.db.$transaction(async tx => { const flag = await tx.featureFlag.upsert({ where: { id }, create: { id, ...data }, update: data }); await tx.platformAuditLog.create({ data: { actorId: req.actor.id, action: 'feature_flag.updated', resourceId: id, details: data } }); return flag; });
  }
  @Get('settings') async settings(@Req() req: ActorRequest) { this.check(req); return this.db.systemSetting.findMany(); }
  @Patch('settings/:id') async setting(@Req() req: ActorRequest, @Param('id') id: string, @Body() input: unknown) {
    this.check(req); z.enum(['announcement', 'support_email', 'research_daily_token_limit']).parse(id);
    const { value } = z.object({ value: z.union([z.string().max(1000), z.number().int().min(1000).max(10000000)]) }).strict().parse(input);
    if (id === 'research_daily_token_limit' && typeof value !== 'number') throw new ForbiddenException('Token limit must be a number');
    if (id !== 'research_daily_token_limit' && typeof value !== 'string') throw new ForbiddenException('This setting must be text');
    return this.db.$transaction(async tx => { const result = await tx.systemSetting.upsert({ where: { id }, create: { id, value }, update: { value } }); await tx.platformAuditLog.create({ data: { actorId: req.actor.id, action: 'system_setting.updated', resourceId: id, details: { value } } }); return result; });
  }
  @Post('organizations/:id/credits') async adjust(@Req() req: ActorRequest, @Param('id') id: string, @Body() input: unknown) {
    this.check(req); uuid(id); const { amount, reason } = z.object({ amount: z.number().int().min(-100000).max(100000).refine(v => v !== 0), reason: z.string().trim().min(10).max(300) }).strict().parse(input);
    return this.db.$transaction(async tx => {
      const org = await lockOrganization(tx, id); if (org.credits + amount < org.reservedCredits) throw new ForbiddenException('Adjustment would spend reserved credits');
      await tx.organization.update({ where: { id }, data: { credits: { increment: amount } } });
      await tx.creditLedger.create({ data: { organizationId: id, idempotencyKey: `adjust-${randomUUID()}`, kind: 'ADJUST', amount, balanceAfter: org.credits + amount } });
      await tx.auditLog.create({ data: { organizationId: id, actorId: req.actor.id, action: `credits.adjusted: ${reason}`, resourceId: id } }); return { message: 'Credit balance adjusted' };
    });
  }
  @Patch('plans/:id') async plan(@Req() req: ActorRequest, @Param('id') id: string, @Body() input: unknown) {
    this.check(req);
    const data = z.object({ monthlyPriceCents: z.number().int().min(0).optional(), annualPriceCents: z.number().int().min(0).optional(), monthlyCredits: z.number().int().min(0).max(1000000).optional(), projectLimit: z.number().int().min(1).max(10000).optional(), seatLimit: z.number().int().min(1).max(10000).optional(), monitorLimit: z.number().int().min(0).max(10000).optional(), stripeMonthlyPriceId: z.string().startsWith('price_').optional(), stripeAnnualPriceId: z.string().startsWith('price_').optional(), enabled: z.boolean().optional(), trialDays: z.number().int().min(0).max(30).optional() }).strict().parse(input);
    return this.db.$transaction(async tx => {
      const result = await tx.plan.update({ where: { id }, data });
      for (const key of ['monthlyCredits','projectLimit','seatLimit','monitorLimit'] as const) if (data[key] !== undefined) await tx.entitlement.upsert({where:{planId_key:{planId:id,key}},create:{planId:id,key,value:data[key]},update:{value:data[key]}});
      await tx.platformAuditLog.create({ data: { actorId: req.actor.id, action: 'platform.plan_updated', resourceId: id, details: data } }); return result;
    });
  }
}
