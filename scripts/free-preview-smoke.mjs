// Runs only inside the disposable preview. Never prints credentials or response bodies.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
Object.assign(process.env, JSON.parse(readFileSync('/preview/runtime.json', 'utf8')));
const { PrismaPg } = await import('@prisma/adapter-pg');
const { PrismaClient } = await import('../dist/generated/prisma/client.js');
const { Queue } = await import('bullmq');
const { Redis } = await import('ioredis');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 2 }) });
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
let queue;
const origin = process.env.APP_ORIGIN;
const base = `http://127.0.0.1:${process.env.PORT}/api`;
let cookie = '';
async function api(path, method = 'GET', body, expected = 200, requestOrigin = origin) {
  const response = await fetch(base + path, { method, headers: { Cookie: cookie, Origin: requestOrigin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, expected, `${method} ${path} status`);
  const value = await response.json();
  return { response, value };
}
async function snapshot() {
  const result = {};
  for (const table of ['User', 'Organization', 'Membership', 'Subscription', 'Plan', 'Project', 'Competitor']) {
    const rows = await db.$queryRawUnsafe(`SELECT row_to_json(t) AS row FROM "${table}" t ORDER BY id`);
    result[table] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  return result;
}
try {
  await api('/health/ready');
  assert.equal((await redis.config('GET', 'maxmemory-policy'))[1], 'noeviction');
  assert.equal((await redis.config('GET', 'maxmemory'))[1], String(24 * 1024 * 1024));
  assert.equal((await db.$queryRaw`SELECT extversion FROM pg_extension WHERE extname='vector'`).length, 1);
  const { response: login } = await api('/auth/login', 'POST', { email: process.env.PREVIEW_LOGIN_EMAIL, password: process.env.PREVIEW_LOGIN_PASSWORD }, 201);
  assert.match(login.headers.get('set-cookie') || '', /HttpOnly/);
  assert.match(login.headers.get('set-cookie') || '', /Secure/);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const { value: me } = await api('/auth/me');
  assert.equal((await api('/billing/status')).value.configured, false);
  assert.equal(me.platformAdmin, false); assert.equal(me.emailVerifiedAt, null);
  const listeners = readFileSync('/proc/net/tcp', 'utf8').split('\n').slice(1).filter(Boolean).map(line => line.trim().split(/\s+/)).filter(row => row[3] === '0A').map(row => row[1]);
  for (const port of [5432, 6379]) assert.ok(listeners.includes(`0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`), 'Datastores must bind loopback only');
  assert.ok(listeners.includes(`00000000:${Number(process.env.PORT).toString(16).toUpperCase().padStart(4, '0')}`), 'API must bind all interfaces on PORT');
  if (process.argv.includes('--replacement')) {
    assert.equal(await db.project.count(), 24, 'Replacement must recreate only the initial synthetic project dataset');
    assert.equal(await db.user.count(), 25, 'Replacement must recreate synthetic accounts and the private preview login');
    console.log('PASS: fresh replacement reset, seed counts, private authenticated login and internal-only stores');
  } else   if (process.argv.includes('--verify-restart')) {
    const saved = JSON.parse(readFileSync('/preview/test-snapshot.json', 'utf8'));
    assert.equal(JSON.stringify(await snapshot()), JSON.stringify(saved.snapshot), 'Restart/reseed must preserve business rows and password hashes');
    await api(saved.projectPath);
    console.log('PASS: same-container restart, idempotent reseed, preserved passwords and authenticated read');
  } else {
    const org = me.memberships.find(m => m.organization.slug === 'synthetic-interactive-preview').organization.id;
    const basePath = `/organizations/${org}/projects`;
    const { value: project } = await api(basePath, 'POST', { name: 'Synthetic 512MB smoke study', description: 'A local synthetic preview verification project persisted through the real authenticated API.' }, 201);
    const projectPath = `${basePath}/${project.id}`;
    await api(projectPath, 'PATCH', { name: 'Synthetic 512MB updated study' });
    assert.equal((await api(projectPath)).value.name, 'Synthetic 512MB updated study');
    await api(projectPath, 'PATCH', { name: 'Forbidden write' }, 403, 'https://untrusted.invalid');
    await api(`${projectPath}/research`, 'POST', { objectives: 'Synthetic verification', discover: false }, 403);
    await api(`/organizations/${org}/billing/checkout`, 'POST', { planId: 'starter', interval: 'monthly' }, 400);
    const count = await db.user.count();
    await api('/auth/register', 'POST', { email: `${randomUUID()}@synthetic.invalid`, password: randomUUID(), name: 'Synthetic mail test', organizationName: 'Synthetic unavailable mail' }, 503);
    assert.equal(await db.user.count(), count, 'Unavailable SMTP must roll back registration');
    const run = await db.$transaction(async tx => {
      const runId = randomUUID();
      const current = await tx.organization.update({ where: { id: org }, data: { reservedCredits: { increment: 1 } } });
      await tx.creditLedger.create({ data: { organizationId: org, kind: 'RESERVE', amount: -1, balanceAfter: current.credits, referenceId: runId, idempotencyKey: `reserve-${runId}` } });
      return tx.researchRun.create({ data: { id: runId, organizationId: org, projectId: project.id, idempotencyKey: randomUUID(), status: 'QUEUED', cancelRequested: true, options: { objectives: 'Synthetic cancellation verification', depth: 'standard', competitorCount: 4, sourceUrls: ['https://example.com'], discover: false, countries: [] }, reservedCredits: 1 } });
    });
    queue = new Queue('rivalscope-research', { connection: { host: '127.0.0.1', port: 6379, password: new URL(process.env.REDIS_URL).password } });
    await queue.add('research', { runId: run.id });
    let processed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await db.researchRun.findUniqueOrThrow({ where: { id: run.id } })).status === 'CANCELLED') { processed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(processed, true, 'Separate BullMQ worker must process the cancelled fixture without an AI call');
    await api(projectPath, 'DELETE', {});
    await api(projectPath, 'GET', undefined, 404);
    await api(`${projectPath}/restore`, 'POST', {}, 201);
    writeFileSync('/preview/test-snapshot.json', JSON.stringify({ snapshot: await snapshot(), projectPath }), { mode: 0o600 });
    console.log('PASS: health, pgvector, bounded noeviction Redis, authenticated create/read/update/archive/restore, CSRF, unavailable email/research/billing, real worker cancellation');
  }
} finally { await queue?.close(); await redis.quit(); await db.$disconnect(); }
