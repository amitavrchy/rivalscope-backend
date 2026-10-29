import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { Database } from '../src/database.js';
import { configureApp } from '../src/bootstrap.js';
import { CreditsService } from '../src/credits.js';
import { ResearchService } from '../src/research.js';
import { AiService } from '../src/providers.js';
import { env } from '../src/config.js';
import * as sourceHttp from '../src/safe-http.js';
import { BillingService } from '../src/billing.js';
import Stripe from 'stripe';

describe('real PostgreSQL API boundaries', () => {
  let app: INestApplication; let db: Database;
  let cookieA: string; let cookieB: string; let orgA: string; let orgB: string; let projectA: string; let userA: string;
  const suffix = randomUUID();
  const mutation = (cookie: string) => ({ Cookie: cookie, Origin: env.APP_ORIGIN });
  beforeAll(async () => {
    if (!new URL(env.DATABASE_URL).pathname.endsWith('/rivalscope_test')) throw new Error('Integration tests require a dedicated rivalscope_test database');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(module.createNestApplication({ rawBody: true })); await app.init(); db = app.get(Database);
    for (const name of ['a', 'b']) {
      const response = await request(app.getHttpServer()).post('/api/auth/register').set('Origin', env.APP_ORIGIN).send({ name: `Analyst ${name}`, email: `${name}-${suffix}@example.test`, password: 'a-long-unique-password-123', organizationName: `Workspace ${name}` }).expect(201);
      const cookie = String(response.headers['set-cookie'][0]).split(';')[0]!;
      const me = await request(app.getHttpServer()).get('/api/auth/me').set('Cookie', cookie).expect(200);
      if (name === 'a') { cookieA = cookie; orgA = me.body.memberships[0].organization.id; userA = me.body.id; }
      else { cookieB = cookie; orgB = me.body.memberships[0].organization.id; }
    }
    const project = await request(app.getHttpServer()).post(`/api/organizations/${orgA}/projects`).set(mutation(cookieA)).send({ name: 'Evidence platform', description: 'A public evidence management and competitive analysis business.' }).expect(201); projectA = project.body.id;
  });
  afterAll(async () => { if (app) await app.close(); });
  it('serves health and denies anonymous access', async () => { await request(app.getHttpServer()).get('/api/health/ready').expect(200); await request(app.getHttpServer()).get('/api/auth/me').expect(401); });
  it('never stores raw passwords or sessions', async () => { const user = await db.user.findUniqueOrThrow({ where: { id: userA } }); expect(user.passwordHash).toMatch(/^\$argon2/); const session = await db.session.findFirstOrThrow({ where: { userId: userA } }); expect(session.tokenHash).not.toBe(cookieA.split('=')[1]); });
  it('blocks cross-workspace reads and ID substitution', async () => {
    await request(app.getHttpServer()).get(`/api/organizations/${orgA}/projects`).set('Cookie', cookieB).expect(403);
    await request(app.getHttpServer()).get(`/api/organizations/${orgB}/projects/${projectA}`).set('Cookie', cookieB).expect(404);
  });
  it('blocks cross-workspace mutations and forged origins', async () => {
    await request(app.getHttpServer()).patch(`/api/organizations/${orgA}/projects/${projectA}`).set(mutation(cookieB)).send({ name: 'Hijacked' }).expect(403);
    await request(app.getHttpServer()).patch(`/api/organizations/${orgA}/projects/${projectA}`).set({ Cookie: cookieA, Origin: 'https://evil.example' }).send({ name: 'Hijacked' }).expect(403);
  });
  it('enforces tenant identity in database foreign keys', async () => {
    await expect(db.competitor.create({ data: { organizationId: orgB, projectId: projectA, name: 'Invalid tenant child', domain: 'invalid.example' } })).rejects.toHaveProperty('code', 'P2003');
  });
  it('requires verified email before research', async () => {
    await request(app.getHttpServer()).post(`/api/organizations/${orgA}/projects/${projectA}/research`).set(mutation(cookieA)).send({ objectives: 'Research public competitor pricing', discover: false, sourceUrls: ['https://example.com'], idempotencyKey: randomUUID() }).expect(403);
  });
  it('rejects malformed payloads and viewer privilege escalation', async () => {
    const viewer = await db.user.findFirstOrThrow({ where: { email: `b-${suffix}@example.test` } });
    await db.membership.create({ data: { organizationId: orgA, userId: viewer.id, role: 'VIEWER' } });
    await request(app.getHttpServer()).post(`/api/organizations/${orgA}/projects`).set(mutation(cookieB)).send({ name: 'No access', description: 'This viewer cannot create any research projects.' }).expect(403);
    await request(app.getHttpServer()).post(`/api/organizations/${orgA}/projects`).set(mutation(cookieA)).send({ name: 'Bad', description: 'Short', organizationId: orgB }).expect(400);
  });
  it('serializes concurrent credit reservations and prevents overspending', async () => {
    const service = app.get(CreditsService); const keys = [randomUUID(), randomUUID()];
    const results = await Promise.allSettled(keys.map(runId => db.$transaction(tx => service.reserve(tx, orgA, runId, 75))));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const org = await db.organization.findUniqueOrThrow({ where: { id: orgA } }); expect(org.reservedCredits).toBe(75);
    await db.organization.update({ where: { id: orgA }, data: { reservedCredits: 0 } });
  });
  it('settles reservations idempotently and releases unused credits', async () => {
    const service = app.get(CreditsService); const runId = randomUUID();
    await db.$transaction(async tx => { await service.reserve(tx, orgA, runId, 20); await tx.researchRun.create({ data: { id: runId, organizationId: orgA, projectId: projectA, idempotencyKey: randomUUID(), options: {}, reservedCredits: 20 } }); });
    await db.$transaction(tx => service.settle(tx, orgA, runId, 7)); await db.$transaction(tx => service.settle(tx, orgA, runId, 7));
    const org = await db.organization.findUniqueOrThrow({ where: { id: orgA } }); expect(org.credits).toBe(93); expect(org.reservedCredits).toBe(0);
    expect(await db.creditLedger.count({ where: { organizationId: orgA, idempotencyKey: `settle-${runId}` } })).toBe(1);
    await db.researchRun.update({ where: { id: runId }, data: { status: 'CANCELLED' } });
  });
  it('cancels queued work before any provider call and refunds the reservation', async () => {
    const service = app.get(ResearchService); const ai = vi.spyOn(app.get(AiService), 'generate'); const runId = randomUUID();
    await db.$transaction(async tx => { await app.get(CreditsService).reserve(tx, orgA, runId, 21); await tx.researchRun.create({ data: { id: runId, organizationId: orgA, projectId: projectA, idempotencyKey: randomUUID(), options: { objectives: 'Research public pricing evidence', depth: 'standard', competitorCount: 4, sourceUrls: ['https://example.com'], discover: false, countries: [] }, reservedCredits: 21, cancelRequested: true, stages: { create: ['plan', 'search', 'extract', 'analyze', 'report'].map(name => ({ name })) } } }); });
    await service.execute(runId); expect(ai).not.toHaveBeenCalled(); ai.mockRestore();
    expect((await db.researchRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('CANCELLED');
    expect((await db.organization.findUniqueOrThrow({ where: { id: orgA } })).reservedCredits).toBe(0);
  });
  it('prevents mutations of immutable ledger entries', async () => {
    const entry = await db.creditLedger.findFirstOrThrow({ where: { organizationId: orgA } });
    await expect(db.creditLedger.update({ where: { id: entry.id }, data: { amount: 999 } })).rejects.toThrow();
    await expect(db.creditLedger.delete({ where: { id: entry.id } })).rejects.toThrow();
  });
  it('executes a deterministic research pipeline with persisted findings, sources and report', async () => {
    await db.user.update({ where: { id: userA }, data: { emailVerifiedAt: new Date() } });
    const research = app.get(ResearchService); const submit = vi.spyOn(research, 'enqueue').mockResolvedValue(undefined);
    const sourceText = 'The Starter plan costs $19 per month and includes shared team workspaces, public reporting tools and collaborative research notes.';
    const extract = vi.spyOn(sourceHttp, 'extractWebsite').mockResolvedValue({ url: 'https://evidence.example/pricing', title: 'Public pricing', text: sourceText, contentHash: 'a'.repeat(64) });
    const ai = vi.spyOn(app.get(AiService), 'generate').mockImplementation(async (schema, _system, input) => {
      const sources = (input as { sources?: { id: string }[] }).sources;
      const task = (input as { task?: string }).task || '';
      if (task.startsWith('Extract a catalog')) return { data: schema.parse({ products: [], features: [{ domain: 'evidence.example', name: 'Shared workspaces', sourceId: sources![0]!.id, quotation: sourceText }], prices: [{ domain: 'evidence.example', name: 'Starter', amount: 19, currency: 'USD', interval: 'MONTH', sourceId: sources![0]!.id, quotation: sourceText }] }), tokens: 15, provider: 'test', model: 'deterministic' };
      if (task.startsWith('Verify evidence')) return { data: schema.parse({ items: [{ index: 0, supported: true, reason: 'Price is explicitly stated in the supplied quotation.' }] }), tokens: 15, provider: 'test', model: 'deterministic' };
      const result = sources ? { executiveSummary: 'A pricing comparison based on one public page.', competitors: [{ name: 'Evidence Tools', domain: 'evidence.example', classification: 'DIRECT', description: 'A research tool.', sourceIds: [sources[0]!.id] }], findings: [{ category: 'PRICING', claim: 'The Starter plan costs $19 per month.', kind: 'FACT', citations: [{ sourceId: sources[0]!.id, quotation: sourceText }] }], limitations: ['Single source; pricing may change.'] } : { businessUnderstanding: 'Competitive intelligence business', queries: ['competitor public pricing'], limitations: ['Public information only'] };
      return { data: schema.parse(result), tokens: 15, provider: 'test', model: 'deterministic' };
    });
    try {
      const input = { objectives: 'Compare public competitor pricing', discover: false, sourceUrls: ['https://evidence.example/pricing'], idempotencyKey: randomUUID() };
      const run = await research.create(orgA, projectA, userA, input);
      expect((await research.create(orgA, projectA, userA, input)).id).toBe(run.id);
      await research.execute(run.id); await research.execute(run.id);
      const complete = await db.researchRun.findUniqueOrThrow({ where: { id: run.id }, include: { stages: true, reports: true, findings: { include: { evidence: true } } } });
      expect(complete.status).toBe('COMPLETED'); expect(complete.consumedCredits).toBe(21); expect(complete.providerTokens).toBe(60);
      expect(complete.stages.every(s => s.status === 'COMPLETED')).toBe(true); expect(complete.reports).toHaveLength(1); expect(complete.findings[0]?.evidence[0]?.quotation).toBe(sourceText); expect(complete.findings[0]?.verification).toBe('PARTIALLY_VERIFIED');
      await request(app.getHttpServer()).get(`/api/organizations/${orgA}/reports/${complete.reports[0]!.id}/export?format=markdown`).set('Cookie', cookieA).expect(200).expect('Content-Type', /text\/markdown/);
      expect(ai).toHaveBeenCalledTimes(4); expect(extract).toHaveBeenCalledTimes(1);
    } finally { submit.mockRestore(); extract.mockRestore(); ai.mockRestore(); }
  });
  it('verifies webhook signatures and grants invoice credits only once', async () => {
    const billing = app.get(BillingService); const stripe = new Stripe(env.STRIPE_SECRET_KEY!); const service = vi.spyOn(billing, 'stripe').mockReturnValue(stripe);
    await db.plan.update({ where: { id: 'starter' }, data: { stripeMonthlyPriceId: 'price_fixture_starter' } });
    await db.subscription.update({ where: { organizationId: orgA }, data: { stripeCustomerId: `cus_${suffix}` } });
    const sub = { id: `sub_${suffix}`, metadata: { organizationId: orgA }, customer: `cus_${suffix}`, status: 'active', items: { data: [{ price: { id: 'price_fixture_starter' }, current_period_end: Math.floor(Date.now() / 1000) + 86400 }] } } as unknown as Stripe.Response<Stripe.Subscription>;
    const retrieve = vi.spyOn(stripe.subscriptions, 'retrieve').mockResolvedValue(sub);
    try {
      const invoiceId = `in_${suffix}`; const invoice = { id: invoiceId, status: 'paid', amount_paid: 1900, currency: 'usd', created: Math.floor(Date.now() / 1000), number: 'TEST-001', hosted_invoice_url: null, billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: sub.id } } };
      const event = JSON.stringify({ id: `evt_${suffix}`, type: 'invoice.paid', created: Math.floor(Date.now() / 1000), data: { object: invoice } });
      const signature = stripe.webhooks.generateTestHeaderString({ payload: event, secret: env.STRIPE_WEBHOOK_SECRET! });
      await expect(billing.webhook(Buffer.from(event), 'bad-signature')).rejects.toThrow('signature');
      const previous = await db.organization.findUniqueOrThrow({ where: { id: orgA } });
      await billing.webhook(Buffer.from(event), signature); await billing.webhook(Buffer.from(event), signature);
      expect((await db.organization.findUniqueOrThrow({ where: { id: orgA } })).credits).toBe(previous.credits + 500);
      expect(await db.creditLedger.count({ where: { idempotencyKey: `invoice-${invoiceId}` } })).toBe(1);
      expect((await db.subscription.findUniqueOrThrow({ where: { organizationId: orgA } })).planId).toBe('starter');
    } finally { retrieve.mockRestore(); service.mockRestore(); }
  });
  it('limits customer API keys to their tenant and scopes and revokes them immediately', async () => {
    const created = await request(app.getHttpServer()).post(`/api/organizations/${orgA}/api-keys`).set(mutation(cookieA)).send({ name: 'Fixture reporting', scopes: ['projects:read'] }).expect(201);
    expect(created.body.key).toMatch(/^rs_live_/);
    const projects = await request(app.getHttpServer()).get('/api/v1/projects').set('Authorization', `Bearer ${created.body.key}`).expect(200);
    expect(projects.body.every((p: { id: string }) => p.id === projectA)).toBe(true);
    await request(app.getHttpServer()).get('/api/v1/reports').set('Authorization', `Bearer ${created.body.key}`).expect(403);
    await request(app.getHttpServer()).delete(`/api/organizations/${orgA}/api-keys/${created.body.id}`).set(mutation(cookieA)).send({}).expect(200);
    await request(app.getHttpServer()).get('/api/v1/projects').set('Authorization', `Bearer ${created.body.key}`).expect(401);
    await request(app.getHttpServer()).get('/api/admin/overview').set('Cookie', cookieA).expect(403);
  });
  it('revokes all sessions on a password reset and consumes the token only once', async () => {
    const { hashToken, newToken } = await import('../src/security.js'); const token = newToken();
    await db.verificationToken.create({ data: { userId: userA, purpose: 'reset', tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60_000) } });
    await request(app.getHttpServer()).post('/api/auth/reset-password').set('Origin', env.APP_ORIGIN).send({ token, password: 'a-different-long-password-456' }).expect(201);
    await request(app.getHttpServer()).get('/api/auth/me').set('Cookie', cookieA).expect(401);
    await request(app.getHttpServer()).post('/api/auth/reset-password').set('Origin', env.APP_ORIGIN).send({ token, password: 'another-long-password-789' }).expect(401);
  });
});
