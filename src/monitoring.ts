import { AlertService } from './alert-rules.js';
import { hasActiveEntitlement, planLimit } from './entitlements.js';
import { Body, Controller, ForbiddenException, Get, Inject, Injectable, OnModuleDestroy, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Queue } from 'bullmq';
import { z } from 'zod';
import { Database } from './database.js';
import { SessionGuard, TenantPolicy } from './security.js';
import type { ActorRequest } from './security.js';
import { uuid } from './organizations.js';
import { redisConnection } from './config.js';
import { extractWebsite } from './safe-http.js';
import { sourceUrl } from './research-schemas.js';
import { lockOrganization } from './credits.js';
import { WebhookService } from './integrations.js';

export const MONITOR_QUEUE = 'rivalscope-monitoring';
@Injectable()
export class MonitoringService implements OnModuleDestroy {
  readonly queue = new Queue(MONITOR_QUEUE, { connection: redisConnection(), defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 10_000, jitter: 0.3 }, removeOnComplete: { count: 1000 }, removeOnFail: { count: 1000 } } });
  constructor(@Inject(Database) private readonly db: Database, @Inject(WebhookService) private readonly webhooks: WebhookService, @Inject(AlertService) private readonly alerts: AlertService) {}
  async onModuleDestroy() { await this.queue.close(); }
  async reconcile() {
    const flag = await this.db.featureFlag.findUnique({ where: { id: 'monitoring' } });
    const monitors = await this.db.monitor.findMany({ take: 5000, include: { project: { include: { organization: { include: { subscription: { include: { plan: { include: { entitlements: true } } } } } } } } }, orderBy: { createdAt: 'asc' } });
    const counts = new Map<string, number>();
    for (const monitor of monitors) {
      const sub = monitor.project.organization.subscription;
      const count = (counts.get(monitor.organizationId) ?? 0) + (monitor.enabled && !monitor.project.deletedAt ? 1 : 0); counts.set(monitor.organizationId, count);
      if (flag && !flag.enabled || !monitor.enabled || monitor.project.deletedAt || !sub || !hasActiveEntitlement(sub) || count > planLimit(sub.plan, 'monitorLimit')) {
        await this.queue.removeJobScheduler(monitor.id); continue;
      }
      await this.queue.upsertJobScheduler(monitor.id, { every: monitor.everyHours * 3600_000 }, { name: 'check', data: { monitorId: monitor.id } });
    }
  }
  async execute(monitorId: string) {
    const flag = await this.db.featureFlag.findUnique({ where: { id: 'monitoring' } }); if (flag && !flag.enabled) return;
    const monitor = await this.db.monitor.findUnique({ where: { id: monitorId }, include: { project: { include: { organization: { include: { subscription: true } } } } } });
    if (!monitor?.enabled || monitor.project.deletedAt) return;
    const org = monitor.project.organization;
    if (!org.subscription || !hasActiveEntitlement(org.subscription) || org.credits - org.reservedCredits < 1) { await this.queue.removeJobScheduler(monitorId); return; }
    try {
      const source = await extractWebsite(monitor.url);
      await this.db.$transaction(async tx => {
        const org = await lockOrganization(tx, monitor.organizationId);
        if (org.credits - org.reservedCredits < 1) return;
        const sub = await tx.subscription.findUnique({ where: { organizationId: org.id }, include: { plan: { include: { entitlements: true } } } });
        if (!hasActiveEntitlement(sub) || !sub) return;
        const eligible = await tx.monitor.findMany({ where: { organizationId: org.id, enabled: true, project: { deletedAt: null } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: planLimit(sub.plan, 'monitorLimit'), select: { id: true } });
        if (!eligible.some(m => m.id === monitorId)) return;
        const current = await tx.monitor.findUniqueOrThrow({ where: { id: monitorId } });
        if (!current.enabled) return;
        const run = await tx.monitorRun.create({ data: { organizationId: monitor.organizationId, monitorId, contentHash: source.contentHash } });
        await tx.sourceSnapshot.create({ data: { organizationId: monitor.organizationId, monitorId, monitorRunId: run.id, url: source.url, contentHash: source.contentHash, text: source.text } });
        if (current.lastHash && current.lastHash !== source.contentHash) {
          const existing = await tx.changeEvent.findUnique({ where: { organizationId_monitorId_previousHash_currentHash: { organizationId: monitor.organizationId, monitorId, previousHash: current.lastHash, currentHash: source.contentHash } } });
          if (!existing) {
            const change = await tx.changeEvent.create({ data: { organizationId: monitor.organizationId, monitorId, previousHash: current.lastHash, currentHash: source.contentHash, previousText: current.lastText ?? '', currentText: source.text } });
            await tx.notification.create({ data: { organizationId: monitor.organizationId, title: 'Competitor website changed', body: `Public page content changed: ${monitor.url}. Review the snapshot comparison before drawing conclusions.` } });
            await this.alerts.evaluate(tx, monitor.organizationId, monitorId, change, monitor.url);
            await this.webhooks.emit(tx, monitor.organizationId, 'monitor.changed', change.id, { monitorId, changeId: change.id, url: monitor.url });
          }
        }
        await tx.monitor.update({ where: { id: monitorId }, data: { lastHash: source.contentHash, lastText: source.text, lastCheckedAt: new Date() } });
        await tx.organization.update({ where: { id: org.id }, data: { credits: { decrement: 1 } } });
        const ledger = await tx.creditLedger.create({ data: { organizationId: org.id, idempotencyKey: `monitor-${run.id}`, kind: 'CONSUME', amount: -1, balanceAfter: org.credits - 1, referenceId: monitorId } });
        await tx.usageEvent.create({ data: { organizationId: org.id, ledgerId: ledger.id, category: 'MONITORING', units: 1, referenceId: monitorId } });
      });
    } catch (error) {
      await this.db.monitorRun.create({ data: { organizationId: monitor.organizationId, monitorId, error: error instanceof Error ? error.message.slice(0, 300) : 'Monitor extraction failed' } });
      throw new Error('Monitoring failed; see monitor run history');
    }
  }
}

@Controller('organizations/:orgId/monitors')
@UseGuards(SessionGuard)
export class MonitoringController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(TenantPolicy) private readonly policy: TenantPolicy, @Inject(MonitoringService) private readonly monitoring: MonitoringService) {}
  @Get() async list(@Req() req: ActorRequest, @Param('orgId') orgId: string) { await this.policy.authorize(req.actor.id, uuid(orgId)); return this.db.monitor.findMany({ where: { organizationId: orgId, project: { deletedAt: null } }, include: { runs: { orderBy: { createdAt: 'desc' }, take: 10 }, changes: { orderBy: { createdAt: 'desc' }, take: 5 } }, take: 100 }); }
  @Post() async create(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Body() input: unknown) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'research'); if (!req.actor.verified) throw new ForbiddenException('Verify your email first');
    const data = z.object({ projectId: z.uuid(), url: sourceUrl, everyHours: z.number().int().min(6).max(168).default(24) }).strict().parse(input);
    const monitor = await this.db.$transaction(async tx => {
      await lockOrganization(tx, orgId);
      await tx.project.findFirstOrThrow({ where: { id: data.projectId, organizationId: orgId, deletedAt: null } });
      const sub = await tx.subscription.findUniqueOrThrow({ where: { organizationId: orgId }, include: { plan: { include: { entitlements: true } } } });
      if (!hasActiveEntitlement(sub)) throw new ForbiddenException('An active subscription is required');
      if (await tx.monitor.count({ where: { organizationId: orgId, enabled: true } }) >= planLimit(sub.plan, 'monitorLimit')) throw new ForbiddenException('Your monitoring limit has been reached');
      return tx.monitor.create({ data: { organizationId: orgId, ...data } });
    });
    // Worker reconciliation schedules the durable record, avoiding API/Redis dual writes.
    return monitor;
  }
  @Patch(':id') async update(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string, @Body() input: unknown) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'research');
    const data = z.object({ enabled: z.boolean(), everyHours: z.number().int().min(6).max(168).optional() }).strict().parse(input);
    await this.db.$transaction(async tx => {
      await lockOrganization(tx, orgId);
      const monitor = await tx.monitor.findFirstOrThrow({ where: { id: uuid(id), organizationId: orgId, project: { deletedAt: null } } });
      if (data.enabled && !monitor.enabled) {
        const sub = await tx.subscription.findUniqueOrThrow({ where: { organizationId: orgId }, include: { plan: { include: { entitlements: true } } } });
        if (!hasActiveEntitlement(sub)) throw new ForbiddenException('An active subscription or grace period is required');
        if (await tx.monitor.count({ where: { organizationId: orgId, enabled: true, project: { deletedAt: null } } }) >= planLimit(sub.plan, 'monitorLimit')) throw new ForbiddenException('Your monitoring limit has been reached');
      }
      await tx.monitor.update({ where: { id: monitor.id }, data });
      await tx.auditLog.create({ data: { organizationId: orgId, actorId: req.actor.id, action: data.enabled ? 'monitor.enabled' : 'monitor.paused', resourceId: monitor.id } });
    }); return { message: 'Monitor updated; schedules synchronize within one minute' };
  }
}
