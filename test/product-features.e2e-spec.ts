import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { Database } from '../src/database.js';
import { RedisStore } from '../src/redis-store.js';
import { env } from '../src/config.js';
import { MockBillingAdapter } from '../src/mock-billing.js';
import { BillingService } from '../src/billing.js';
import { hasActiveEntitlement } from '../src/entitlements.js';
import { EmbeddingService } from '../src/embeddings.js';
import { NotificationService } from '../src/notifications.js';
import { MonitoringService } from '../src/monitoring.js';
import * as sourceHttp from '../src/safe-http.js';

describe('sharing, exports, RLS, monitoring and sandbox billing', () => {
  let app: INestApplication; let db: Database; let cookieA: string; let cookieB: string; let orgA: string; let orgB: string; let userA: string; let userB: string; let projectA: string; let projectB: string; let sourceA: string; let sourceB: string; let reportId: string;
  const suffix = randomUUID(); const password = 'a-long-feature-test-password-123';
  const headers = (cookie = cookieA) => ({ Cookie: cookie, Origin: env.APP_ORIGIN });
  const text = 'The Starter plan costs $19 per month and includes team collaboration, customer support, shared research and public reporting.';
  beforeAll(async () => {
    if (!new URL(env.DATABASE_URL).pathname.endsWith('/rivalscope_test')) throw new Error('Use the isolated test database');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile(); app = configureApp(module.createNestApplication()); await app.init(); db = app.get(Database);
    const redis = app.get(RedisStore); const keys = await redis.client.keys('rs:throttle:*'); if (keys.length) await redis.client.del(...keys);
    for (const name of ['a','b']) {
      const register = await request(app.getHttpServer()).post('/api/auth/register').set('Origin', env.APP_ORIGIN).send({ name: `Feature ${name}`, email: `feature-${name}-${suffix}@example.test`, password, organizationName: `Feature workspace ${name}` }).expect(201);
      const cookie = String(register.headers['set-cookie'][0]).split(';')[0]!; const me = await request(app.getHttpServer()).get('/api/auth/me').set('Cookie', cookie).expect(200);
      const userId = me.body.id as string; const org = me.body.memberships[0].organization.id as string; await db.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
      const project = await db.project.create({ data: { organizationId: org, name: `Feature project ${name}`, description: 'A real persisted project for deterministic security and export fixtures.' } });
      const run = await db.researchRun.create({ data: { organizationId: org, projectId: project.id, idempotencyKey: randomUUID(), options: {}, status: 'COMPLETED', reservedCredits: 21 } });
      const source = await db.source.create({ data: { organizationId: org, projectId: project.id, runId: run.id, url: `https://evidence-${name}.example/pricing`, title: 'Pricing evidence', text, contentHash: 'a'.repeat(64) } });
      if (name === 'a') { cookieA = cookie; orgA = org; userA = userId; projectA = project.id; sourceA = source.id; const report = await db.report.create({ data: { organizationId: org, projectId: project.id, runId: run.id, title: 'Source-backed fixture report', content: { executiveSummary: 'An interpretation of public pricing.', competitors: [], findings: [{ category: 'PRICING', claim: 'Starter costs $19 monthly.', kind: 'FACT', citations: [{ sourceId: source.id, quotation: text }] }], limitations: ['Single public source.'] } } }); reportId = report.id; }
      else { cookieB = cookie; orgB = org; userB = userId; projectB = project.id; sourceB = source.id; }
    }
  });
  afterAll(async () => { if (app) await app.close(); });
  it('generates actual PDF and Word files with source-backed content', async () => {
    const pdf = await request(app.getHttpServer()).get(`/api/organizations/${orgA}/reports/${reportId}/export?format=pdf`).set('Cookie', cookieA).expect(200).expect('Content-Type', /application\/pdf/);
    expect(Buffer.isBuffer(pdf.body)).toBe(true); expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    const word = await request(app.getHttpServer()).get(`/api/organizations/${orgA}/reports/${reportId}/export?format=docx`).set('Cookie', cookieA).buffer(true).parse((res, callback) => { const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('end', () => callback(null, Buffer.concat(chunks))); res.on('error', callback); }).expect(200); expect(Buffer.isBuffer(word.body)).toBe(true); expect((word.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    const exports = await db.reportExport.findMany({ where: { organizationId: orgA, reportId } }); expect(exports).toHaveLength(2); expect(exports.find(e => e.format === 'pdf')?.contentHash).toBe(createHash('sha256').update(pdf.body as Buffer).digest('hex'));
    await request(app.getHttpServer()).get(`/api/organizations/${orgB}/reports/${reportId}/export?format=pdf`).set('Cookie', cookieB).expect(404);
  });
  it('enforces workspace-only share links, explicit external sharing, passwords, expiry and revocation', async () => {
    const privateLink = await request(app.getHttpServer()).post(`/api/organizations/${orgA}/reports/${reportId}/shares`).set(headers()).send({ audience: 'WORKSPACE', days: 1 }).expect(201);
    const privateToken = privateLink.body.url.split('/').at(-1);
    await request(app.getHttpServer()).post(`/api/shared/${privateToken}`).set('Origin', env.APP_ORIGIN).send({}).expect(403);
    await request(app.getHttpServer()).post(`/api/shared/${privateToken}`).set(headers(cookieB)).send({}).expect(403);
    await request(app.getHttpServer()).post(`/api/shared/${privateToken}`).set(headers()).send({}).expect(201);
    await request(app.getHttpServer()).post(`/api/organizations/${orgA}/reports/${reportId}/shares`).set(headers()).send({ audience: 'PUBLIC', days: 1 }).expect(403);
    const publicLink = await request(app.getHttpServer()).post(`/api/organizations/${orgA}/reports/${reportId}/shares`).set(headers()).send({ audience: 'PUBLIC', days: 1, confirmPublic: true, password: 'a-strong-report-password' }).expect(201);
    const token = publicLink.body.url.split('/').at(-1);
    await request(app.getHttpServer()).post(`/api/shared/${token}`).set('Origin', env.APP_ORIGIN).send({ password: 'wrong' }).expect(403);
    const shared = await request(app.getHttpServer()).post(`/api/shared/${token}`).set('Origin', env.APP_ORIGIN).send({ password: 'a-strong-report-password' }).expect(201); expect(shared.body.sources[0].id).toBe(sourceA);
    await request(app.getHttpServer()).delete(`/api/organizations/${orgA}/shares/${publicLink.body.id}`).set(headers()).send({}).expect(200);
    await request(app.getHttpServer()).post(`/api/shared/${token}`).set('Origin', env.APP_ORIGIN).send({ password: 'a-strong-report-password' }).expect(404);
    await db.shareLink.update({ where: { id: privateLink.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await request(app.getHttpServer()).post(`/api/shared/${privateToken}`).set(headers()).send({}).expect(404);
  });
  it('keeps bookmarks personal while project comments remain workspace-scoped', async () => {
    await db.membership.create({ data: { organizationId: orgA, userId: userB, role: 'VIEWER' } });
    await request(app.getHttpServer()).post(`/api/organizations/${orgA}/projects/${projectA}/bookmarks`).set(headers()).send({ note: 'My private research note.' }).expect(201);
    await request(app.getHttpServer()).post(`/api/organizations/${orgA}/projects/${projectA}/comments`).set(headers()).send({ body: 'Team evidence review is ready.' }).expect(201);
    const viewer = await request(app.getHttpServer()).get(`/api/organizations/${orgA}/projects/${projectA}/collaboration`).set('Cookie', cookieB).expect(200);
    expect(viewer.body.bookmarks).toHaveLength(0); expect(viewer.body.comments).toHaveLength(1);
    await request(app.getHttpServer()).post(`/api/organizations/${orgA}/projects/${projectA}/comments`).set(headers(cookieB)).send({ body: 'A viewer cannot edit.' }).expect(403);
  });
  it('enforces read-only RLS scope even when a tenant filter is omitted', async () => {
    const sources = await db.tenantRead(orgA, tx => tx.source.findMany()); expect(sources.map(s => s.id)).toEqual([sourceA]);
    const other = await db.tenantRead(orgA, tx => tx.source.findMany({ where: { id: sourceB } })); expect(other).toHaveLength(0);
    await expect(db.tenantRead(orgA, tx => tx.source.update({ where: { id: sourceA }, data: { title: 'Unauthorized write' } }))).rejects.toThrow();
  });
  it('edits, archives and restores projects within role and plan limits', async () => {
    const project = await request(app.getHttpServer()).post(`/api/organizations/${orgA}/projects`).set(headers()).send({ name: 'Restoration fixture', description: 'A persisted project for edit, archive and restore lifecycle checks.' }).expect(201);
    await request(app.getHttpServer()).patch(`/api/organizations/${orgA}/projects/${project.body.id}`).set(headers()).send({ name: 'Updated restoration fixture', website: null }).expect(200);
    await request(app.getHttpServer()).delete(`/api/organizations/${orgA}/projects/${project.body.id}`).set(headers()).send({}).expect(200);
    const archived = await request(app.getHttpServer()).get(`/api/organizations/${orgA}/projects/archived`).set('Cookie', cookieA).expect(200); expect(archived.body.some((p: {id:string}) => p.id === project.body.id)).toBe(true);
    await request(app.getHttpServer()).post(`/api/organizations/${orgA}/projects/${project.body.id}/restore`).set(headers(cookieB)).send({}).expect(403);
    await request(app.getHttpServer()).post(`/api/organizations/${orgA}/projects/${project.body.id}/restore`).set(headers()).send({}).expect(201);
    expect((await db.project.findUniqueOrThrow({where:{id:project.body.id}})).deletedAt).toBeNull();
  });
  it('transfers ownership only to a verified workspace member and revokes the prior owner permission', async () => {
    await request(app.getHttpServer()).post(`/api/organizations/${orgA}/transfer-ownership`).set(headers()).send({userId:userB,password}).expect(201);
    expect((await db.membership.findUniqueOrThrow({where:{organizationId_userId:{organizationId:orgA,userId:userA}}})).role).toBe('ADMIN');
    await request(app.getHttpServer()).get(`/api/privacy/organizations/${orgA}/export`).set('Cookie',cookieA).expect(403);
    await request(app.getHttpServer()).post(`/api/organizations/${orgA}/transfer-ownership`).set(headers(cookieB)).send({userId:userA,password}).expect(201);
    expect((await db.membership.findUniqueOrThrow({where:{organizationId_userId:{organizationId:orgA,userId:userA}}})).role).toBe('OWNER');
    await db.membership.update({where:{organizationId_userId:{organizationId:orgA,userId:userB}},data:{role:'VIEWER'}});
  });
  it('retrieves vector evidence only from the authorized organization and project', async () => {
    const vector = [1, ...Array<number>(767).fill(0)]; const literal = JSON.stringify(vector);
    for (const [organizationId, projectId, sourceId] of [[orgA, projectA, sourceA], [orgB, projectB, sourceB]]) await db.$executeRaw`INSERT INTO "EmbeddingRecord" (id,"organizationId","projectId","sourceId",model,"contentHash",content,vector,"createdAt") VALUES (${randomUUID()}::uuid,${organizationId}::uuid,${projectId}::uuid,${sourceId}::uuid,${env.EMBEDDING_MODEL},'fixture',${text},${literal}::vector,NOW())`;
    const embeddings = app.get(EmbeddingService); const generate = vi.spyOn(embeddings, 'vector').mockResolvedValue(vector); const configured = vi.spyOn(embeddings, 'configured').mockReturnValue(true);
    try { const sources = await embeddings.retrieve(orgA, projectA, 'pricing'); expect(sources?.map(s => s.id)).toEqual([sourceA]); expect(await embeddings.retrieve(orgA, projectB, 'pricing')).toBeNull(); } finally { generate.mockRestore(); configured.mockRestore(); }
  });
  it('tracks notification read state per user and queues email once', async () => {
    await request(app.getHttpServer()).post(`/api/organizations/${orgA}/notification-preferences`).set(headers()).send({ emailEnabled: true, frequency: 'INSTANT' }).expect(201);
    const notification = await db.notification.create({ data: { organizationId: orgA, title: 'Research completed', body: 'Evidence-backed report is ready.' } });
    await request(app.getHttpServer()).post(`/api/organizations/${orgA}/notifications/${notification.id}/read`).set(headers()).send({}).expect(201);
    const other = await request(app.getHttpServer()).get(`/api/organizations/${orgA}/notifications`).set('Cookie', cookieB).expect(200); expect(other.body.find((n: { id: string }) => n.id === notification.id).readAt).toBeNull();
    await app.get(NotificationService).deliver(); await app.get(NotificationService).deliver();
    expect(await db.emailDelivery.count({ where: { idempotencyKey: `notification-${notification.id}-${userA}` } })).toBe(1);
  });
  it('persists monitor snapshots and suppresses unchanged-page alerts', async () => {
    const monitor = await db.monitor.create({ data: { organizationId: orgA, projectId: projectA, url: 'https://evidence-a.example/pricing' } });
    const extract = vi.spyOn(sourceHttp, 'extractWebsite').mockResolvedValue({ url: monitor.url, title: 'Pricing', text, contentHash: 'a'.repeat(64) });
    try { await app.get(MonitoringService).execute(monitor.id); await app.get(MonitoringService).execute(monitor.id); expect(await db.sourceSnapshot.count({ where: { monitorId: monitor.id } })).toBe(2); expect(await db.changeEvent.count({ where: { monitorId: monitor.id } })).toBe(0); extract.mockResolvedValue({ url: monitor.url, title: 'Pricing', text: text + ' New feature published.', contentHash: 'b'.repeat(64) }); await app.get(MonitoringService).execute(monitor.id); await app.get(MonitoringService).execute(monitor.id); expect(await db.changeEvent.count({ where: { monitorId: monitor.id } })).toBe(1); } finally { extract.mockRestore(); }
  });
  it('verifies sandbox events, ignores duplicate completion and cancels to Free', async () => {
    const original = env.BILLING_PROVIDER; env.BILLING_PROVIDER = 'mock';
    try { const billing = app.get(MockBillingAdapter); const checkout = await billing.checkout(orgA, 'starter', 'monthly'); const checkoutId = new URL(checkout.url).searchParams.get('sandboxCheckout')!; const before = await db.organization.findUniqueOrThrow({ where: { id: orgA } });
      await expect(billing.webhook('{}', 'invalid')).rejects.toThrow('signature'); await billing.complete(orgA, checkoutId); await billing.complete(orgA, checkoutId);
      expect((await db.organization.findUniqueOrThrow({ where: { id: orgA } })).credits).toBe(before.credits + 500); expect(await db.creditLedger.count({ where: { idempotencyKey: `mock-checkout-${checkoutId}` } })).toBe(1);
      await billing.cancel(orgA); expect((await db.subscription.findUniqueOrThrow({ where: { organizationId: orgA } })).planId).toBe('free');
    } finally { env.BILLING_PROVIDER = original; }
  });
  it('matches configured watch phrases once and keeps alert rules tenant scoped',async()=>{
    const monitor=await db.monitor.findFirstOrThrow({where:{organizationId:orgA}});
    const rule=await request(app.getHttpServer()).post(`/api/organizations/${orgA}/alert-rules`).set(headers()).send({monitorId:monitor.id,name:'Feature wording removed',phrase:'New feature published',condition:'DISAPPEARED',severity:'WARNING'}).expect(201);
    await request(app.getHttpServer()).post(`/api/organizations/${orgB}/alert-rules`).set(headers(cookieB)).send({monitorId:monitor.id,name:'Foreign monitor',phrase:'Feature',condition:'APPEARED'}).expect(404);
    await request(app.getHttpServer()).patch(`/api/organizations/${orgA}/alert-rules/${rule.body.id}`).set(headers(cookieB)).send({enabled:false}).expect(403);
    const extract=vi.spyOn(sourceHttp,'extractWebsite').mockResolvedValue({url:monitor.url,title:'Pricing',text,contentHash:'d'.repeat(64)});
    try{await app.get(MonitoringService).execute(monitor.id);await app.get(MonitoringService).execute(monitor.id);expect(await db.alert.count({where:{ruleId:rule.body.id}})).toBe(1);const history=await request(app.getHttpServer()).get(`/api/organizations/${orgA}/rule-alerts`).set('Cookie',cookieA).expect(200);expect(history.body[0].severity).toBe('WARNING');}finally{extract.mockRestore();}
  });
  it('links consumption to immutable ledger entries and rolls up actual daily usage',async()=>{
    const events=await request(app.getHttpServer()).get(`/api/organizations/${orgA}/usage/events`).set('Cookie',cookieA).expect(200);expect(events.body.length).toBeGreaterThan(0);
    await request(app.getHttpServer()).get(`/api/organizations/${orgA}/usage/events`).set('Cookie',cookieB).expect(403);
    const metrics=await request(app.getHttpServer()).get(`/api/organizations/${orgA}/usage/metrics`).set('Cookie',cookieA).expect(200);expect(Number(metrics.body[0].value)).toBeGreaterThan(0);
    await expect(db.usageEvent.update({where:{id:events.body[0].id},data:{units:999}})).rejects.toThrow();
    expect(await db.tenantRead(orgB,tx=>tx.usageEvent.findMany())).toHaveLength(0);
  });
  it('grants sandbox credit add-ons once, rejects tampering and preserves subscription state', async () => {
    const original = env.BILLING_PROVIDER; env.BILLING_PROVIDER = 'mock';
    try {
      const billing = app.get(BillingService); const before = await db.organization.findUniqueOrThrow({ where: { id: orgA } });
      const checkout = await billing.addon(orgA, 'credits-500'); const purchaseId = new URL(checkout.url).searchParams.get('sandboxPurchase')!;
      await expect(billing.sandboxAddonEvent('{}', 'invalid')).rejects.toThrow('signature');
      await expect(billing.completeSandboxAddon(orgB, purchaseId)).rejects.toThrow();
      await Promise.all([billing.completeSandboxAddon(orgA, purchaseId), billing.completeSandboxAddon(orgA, purchaseId)]);
      expect((await db.organization.findUniqueOrThrow({ where: { id: orgA } })).credits).toBe(before.credits + 500);
      expect(await db.creditLedger.count({ where: { idempotencyKey: `credit-purchase-${purchaseId}` } })).toBe(1);
      expect((await db.subscription.findUniqueOrThrow({ where: { organizationId: orgA } })).planId).toBe('free');
      const purchases = await request(app.getHttpServer()).get(`/api/organizations/${orgA}/billing/purchases`).set('Cookie', cookieA).expect(200); expect(purchases.body[0].status).toBe('completed');
      await request(app.getHttpServer()).get(`/api/organizations/${orgA}/billing/purchases`).set('Cookie', cookieB).expect(403);
    } finally { env.BILLING_PROVIDER = original; }
  });
  it('stops scheduled work after expiry or downgrade and gives past-due accounts a bounded grace period', async () => {
    const sub = await db.subscription.findUniqueOrThrow({ where: { organizationId: orgA } }); const plan = await db.plan.findUniqueOrThrow({ where: { id: 'free' } });
    const monitor = await db.monitor.findFirstOrThrow({ where: { organizationId: orgA } }); const before = await db.monitorRun.count({ where: { monitorId: monitor.id } });
    const extract = vi.spyOn(sourceHttp, 'extractWebsite').mockResolvedValue({ url: monitor.url, title: 'Pricing', text, contentHash: 'c'.repeat(64) });
    try {
      await db.subscription.update({ where: { id: sub.id }, data: { status: 'past_due', graceEndsAt: new Date(Date.now() - 1000) } });
      await app.get(MonitoringService).execute(monitor.id); expect(extract).not.toHaveBeenCalled();
      await db.subscription.update({ where: { id: sub.id }, data: { graceEndsAt: new Date(Date.now() + 60000) } });
      await app.get(MonitoringService).execute(monitor.id); expect(await db.monitorRun.count({ where: { monitorId: monitor.id } })).toBe(before + 1);
      await db.entitlement.update({ where: { planId_key: { planId: plan.id, key: 'monitorLimit' } }, data: { value: 0 } });
      await app.get(MonitoringService).execute(monitor.id); expect(await db.monitorRun.count({ where: { monitorId: monitor.id } })).toBe(before + 1);
      expect(hasActiveEntitlement({ status: 'active', currentPeriodEnd: new Date(Date.now() - 1000), graceEndsAt: null })).toBe(false);
    } finally { extract.mockRestore(); await db.subscription.update({ where: { id: sub.id }, data: { status: sub.status, graceEndsAt: sub.graceEndsAt } }); await db.entitlement.update({ where: { planId_key: { planId: plan.id, key: 'monitorLimit' } }, data: { value: plan.monitorLimit } }); }
  });
});
