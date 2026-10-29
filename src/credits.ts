import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Database } from './database.js';
import type { Prisma } from './generated/prisma/client.js';

export async function lockOrganization(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId}::uuid FOR UPDATE`;
  return tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
}

@Injectable()
export class CreditsService {
  constructor(@Inject(Database) private readonly db: Database) {}
  async reserve(tx: Prisma.TransactionClient, organizationId: string, runId: string, amount: number) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Invalid reservation');
    const org = await lockOrganization(tx, organizationId);
    if (org.credits - org.reservedCredits < amount) throw new ForbiddenException('Insufficient available research credits');
    await tx.organization.update({ where: { id: organizationId }, data: { reservedCredits: { increment: amount } } });
    await tx.creditLedger.create({ data: { organizationId, idempotencyKey: `reserve-${runId}`, kind: 'RESERVE', amount: -amount, balanceAfter: org.credits, referenceId: runId } });
  }
  async settle(tx: Prisma.TransactionClient, organizationId: string, runId: string, consumed: number) {
    const org = await lockOrganization(tx, organizationId);
    if (await tx.creditLedger.findUnique({ where: { idempotencyKey: `settle-${runId}` } })) return;
    const run = await tx.researchRun.findFirstOrThrow({ where: { id: runId, organizationId } });
    if (!Number.isSafeInteger(consumed) || consumed < 0 || consumed > run.reservedCredits) throw new Error('Consumption exceeds reservation');
    await tx.organization.update({ where: { id: organizationId }, data: { credits: { decrement: consumed }, reservedCredits: { decrement: run.reservedCredits } } });
    const settlement = await tx.creditLedger.create({ data: { organizationId, idempotencyKey: `settle-${runId}`, kind: 'SETTLE', amount: -consumed, balanceAfter: org.credits - consumed, referenceId: runId } });
    await tx.usageEvent.create({ data: { organizationId, ledgerId: settlement.id, category: 'RESEARCH', units: consumed, referenceId: runId } });
    if (consumed < run.reservedCredits) await tx.creditLedger.create({ data: { organizationId, idempotencyKey: `release-${runId}`, kind: 'RELEASE', amount: run.reservedCredits - consumed, balanceAfter: org.credits - consumed, referenceId: runId } });
    await tx.researchRun.update({ where: { id: runId }, data: { consumedCredits: consumed } });
  }
}
