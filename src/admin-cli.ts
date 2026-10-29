import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

const [command, email] = process.argv.slice(2);
if (!['grant', 'revoke'].includes(command || '') || !email?.includes('@')) throw new Error('Usage: node --import tsx src/admin-cli.ts grant|revoke verified-user@example.com');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
try {
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(915600679)`;
    const user = await tx.user.findUniqueOrThrow({ where: { email: email.toLowerCase() } });
    if (!user.emailVerifiedAt || user.deletedAt) throw new Error('The user must have an active verified account');
    if (command === 'revoke' && user.platformAdmin && await tx.user.count({ where: { platformAdmin: true, deletedAt: null } }) <= 1) throw new Error('Cannot revoke the last platform administrator');
    await tx.user.update({ where: { id: user.id }, data: { platformAdmin: command === 'grant' } });
    await tx.platformAuditLog.create({ data: { actorId: user.id, action: `operator.platform_role_${command}`, resourceId: user.id } });
    console.log(`Platform role ${command} completed for account ${user.id}`);
  });
} finally { await db.$disconnect(); }
