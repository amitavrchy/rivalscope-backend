import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { hash } from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

// Deterministic IDs; reserved .invalid domains; no market evidence or provider calls.
const id = (key: string) => {
  const h = createHash('sha256').update(`rivalscope-synthetic-v1:${key}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
};
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
try {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_SEED !== 'true') throw new Error('Explicit production seed approval required');
  // No known password and no platform administrators. Access must be granted by an operator.
  const passwordHash = await hash(randomBytes(48).toString('base64url'));
  for (let tenant = 1; tenant <= 3; tenant++) {
    const organizationId = id(`org:${tenant}`);
    await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(74219001)`;
      if (await tx.organization.findUnique({ where: { id: organizationId } })) return;
      await tx.organization.create({ data: {
        id: organizationId, name: `Synthetic research studio ${tenant}`, slug: `synthetic-studio-${tenant}`,
        industry: ['Developer tools', 'Retail operations', 'Construction technology'][tenant - 1],
        subscription: { create: { id: id(`subscription:${tenant}`), planId: 'free' } },
      } });
      for (let member = 1; member <= 8; member++) {
        const userId = id(`user:${tenant}:${member}`);
        await tx.user.create({ data: { id: userId, email: `analyst-${tenant}-${member}@synthetic.invalid`,
          name: `Synthetic analyst ${tenant}.${member}`, passwordHash, platformAdmin: false } });
        await tx.membership.create({ data: { id: id(`membership:${tenant}:${member}`), organizationId, userId, role: member <= 3 ? 'ANALYST' : 'VIEWER' } });
      }
      for (let project = 1; project <= 8; project++) {
        const projectId = id(`project:${tenant}:${project}`);
        await tx.project.create({ data: { id: projectId, organizationId,
          name: `Synthetic ${['positioning', 'pricing', 'distribution', 'onboarding'][project % 4]} study ${project}`,
          description: 'Synthetic portfolio scenario, authored locally. No external research was performed and these organizations are fictional.',
          industry: 'Synthetic demonstration', targetMarket: 'Fictional SMB research scenario',
        } });
        for (let competitor = 1; competitor <= 6; competitor++) {
          await tx.competitor.create({ data: { id: id(`competitor:${tenant}:${project}:${competitor}`), organizationId, projectId,
            name: `Fictional vendor ${tenant}.${project}.${competitor}`, domain: `vendor-${tenant}-${project}-${competitor}.invalid`,
            classification: 'UNVERIFIED', description: 'Synthetic comparison candidate; not a real business or verified finding.' } });
        }
      }
    }, { timeout: 30000 });
  }
  console.log('Synthetic dataset ready: up to 3 isolated tenants, 24 nonprivileged users, 24 projects, 144 fictional competitors. Existing tenants preserved.');
} finally { await db.$disconnect(); }
