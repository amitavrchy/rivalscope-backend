import { planLimit } from './entitlements.js';
import { BadRequestException, ForbiddenException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Database } from './database.js';
import { env } from './config.js';
import { lockOrganization } from './credits.js';

@Injectable()
export class MockBillingAdapter {
  constructor(@Inject(Database) private readonly db: Database) {}
  guard() { if (env.NODE_ENV === 'production' || env.BILLING_PROVIDER !== 'mock') throw new ForbiddenException('Development mock billing is not enabled'); if (!env.MOCK_BILLING_WEBHOOK_SECRET) throw new ServiceUnavailableException('Set MOCK_BILLING_WEBHOOK_SECRET for development sandbox billing'); }
  signature(body: string) { this.guard(); return createHmac('sha256', env.MOCK_BILLING_WEBHOOK_SECRET!).update(body).digest('hex'); }
  async checkout(organizationId: string, planId: string, interval: string) {
    this.guard(); await this.db.plan.findFirstOrThrow({ where: { id: planId, enabled: true } });
    const checkout = await this.db.billingCheckout.create({ data: { organizationId, provider: 'mock', planId, interval, expiresAt: new Date(Date.now() + 3600000) } });
    return { url: `${env.APP_ORIGIN}/workspace/billing?org=${organizationId}&sandboxCheckout=${checkout.id}`, sandbox: true };
  }
  async complete(organizationId: string, checkoutId: string) {
    this.guard(); const checkout = await this.db.billingCheckout.findFirst({ where: { id: z.uuid().parse(checkoutId), organizationId, provider: 'mock' } });
    if (!checkout || checkout.expiresAt <= new Date()) throw new BadRequestException('Sandbox checkout is unavailable or expired');
    const body = JSON.stringify({ eventId: `mock-${checkout.id}`, checkoutId, organizationId });
    return this.webhook(body, this.signature(body));
  }
  async webhook(body: string, signature: string) {
    const expected = Buffer.from(this.signature(body), 'hex'); const supplied = /^[a-f0-9]{64}$/i.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0);
    if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) throw new BadRequestException('Invalid sandbox event signature');
    const event = z.object({ eventId: z.string(), checkoutId: z.uuid(), organizationId: z.uuid() }).strict().parse(JSON.parse(body));
    await this.db.$transaction(async tx => {
      const org = await lockOrganization(tx, event.organizationId);
      if (await tx.paymentEvent.findUnique({ where: { id: event.eventId } })) return;
      const checkout = await tx.billingCheckout.findFirstOrThrow({ where: { id: event.checkoutId, organizationId: event.organizationId, provider: 'mock' } });
      if (checkout.expiresAt <= new Date() || checkout.status !== 'pending') throw new BadRequestException('Sandbox checkout is not pending');
      const plan = await tx.plan.findUniqueOrThrow({ where: { id: checkout.planId }, include: { entitlements: true } }); const amount = planLimit(plan, 'monthlyCredits') * (checkout.interval === 'annual' ? 12 : 1);
      await tx.subscription.update({ where: { organizationId: org.id }, data: { planId: plan.id, status: 'active', currentPeriodEnd: new Date(Date.now() + (checkout.interval === 'annual' ? 365 : 30) * 86400_000) } });
      await tx.organization.update({ where: { id: org.id }, data: { credits: { increment: amount } } });
      await tx.creditLedger.create({ data: { organizationId: org.id, kind: 'GRANT', amount, balanceAfter: org.credits + amount, referenceId: checkout.id, idempotencyKey: `mock-checkout-${checkout.id}` } });
      await tx.paymentEvent.create({ data: { id: event.eventId, organizationId: org.id, type: 'sandbox.invoice_paid' } });
      await tx.billingCheckout.update({ where: { id: checkout.id }, data: { status: 'completed' } });
      await tx.auditLog.create({ data: { organizationId: org.id, actorId: 'mock-billing', action: 'billing.sandbox_activated', resourceId: checkout.id } });
    }); return { message: 'Development sandbox subscription activated. No real payment was made.' };
  }
  async cancel(organizationId: string) {
    this.guard(); await this.db.$transaction(async tx => { await lockOrganization(tx, organizationId); await tx.subscription.update({ where: { organizationId }, data: { planId: 'free', status: 'active', currentPeriodEnd: null } }); await tx.auditLog.create({ data: { organizationId, actorId: 'mock-billing', action: 'billing.sandbox_cancelled' } }); }); return { message: 'Sandbox subscription cancelled; workspace returned to Free' };
  }
}
