import { hasActiveEntitlement } from './entitlements.js';
import { Body, Controller, ForbiddenException, Get, Header, Inject, Injectable, NotFoundException, OnModuleDestroy, Param, Post, Req, Sse, UseGuards } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Observable } from 'rxjs';
import { z } from 'zod';
import { Database } from './database.js';
import { CreditsService } from './credits.js';
import { SessionGuard, TenantPolicy } from './security.js';
import type { ActorRequest } from './security.js';
import { uuid } from './organizations.js';
import { redisConnection } from './config.js';
import { AiService, SearchService, PROMPT_VERSION } from './providers.js';
import { SourceCollector } from './source-collector.js';
import { analysisSchema, estimateCredits, extractionSchema, isolationPrompt, planSchema, researchOptions, searchOutputSchema, validateEvidence } from './research-schemas.js';
import type { Prisma } from './generated/prisma/client.js';
import { WebhookService } from './integrations.js';
import { catalogSchema, verificationSchema, validateCatalog, IntelligenceService } from './intelligence.js';

export const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export const QUEUE_NAME = 'rivalscope-research';

@Injectable()
export class ResearchService implements OnModuleDestroy {
  readonly queue = new Queue(QUEUE_NAME, { connection: redisConnection(), defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000, jitter: 0.3 }, removeOnComplete: { age: 7 * 86400 }, removeOnFail: { age: 30 * 86400 } } });
  constructor(@Inject(Database) private readonly db: Database, @Inject(CreditsService) private readonly credits: CreditsService, @Inject(AiService) private readonly ai: AiService, @Inject(SearchService) private readonly search: SearchService, @Inject(WebhookService) private readonly webhooks: WebhookService, @Inject(IntelligenceService) private readonly intelligence: IntelligenceService, @Inject(SourceCollector) private readonly collector: SourceCollector) {}
  async onModuleDestroy() { await this.queue.close(); }
  async enqueue(runId: string) { await this.queue.add('research', { runId }, { jobId: runId }); }
  async reconcile() {
    const pending = await this.db.researchRun.findMany({ where: { status: { in: ['QUEUED', 'RUNNING'] } }, take: 100, orderBy: { createdAt: 'asc' } });
    for (const run of pending) {
      const job = await this.queue.getJob(run.id);
      // Redis loss after a worker crash must not strand a database run or its reservation.
      if (!job) await this.enqueue(run.id);
      else if (await job.getState() === 'failed') {
        const options = researchOptions.parse(run.options); const stages = await this.db.researchStage.findMany({ where: { runId: run.id, organizationId: run.organizationId, status: 'COMPLETED' } });
        const costs: Record<string, number> = { plan: 5, search: options.discover ? 3 : 0, extract: options.depth === 'deep' ? 12 : 6, analyze: 5, catalog: 2, verify: 2, report: 1 };
        await this.db.$transaction(async tx => {
          await this.credits.settle(tx, run.organizationId, run.id, stages.reduce((total, stage) => total + (costs[stage.name] ?? 0), 0));
          await tx.researchRun.update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: new Date(), error: 'Queue retry budget exhausted; unused credits released. An administrator can restart this as a new run.' } });
          await tx.researchStage.updateMany({ where: { runId: run.id, status: { in: ['QUEUED','RUNNING'] } }, data: { status: 'FAILED', finishedAt: new Date() } });
        });
      }
    }
  }
  async create(organizationId: string, projectId: string, actorId: string, input: unknown) {
    const { idempotencyKey, ...raw } = z.object({ ...researchOptions.shape, idempotencyKey: z.string().min(8).max(100).regex(/^[a-zA-Z0-9-]+$/) }).strict().parse(input);
    const options = researchOptions.parse(raw);
    const existing = await this.db.researchRun.findUnique({ where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } } });
    if (existing) { if (existing.projectId !== projectId || !isDeepStrictEqual(existing.options, json(options))) throw new ForbiddenException('Idempotency key already belongs to a different request'); return existing; }
    const flag = await this.db.featureFlag.findUnique({ where: { id: 'research' } }); if (flag && !flag.enabled) throw new ForbiddenException('Research is temporarily disabled by the operator');
    this.ai.assertConfigured(); if (options.discover) this.search.assertConfigured();
    if (!options.discover && options.sourceUrls.length === 0) throw new ForbiddenException('Provide public source URLs or enable web discovery');
    const run = await this.db.$transaction(async tx => {
      const project = await tx.project.findFirst({ where: { id: projectId, organizationId, deletedAt: null } });
      if (!project) throw new NotFoundException('Project not found');
      const sub = await tx.subscription.findUniqueOrThrow({ where: { organizationId }, include: { plan: { include: { entitlements: true } } } });
      if (!hasActiveEntitlement(sub)) throw new ForbiddenException('Your subscription does not permit new research');
      const runId = randomUUID(); const amount = estimateCredits(options);
      await this.credits.reserve(tx, organizationId, runId, amount);
      const active = await tx.researchRun.count({ where: { organizationId, status: { in: ['QUEUED', 'RUNNING'] } } });
      if (active >= 3) throw new ForbiddenException('Only three research runs can be active per workspace');
      const created = await tx.researchRun.create({ data: { id: runId, organizationId, projectId, idempotencyKey, options: json(options), reservedCredits: amount, stages: { create: ['plan', 'search', 'extract', 'analyze', 'catalog', 'verify', 'report'].map(name => ({ name })) } } });
      await tx.auditLog.create({ data: { organizationId, actorId, action: 'research.started', resourceId: runId } }); return created;
    });
    // A durable QUEUED record is reconciled by the worker if Redis is temporarily unavailable.
    await this.enqueue(run.id).catch(() => process.stderr.write(JSON.stringify({ level: 'warn', event: 'queue_submit_deferred', runId: run.id }) + '\n'));
    return run;
  }
  async execute(runId: string) {
    const run = await this.db.researchRun.findUniqueOrThrow({ where: { id: runId }, include: { project: true } });
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) return;
    const organizationId = run.organizationId; const projectId = run.projectId; const options = researchOptions.parse(run.options);
    let consumed = 0;
    const started = Date.now();
    const checkCancelled = async () => {
      const current = await this.db.researchRun.findUniqueOrThrow({ where: { id: runId } });
      if (current.cancelRequested) throw new Error('Research cancelled');
      if (Date.now() - started > 15 * 60_000) throw new Error('Research time budget exceeded');
    };
    const checkpoint = async <T>(name: string, schema: z.ZodType<T>, units: number, fn: () => Promise<T>): Promise<T> => {
      await checkCancelled();
      const stage = await this.db.researchStage.upsert({ where: { organizationId_runId_name: { organizationId, runId, name } }, create: { organizationId, runId, name }, update: {} });
      if (stage.status === 'COMPLETED') { consumed += units; return schema.parse(stage.output); }
      for (let attempt = stage.attempts; attempt < 2; attempt++) {
        await checkCancelled();
        await this.db.researchStage.update({ where: { id: stage.id }, data: { status: 'RUNNING', attempts: { increment: 1 }, startedAt: new Date(), error: null } });
        try {
          const output = schema.parse(await fn());
          await checkCancelled();
          await this.db.researchStage.update({ where: { id: stage.id }, data: { status: 'COMPLETED', output: json(output), finishedAt: new Date() } });
          consumed += units; return output;
        } catch (error) {
          const message = error instanceof Error && !/key|token|password|credential|authorization/i.test(error.message) ? error.message.slice(0, 300) : 'Research stage failed';
          await this.db.researchStage.update({ where: { id: stage.id }, data: { status: 'FAILED', error: message, finishedAt: new Date() } });
          if (attempt === 1) throw new Error(`${name}: ${message}`);
        }
      }
      throw new Error(`${name}: retry budget exhausted`);
    };
    await this.db.researchRun.update({ where: { id: runId }, data: { status: 'RUNNING', startedAt: run.startedAt ?? new Date() } });
    try {
      const plan = await checkpoint('plan', planSchema, 5, async () => {
        const result = await this.ai.generate(planSchema, isolationPrompt, { task: 'Understand the business and generate at most three competitor/pricing/features search queries. Do not invent competitors.', business: { name: run.project.name, description: run.project.description, industry: run.project.industry, targetMarket: run.project.targetMarket }, options }, { organizationId, runId });
        await this.db.researchRun.update({ where: { id: runId }, data: { providerTokens: { increment: result.tokens } } }); return result.data;
      });
      const search = await checkpoint('search', searchOutputSchema, options.discover ? 3 : 0, async () => {
        const urls = [...options.sourceUrls];
        if (options.discover) for (const query of plan.queries) { await checkCancelled(); urls.push(...(await this.search.search(query, options.competitorCount)).map(r => r.url)); }
        return { urls: [...new Set(urls)].slice(0, options.depth === 'deep' ? 12 : 6) };
      });
      const extraction = await checkpoint('extract', extractionSchema, options.depth === 'deep' ? 12 : 6, async () => {
        const sourceIds: string[] = []; const failures: { url: string; reason: string }[] = [];
        for (const url of search.urls) {
          await checkCancelled();
          try {
            const existing = await this.db.source.findUnique({ where: { organizationId_runId_url: { organizationId, runId, url } } });
            if (existing) { sourceIds.push(existing.id); continue; }
            const source = await this.collector.extract(organizationId,url,options.sourceFreshness);
            const saved = await this.db.source.upsert({ where: { organizationId_runId_url: { organizationId, runId, url: source.url } }, create: { ...source, organizationId, projectId, runId }, update: {} }); sourceIds.push(saved.id);
          } catch (error) { failures.push({ url, reason: error instanceof Error ? error.message.slice(0, 300) : 'Source extraction failed' }); }
        }
        if (!sourceIds.length) throw new Error('No permitted public sources could be extracted. Supply canonical public URLs and inspect robots policies.');
        return { sourceIds, failures };
      });
      const sources = await this.db.source.findMany({ where: { organizationId, runId, id: { in: extraction.sourceIds } } });
      let analysis = await checkpoint('analyze', analysisSchema, 5, async () => {
        const result = await this.ai.generate(analysisSchema, isolationPrompt, { task: `Analyze at most ${options.competitorCount} competitors from the supplied evidence. Produce feature/pricing intelligence and SWOT/opportunities only where supported. Every quotation must be an exact substring of supplied source text. Use source IDs verbatim.`, plan, options, sources: sources.map(s => ({ id: s.id, url: s.url, title: s.title, text: s.text.slice(0, 12000) })) }, { organizationId, runId });
        await this.db.researchRun.update({ where: { id: runId }, data: { providerTokens: { increment: result.tokens } } });
        return validateEvidence(result.data, sources);
      });
      validateEvidence(analysis, sources);
      const catalog = await checkpoint('catalog', catalogSchema, 2, async () => {
        const result = await this.ai.generate(catalogSchema, isolationPrompt, { task: 'Extract a catalog of explicitly published products, named features and pricing plans from competitor-owned public pages. Return empty arrays for missing data. Amount must occur literally in the quoted text; never infer currency or billing interval. Each item must cite its competitor domain, exact source ID and exact quotation. Use only listed competitor domains.', competitors: analysis.competitors, sources: sources.map(s => ({ id: s.id, url: s.url, text: s.text.slice(0, 12000) })) }, { organizationId, runId });
        await this.db.researchRun.update({ where: { id: runId }, data: { providerTokens: { increment: result.tokens } } });
        return validateCatalog(result.data, sources, analysis.competitors.map(c => c.domain.toLowerCase()));
      });
      const verification = await checkpoint('verify', verificationSchema, 2, async () => {
        if (!analysis.findings.length) return { items: [] };
        const result = await this.ai.generate(verificationSchema, `${isolationPrompt} You are a separate evidence reviewer. Judge whether each claim is actually supported by its cited source quotations. Do not accept a claim merely because a quotation exists. Mark misleading quantities, wrong entities and unsupported conclusions false. Assess inference as a defensible interpretation rather than a proven fact. Return exactly one item per zero-based finding index.`, { task: 'Verify evidence support for every finding', findings: analysis.findings, sources: sources.map(s => ({ id: s.id, url: s.url, text: s.text.slice(0, 10000) })) }, { organizationId, runId });
        await this.db.researchRun.update({ where: { id: runId }, data: { providerTokens: { increment: result.tokens } } });
        const indexes = new Set(result.data.items.map(item => item.index));
        if (indexes.size !== analysis.findings.length || result.data.items.length !== analysis.findings.length || result.data.items.some(item => item.index >= analysis.findings.length)) throw new Error('Evidence reviewer did not cover every finding exactly once');
        return result.data;
      });
      const rejected = verification.items.filter(item => !item.supported);
      analysis = analysisSchema.parse({ ...analysis, findings: analysis.findings.filter((_, index) => !rejected.some(item => item.index === index)), limitations: [...analysis.limitations, ...rejected.slice(0, Math.max(0, 15 - analysis.limitations.length)).map(item => `Finding excluded after AI evidence review: ${item.reason}`)] });
      await checkpoint('report', z.object({ reportId: z.uuid() }), 1, async () => {
        return this.db.$transaction(async tx => {
          const existing = await tx.report.findUnique({ where: { organizationId_runId: { organizationId, runId } } });
          if (existing) return { reportId: existing.id };
          for (const competitor of analysis.competitors) { const saved = await tx.competitor.upsert({ where: { organizationId_projectId_domain: { organizationId, projectId, domain: competitor.domain.toLowerCase() } }, create: { organizationId, projectId, name: competitor.name, domain: competitor.domain.toLowerCase(), classification: competitor.classification, description: competitor.description }, update: { name: competitor.name, classification: competitor.classification, description: competitor.description } });
            await tx.projectCompetitor.upsert({ where: { organizationId_projectId_competitorId: { organizationId, projectId, competitorId: saved.id } }, create: { organizationId, projectId, competitorId: saved.id }, update: {} });
          }
          for (const finding of analysis.findings) {
            const saved = await tx.finding.create({ data: { organizationId, projectId, runId, category: finding.category, claim: finding.claim, verification: finding.kind === 'INFERENCE' ? 'INFERENCE' : 'PARTIALLY_VERIFIED', evidence: { create: finding.citations.map(c => ({ sourceId: c.sourceId, quotation: c.quotation })) } } });
            if (['STRENGTH','WEAKNESS','OPPORTUNITY','THREAT'].includes(finding.category)) await tx.swotItem.create({ data: { organizationId, findingId: saved.id, category: finding.category } });
            if (finding.category === 'OPPORTUNITY') await tx.marketOpportunity.create({ data: { organizationId, findingId: saved.id } });
          }
          await this.intelligence.persist(tx, organizationId, projectId, catalog, sources);
          const report = await tx.report.create({ data: { organizationId, projectId, runId, title: `${run.project.name} — competitive intelligence`, content: json({ ...analysis, methodology: { promptVersion: PROMPT_VERSION, retrievalTime: new Date().toISOString(), sourceCount: sources.length, failures: extraction.failures, verification: 'Quotations checked against extracted text. Semantic truth has not been independently verified. Strategic content is inference.' } }) } });
          return { reportId: report.id };
        });
      });
      await checkCancelled();
      await this.db.$transaction(async tx => {
        await this.credits.settle(tx, organizationId, runId, consumed);
        await tx.researchRun.update({ where: { id: runId }, data: { status: 'COMPLETED', finishedAt: new Date(), error: null } });
        await tx.notification.create({ data: { organizationId, title: 'Research ready', body: `Your competitive intelligence report for ${run.project.name} is ready.` } });
        await this.webhooks.emit(tx, organizationId, 'research.completed', runId, { runId, projectId });
      });
    } catch (error) {
      const latest = await this.db.researchRun.findUniqueOrThrow({ where: { id: runId } });
      const cancelled = latest.cancelRequested;
      const completedStages = await this.db.researchStage.findMany({ where: { organizationId, runId, status: 'COMPLETED' } });
      const stageCosts: Record<string, number> = { plan: 5, search: options.discover ? 3 : 0, extract: options.depth === 'deep' ? 12 : 6, analyze: 5, catalog: 2, verify: 2, report: 1 };
      consumed = completedStages.reduce((sum, stage) => sum + (stageCosts[stage.name] ?? 0), 0);
      await this.db.$transaction(async tx => {
        await this.credits.settle(tx, organizationId, runId, consumed);
        await tx.researchRun.update({ where: { id: runId }, data: { status: cancelled ? 'CANCELLED' : 'FAILED', error: cancelled ? 'Research cancelled; unused credits released' : error instanceof Error ? error.message.slice(0, 400) : 'Research failed', finishedAt: new Date() } });
        await tx.researchStage.updateMany({ where: { organizationId, runId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: cancelled ? 'CANCELLED' : 'FAILED', finishedAt: new Date() } });
      });
    }
  }
}

@Controller('organizations/:orgId/projects/:projectId/research')
@UseGuards(SessionGuard)
export class ResearchController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(TenantPolicy) private readonly policy: TenantPolicy, @Inject(ResearchService) private readonly research: ResearchService) {}
  @Post('estimate') async estimate(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Body() input: unknown) { await this.policy.authorize(req.actor.id, uuid(orgId), 'research'); return { credits: estimateCredits(researchOptions.parse(input)), accounting: 'Credits are product units per completed stage, not currency. Unused reservations are released.' }; }
  @Post() async create(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('projectId') projectId: string, @Body() input: unknown) { await this.policy.authorize(req.actor.id, uuid(orgId), 'research'); if (!req.actor.verified) throw new ForbiddenException('Verify your email before starting research'); return this.research.create(orgId, uuid(projectId), req.actor.id, input); }
  @Get(':runId') async get(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('projectId') projectId: string, @Param('runId') runId: string) {
    await this.policy.authorize(req.actor.id, uuid(orgId)); const run = await this.db.researchRun.findFirst({ where: { id: uuid(runId), organizationId: orgId, projectId: uuid(projectId) }, include: { stages: true } }); if (!run) throw new NotFoundException(); return run;
  }
  @Post(':runId/cancel') async cancel(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('projectId') projectId: string, @Param('runId') runId: string) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'research'); const result = await this.db.researchRun.updateMany({ where: { id: uuid(runId), organizationId: orgId, projectId: uuid(projectId), status: { in: ['QUEUED', 'RUNNING'] } }, data: { cancelRequested: true } }); if (!result.count) throw new NotFoundException('No active research run found'); return { message: 'Cancellation requested' };
  }
  @Sse(':runId/events') @Header('Cache-Control', 'no-store') async events(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('projectId') projectId: string, @Param('runId') runId: string) {
    await this.get(req, orgId, projectId, runId);
    return new Observable<MessageEvent>(subscriber => {
      let busy = false; let closed = false; let ticks = 0;
      const tick = async () => { if (busy || closed) return; busy = true; try {
        // Recheck membership on each tick so revoked members lose an existing stream.
        const run = await this.get(req, orgId, projectId, runId); subscriber.next({ data: run });
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status) || ++ticks >= 450) subscriber.complete();
      } catch { subscriber.complete(); } finally { busy = false; } };
      const timer = setInterval(() => void tick(), 2000); void tick(); return () => { closed = true; clearInterval(timer); };
    });
  }
}
