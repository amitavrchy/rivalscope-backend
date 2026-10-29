import { planLimit } from './entitlements.js';
import { BadRequestException, Body, Controller, Get, Inject, Injectable, Param, Post, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import Stripe from 'stripe';
import { z } from 'zod';
import { Database } from './database.js';
import { env } from './config.js';
import { SessionGuard, TenantPolicy } from './security.js';
import type { ActorRequest } from './security.js';
import { uuid } from './organizations.js';
import { lockOrganization } from './credits.js';
import { MockBillingAdapter } from './mock-billing.js';
import { timingSafeEqual } from 'node:crypto';

@Injectable()
export class BillingService {
  constructor(@Inject(Database) private readonly db: Database, @Inject(MockBillingAdapter) private readonly mock: MockBillingAdapter) {}
  stripe() { if (!env.STRIPE_SECRET_KEY) throw new ServiceUnavailableException('Stripe billing is not configured. Set STRIPE_SECRET_KEY and plan price IDs.'); return new Stripe(env.STRIPE_SECRET_KEY, { timeout: 20_000, maxNetworkRetries: 2 }); }
  async checkout(organizationId: string, input: unknown) {
    const { planId, interval } = z.object({ planId: z.enum(['starter', 'pro', 'agency', 'enterprise']), interval: z.enum(['monthly', 'annual']) }).strict().parse(input);
    if (env.BILLING_PROVIDER === 'mock') return this.mock.checkout(organizationId, planId, interval);
    const stripe = this.stripe();
    const plan = await this.db.plan.findFirstOrThrow({ where: { id: planId, enabled: true } });
    const price = interval === 'monthly' ? plan.stripeMonthlyPriceId : plan.stripeAnnualPriceId;
    if (!price) throw new ServiceUnavailableException('This plan has no configured Stripe price. Ask your administrator to configure it.');
    const sub = await this.db.subscription.findUniqueOrThrow({ where: { organizationId } });
    if (sub.stripeSubscriptionId && ['active', 'trialing', 'past_due'].includes(sub.status)) return this.portal(organizationId);
    const customerId = sub.stripeCustomerId ?? (await stripe.customers.create({ metadata: { organizationId } }, { idempotencyKey: `customer-${organizationId}` })).id;
    await this.db.subscription.update({ where: { organizationId }, data: { stripeCustomerId: customerId } });
    const trial = plan.trialDays > 0 ? await this.db.subscription.updateMany({ where: { organizationId, trialStartedAt: null }, data: { trialStartedAt: new Date() } }) : { count: 0 };
    const session = await stripe.checkout.sessions.create({ mode: 'subscription', customer: customerId, line_items: [{ price, quantity: 1 }], client_reference_id: organizationId, subscription_data: { metadata: { organizationId }, ...(trial.count ? { trial_period_days: plan.trialDays } : {}) }, success_url: `${env.APP_ORIGIN}/workspace/billing?org=${organizationId}&checkout=complete`, cancel_url: `${env.APP_ORIGIN}/workspace/billing?org=${organizationId}` });
    if (!session.url) throw new ServiceUnavailableException('Stripe did not return a hosted checkout URL');
    return { url: session.url };
  }
  async addon(organizationId: string, packId: string) {
    const pack = await this.db.creditPack.findFirstOrThrow({ where: { id: z.string().min(1).max(80).parse(packId), enabled: true } });
    if (env.BILLING_PROVIDER === 'mock') this.mock.guard();
    else if (!pack.stripePriceId) throw new ServiceUnavailableException('Configure this credit pack’s Stripe price first');
    const purchase = await this.db.creditPurchase.create({ data: { organizationId, packId: pack.id, credits: pack.credits, amountCents: pack.amountCents, currency: pack.currency.toLowerCase(), provider: env.BILLING_PROVIDER, expiresAt: new Date(Date.now() + 3600000) } });
    if (env.BILLING_PROVIDER === 'mock') return { url: `${env.APP_ORIGIN}/workspace/billing?org=${organizationId}&sandboxPurchase=${purchase.id}`, sandbox: true };
    const stripe = this.stripe(); const sub = await this.db.subscription.findUniqueOrThrow({ where: { organizationId } });
    const customer = sub.stripeCustomerId ?? (await stripe.customers.create({ metadata: { organizationId } }, { idempotencyKey: `customer-${organizationId}` })).id;
    await this.db.subscription.update({ where: { organizationId }, data: { stripeCustomerId: customer } });
    const price = await stripe.prices.retrieve(pack.stripePriceId!);
    if (price.recurring || price.unit_amount !== pack.amountCents || price.currency !== pack.currency.toLowerCase()) throw new BadRequestException('Credit pack price does not match the configured one-time Stripe price');
    const session = await stripe.checkout.sessions.create({ mode: 'payment', customer, line_items: [{ price: price.id, quantity: 1 }], metadata: { creditPurchaseId: purchase.id, organizationId }, expires_at: Math.floor(purchase.expiresAt.getTime() / 1000), success_url: `${env.APP_ORIGIN}/workspace/billing?org=${organizationId}&checkout=complete`, cancel_url: `${env.APP_ORIGIN}/workspace/billing?org=${organizationId}` }, { idempotencyKey: `credit-purchase-${purchase.id}` });
    await this.db.creditPurchase.update({ where: { id: purchase.id }, data: { providerSessionId: session.id } }); if (!session.url) throw new ServiceUnavailableException('Stripe did not return a hosted checkout URL'); return { url: session.url };
  }
  async fulfillAddon(purchaseId: string, provider: string, sessionId: string | null, eventId: string, amount: number, currency: string) {
    return this.db.$transaction(async tx => {
      const purchase = await tx.creditPurchase.findUniqueOrThrow({ where: { id: z.uuid().parse(purchaseId) } }); const org = await lockOrganization(tx, purchase.organizationId);
      if (await tx.paymentEvent.findUnique({ where: { id: eventId } }) || (await tx.creditPurchase.findUniqueOrThrow({ where: { id: purchase.id } })).status === 'completed') return;
      if (org.deletedAt || purchase.provider !== provider || purchase.providerSessionId !== sessionId || amount !== purchase.amountCents || currency !== purchase.currency) throw new BadRequestException('Credit purchase payment does not match its order');
      await tx.organization.update({ where: { id: org.id }, data: { credits: { increment: purchase.credits } } });
      await tx.creditLedger.create({ data: { organizationId: org.id, idempotencyKey: `credit-purchase-${purchase.id}`, kind: 'GRANT', amount: purchase.credits, balanceAfter: org.credits + purchase.credits, referenceId: purchase.id } });
      await tx.creditPurchase.update({ where: { id: purchase.id }, data: { status: 'completed', completedAt: new Date() } });
      await tx.paymentEvent.create({ data: { id: eventId, organizationId: org.id, type: `${provider}.credit_purchase_paid` } });
      await tx.auditLog.create({ data: { organizationId: org.id, actorId: `${provider}-webhook`, action: 'billing.credits_purchased', resourceId: purchase.id } });
    });
  }
  async completeSandboxAddon(organizationId: string, purchaseId: string) {
    this.mock.guard(); const order = await this.db.creditPurchase.findFirstOrThrow({ where: { id: z.uuid().parse(purchaseId), organizationId, provider: 'mock' } });
    if (order.expiresAt <= new Date() && order.status !== 'completed') throw new BadRequestException('Sandbox purchase expired');
    const body = JSON.stringify({ purchaseId: order.id, amount: order.amountCents, currency: order.currency });
    await this.sandboxAddonEvent(body, this.mock.signature(body)); return { message: 'Development sandbox credits granted. No real payment was made.' };
  }
  async sandboxAddonEvent(body: string, signature: string) {
    const expected = Buffer.from(this.mock.signature(body), 'hex'); const actual = /^[a-f0-9]{64}$/i.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BadRequestException('Invalid sandbox credit purchase signature');
    const event = z.object({ purchaseId: z.uuid(), amount: z.number().int(), currency: z.string() }).strict().parse(JSON.parse(body));
    return this.fulfillAddon(event.purchaseId, 'mock', null, `mock-purchase-${event.purchaseId}`, event.amount, event.currency);
  }
  async changePlan(organizationId: string, input: unknown) {
    const data = z.object({ planId: z.enum(['starter','pro','agency','enterprise']), interval: z.enum(['monthly','annual']) }).strict().parse(input);
    if (env.BILLING_PROVIDER === 'mock') return this.mock.checkout(organizationId, data.planId, data.interval);
    const sub = await this.db.subscription.findUniqueOrThrow({ where: { organizationId } });
    if (!sub.stripeSubscriptionId) throw new BadRequestException('Start a subscription before changing plans');
    const plan = await this.db.plan.findFirstOrThrow({ where: { id: data.planId, enabled: true } }); const price = data.interval === 'monthly' ? plan.stripeMonthlyPriceId : plan.stripeAnnualPriceId;
    if (!price) throw new ServiceUnavailableException('Configure the selected Stripe price first');
    const stripe = this.stripe(); const subscription = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId); const item = subscription.items.data[0]; if (!item) throw new BadRequestException('Subscription has no plan');
    await stripe.subscriptions.update(subscription.id, { items: [{ id: item.id, price }], proration_behavior: 'always_invoice', payment_behavior: 'pending_if_incomplete' });
    return { message: 'Plan change submitted with Stripe proration. Payment confirmation and verified webhooks determine activation. Open the billing portal if payment needs attention.' };
  }
  async portal(organizationId: string) {
    if (env.BILLING_PROVIDER === 'mock') return { url: `${env.APP_ORIGIN}/workspace/billing?org=${organizationId}&sandboxManage=1`, sandbox: true };
    const stripe = this.stripe();
    const sub = await this.db.subscription.findUniqueOrThrow({ where: { organizationId } });
    if (!sub.stripeCustomerId) throw new BadRequestException('No Stripe billing customer exists yet');
    return { url: (await stripe.billingPortal.sessions.create({ customer: sub.stripeCustomerId, return_url: `${env.APP_ORIGIN}/workspace/billing?org=${organizationId}` })).url };
  }
  async webhook(rawBody: Buffer | undefined, signature: string | undefined) {
    if (!env.STRIPE_WEBHOOK_SECRET) throw new ServiceUnavailableException('Stripe webhook signing is not configured');
    const stripe = this.stripe(); let event: Stripe.Event;
    try { if (!rawBody || !signature) throw new Error(); event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET); }
    catch { throw new BadRequestException('Invalid webhook signature'); }
    if (await this.db.paymentEvent.findUnique({ where: { id: event.id } })) return { received: true };
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      const session = await stripe.checkout.sessions.retrieve((event.data.object as Stripe.Checkout.Session).id);
      if (session.mode !== 'payment' || session.payment_status !== 'paid' || !session.metadata?.creditPurchaseId) return { received: true };
      const purchase = await this.db.creditPurchase.findUniqueOrThrow({ where: { id: z.uuid().parse(session.metadata.creditPurchaseId) } });
      const sub = await this.db.subscription.findUniqueOrThrow({ where: { organizationId: purchase.organizationId } });
      if (session.customer !== sub.stripeCustomerId) throw new BadRequestException('Billing customer mismatch');
      await this.fulfillAddon(purchase.id, 'stripe', session.id, event.id, session.amount_total ?? -1, session.currency ?? ''); return { received: true };
    }
    let subId: string | undefined; let invoice: Stripe.Invoice | undefined;
    if (event.type.startsWith('customer.subscription.')) subId = (event.data.object as Stripe.Subscription).id;
    else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      invoice = event.data.object as Stripe.Invoice;
      const subscription = invoice.parent?.subscription_details?.subscription;
      subId = typeof subscription === 'string' ? subscription : subscription?.id;
    }
    if (!subId) return { received: true };
    // Fetch the authoritative current subscription so delayed/out-of-order events cannot restore stale state.
    const subscription = await stripe.subscriptions.retrieve(subId);
    const organizationId = subscription.metadata.organizationId;
    if (!organizationId || !z.uuid().safeParse(organizationId).success) return { received: true };
    const item = subscription.items.data[0];
    if (!item) throw new BadRequestException('Subscription has no plan');
    const priceId = item.price.id;
    const plan = await this.db.plan.findFirst({ where: { OR: [{ stripeMonthlyPriceId: priceId }, { stripeAnnualPriceId: priceId }] }, include: { entitlements: true } });
    if (!plan) throw new BadRequestException('Subscription price is not configured in RivalScope');
    await this.db.$transaction(async tx => {
      const org = await lockOrganization(tx, organizationId);
      if (await tx.paymentEvent.findUnique({ where: { id: event.id } })) return;
      const current = await tx.subscription.findUniqueOrThrow({ where: { organizationId } });
      const customer = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
      if (current.stripeCustomerId !== customer) throw new BadRequestException('Billing customer mismatch');
      // Never let a cancelled older subscription replace a newer active one.
      if (current.stripeSubscriptionId && current.stripeSubscriptionId !== subId && subscription.status === 'canceled') return;
      const graceEndsAt = subscription.status === 'past_due' ? current.graceEndsAt ?? new Date(event.created * 1000 + env.BILLING_GRACE_DAYS * 86400000) : null;
      await tx.subscription.update({ where: { organizationId }, data: { stripeSubscriptionId: subId, planId: plan.id, status: subscription.status, currentPeriodEnd: item.current_period_end ? new Date(item.current_period_end * 1000) : null, graceEndsAt } });
      await tx.paymentEvent.create({ data: { id: event.id, organizationId, type: event.type } });
      if (invoice) {
        const record = { organizationId, number: invoice.number, status: invoice.status ?? 'unknown', currency: invoice.currency, amountPaid: invoice.amount_paid, hostedInvoiceUrl: invoice.hosted_invoice_url, issuedAt: new Date(invoice.created * 1000) };
        await tx.invoice.upsert({ where: { providerId: invoice.id }, create: { providerId: invoice.id, ...record }, update: record });
      }
      if (invoice && event.type === 'invoice.paid' && invoice.status === 'paid' && invoice.amount_paid > 0 && ['subscription_create', 'subscription_cycle'].includes(invoice.billing_reason ?? '')) {
        const idempotencyKey = `invoice-${invoice.id}`;
        if (!await tx.creditLedger.findUnique({ where: { idempotencyKey } })) {
          const annual = priceId === plan.stripeAnnualPriceId;
          const amount = planLimit(plan, 'monthlyCredits') * (annual ? 12 : 1);
          await tx.organization.update({ where: { id: organizationId }, data: { credits: { increment: amount } } });
          await tx.creditLedger.create({ data: { organizationId, idempotencyKey, kind: 'GRANT', amount, balanceAfter: org.credits + amount, referenceId: invoice.id } });
        }
      }
      await tx.auditLog.create({ data: { organizationId, actorId: 'stripe-webhook', action: `billing.${event.type}`, resourceId: event.id } });
    });
    return { received: true };
  }
}

@Controller('billing')
export class BillingPublicController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(BillingService) private readonly billing: BillingService) {}
  @Get('plans') plans() { return this.db.plan.findMany({ where: { enabled: true }, orderBy: { monthlyPriceCents: 'asc' } }); }
  @Get('credit-packs') packs() { return this.db.creditPack.findMany({ where: { enabled: true }, select: { id: true, name: true, credits: true, amountCents: true, currency: true }, orderBy: { amountCents: 'asc' } }); }
  @Get('status') status() { return { provider: env.BILLING_PROVIDER, sandbox: env.BILLING_PROVIDER === 'mock', configured: env.BILLING_PROVIDER === 'mock' ? !!env.MOCK_BILLING_WEBHOOK_SECRET : !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET }; }
  @Post('webhook') webhook(@Req() req: Request & { rawBody?: Buffer }) { return this.billing.webhook(req.rawBody, req.headers['stripe-signature'] as string | undefined); }
}
@Controller('organizations/:orgId/billing')
@UseGuards(SessionGuard)
export class BillingController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(BillingService) private readonly billing: BillingService, @Inject(TenantPolicy) private readonly policy: TenantPolicy, @Inject(MockBillingAdapter) private readonly mock: MockBillingAdapter) {}
  @Post('sandbox/complete') async sandboxComplete(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Body() input: unknown) { await this.policy.authorize(req.actor.id, uuid(orgId), 'billing'); const data = z.object({ checkoutId: z.uuid() }).strict().parse(input); return this.mock.complete(orgId, data.checkoutId); }
  @Post('sandbox/complete-addon') async sandboxAddon(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Body() input: unknown) { await this.policy.authorize(req.actor.id, uuid(orgId), 'billing'); const data = z.object({ purchaseId: z.uuid() }).strict().parse(input); return this.billing.completeSandboxAddon(orgId, data.purchaseId); }
  @Post('credit-packs/checkout') async addon(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Body() input: unknown) { await this.policy.authorize(req.actor.id, uuid(orgId), 'billing'); if (!req.actor.verified) throw new BadRequestException('Verify your email before purchasing'); const data = z.object({ packId: z.string().min(1).max(80) }).strict().parse(input); return this.billing.addon(orgId, data.packId); }
  @Post('change-plan') async change(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Body() input: unknown) { await this.policy.authorize(req.actor.id, uuid(orgId), 'billing'); return this.billing.changePlan(orgId, input); }
  @Get('purchases') async purchases(@Req() req: ActorRequest, @Param('orgId') orgId: string) { await this.policy.authorize(req.actor.id, uuid(orgId), 'billing'); return this.db.creditPurchase.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, credits: true, amountCents: true, currency: true, status: true, createdAt: true, completedAt: true, provider: true } }); }
  @Post('sandbox/cancel') async sandboxCancel(@Req() req: ActorRequest, @Param('orgId') orgId: string) { await this.policy.authorize(req.actor.id, uuid(orgId), 'billing'); return this.mock.cancel(orgId); }
  @Post('checkout') async checkout(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Body() input: unknown) { await this.policy.authorize(req.actor.id, uuid(orgId), 'billing'); if (!req.actor.verified) throw new BadRequestException('Verify your email before purchasing'); return this.billing.checkout(orgId, input); }
  @Post('portal') async portal(@Req() req: ActorRequest, @Param('orgId') orgId: string) { await this.policy.authorize(req.actor.id, uuid(orgId), 'billing'); return this.billing.portal(orgId); }
  @Get('invoices') async invoices(@Req() req: ActorRequest, @Param('orgId') orgId: string) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'billing');
    if (env.BILLING_PROVIDER === 'mock') return this.db.invoice.findMany({ where: { organizationId: orgId }, orderBy: { issuedAt: 'desc' }, take: 50 });
    const stripe = this.billing.stripe(); const sub = await this.db.subscription.findUniqueOrThrow({ where: { organizationId: orgId } });
    if (!sub.stripeCustomerId) return [];
    return (await stripe.invoices.list({ customer: sub.stripeCustomerId, limit: 50 })).data.map(i => ({ id: i.id, number: i.number, status: i.status, currency: i.currency, amountPaid: i.amount_paid, createdAt: new Date(i.created * 1000), hostedInvoiceUrl: i.hosted_invoice_url }));
  }
}
