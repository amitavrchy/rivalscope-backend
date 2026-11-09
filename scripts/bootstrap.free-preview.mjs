import { z } from 'zod';
import { hash } from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/generated/prisma/client.js';

if (process.env.FREE_PREVIEW !== 'true' || process.env.ALLOW_PRODUCTION_SEED !== 'true') throw new Error('Preview bootstrap opt-ins required');
const input = z.object({ PREVIEW_LOGIN_EMAIL: z.email().max(254).toLowerCase(), PREVIEW_LOGIN_PASSWORD: z.string().min(16).max(128) }).safeParse(process.env);
if (!input.success) throw new Error('Supply valid private preview login credentials');
const userId = 'f4ee0000-0000-4000-a000-000000000001';
const organizationId = 'f4ee0000-0000-4000-a000-000000000002';
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 2 }) });
try {
  const existing = await db.user.findUnique({ where: { id: userId } });
  if (existing) {
    if (existing.email !== input.data.PREVIEW_LOGIN_EMAIL) throw new Error('Preview identity changed; existing account will not be overwritten');
    console.log('Private preview account preserved; password and business edits unchanged.');
  } else {
    const passwordHash = await hash(input.data.PREVIEW_LOGIN_PASSWORD);
    await db.$transaction(async tx => {
      await tx.user.create({ data: { id: userId, email: input.data.PREVIEW_LOGIN_EMAIL, name: 'Synthetic preview operator', passwordHash, platformAdmin: false } });
      await tx.organization.create({ data: { id: organizationId, name: 'Synthetic interactive preview', slug: 'synthetic-interactive-preview',
        memberships: { create: { id: 'f4ee0000-0000-4000-a000-000000000003', userId, role: 'OWNER' } },
        subscription: { create: { id: 'f4ee0000-0000-4000-a000-000000000004', planId: 'free' } },
      } });
      await tx.creditLedger.create({ data: { organizationId, kind: 'GRANT', amount: 100, balanceAfter: 100, idempotencyKey: 'synthetic-preview-initial-grant' } });
      const studios = await tx.organization.findMany({ where: { slug: { in: ['synthetic-studio-1', 'synthetic-studio-2', 'synthetic-studio-3'] } }, orderBy: { slug: 'asc' } });
      for (const [index, studio] of studios.entries()) await tx.membership.create({ data: {
        id: `f4ee0000-0000-4000-a000-00000000001${index}`, organizationId: studio.id, userId, role: 'VIEWER',
      } });
    });
    console.log('Private preview account created; email remains unverified and platform-admin access is not granted.');
  }
} catch {
  console.error('Preview account bootstrap failed; check credentials or namespace conflicts. No existing account was reset.');
  process.exitCode = 1;
} finally { await db.$disconnect(); }
