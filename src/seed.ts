import { ROLE_PERMISSIONS } from './rbac.js';
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION_SEED !== 'true') throw new Error('Explicit production seed approval required');
// Initial product configuration, not market claims or competitor demonstration data.
const plans = [
  { id: 'free', name: 'Free', monthlyPriceCents: 0, annualPriceCents: 0, monthlyCredits: 100, projectLimit: 3, seatLimit: 1, monitorLimit: 1 },
  { id: 'starter', name: 'Starter', monthlyPriceCents: 1900, annualPriceCents: 19000, monthlyCredits: 500, projectLimit: 10, seatLimit: 3, monitorLimit: 5 },
  { id: 'pro', name: 'Pro', monthlyPriceCents: 5900, annualPriceCents: 59000, monthlyCredits: 2000, projectLimit: 50, seatLimit: 10, monitorLimit: 25 },
  { id: 'agency', name: 'Agency', monthlyPriceCents: 14900, annualPriceCents: 149000, monthlyCredits: 6000, projectLimit: 200, seatLimit: 30, monitorLimit: 100 },
  { id: 'enterprise', name: 'Enterprise', monthlyPriceCents: 49900, annualPriceCents: 499000, monthlyCredits: 20000, projectLimit: 1000, seatLimit: 100, monitorLimit: 500 },
];
try {
  for (const plan of plans) await db.plan.upsert({ where: { id: plan.id }, create: plan, update: {} });
  await db.creditPack.upsert({ where: { id: 'credits-500' }, create: { id: 'credits-500', name: '500 research credits', credits: 500, amountCents: 1500, currency: 'usd' }, update: {} });
  for (const [role, keys] of Object.entries(ROLE_PERMISSIONS)) for (const key of keys) { const permission=await db.permission.upsert({where:{key},create:{key,description:`Workspace ${key} permission`},update:{}}); await db.rolePermission.upsert({where:{role_permissionId:{role:role as keyof typeof ROLE_PERMISSIONS,permissionId:permission.id}},create:{role:role as keyof typeof ROLE_PERMISSIONS,permissionId:permission.id},update:{}}); }
  for (const plan of await db.plan.findMany()) for (const key of ['monthlyCredits','projectLimit','seatLimit','monitorLimit'] as const) await db.entitlement.upsert({where:{planId_key:{planId:plan.id,key}},create:{planId:plan.id,key,value:plan[key]},update:{}});
  console.log('Five configurable subscription plans are seeded. Existing plan edits preserved.');
} finally { await db.$disconnect(); }
