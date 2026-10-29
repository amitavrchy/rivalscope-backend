import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpException, Inject, Injectable, Param, Patch, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { Database } from './database.js';
import { SessionGuard, TenantPolicy, hashToken, newToken } from './security.js';
import type { ActorRequest } from './security.js';
import { uuid } from './organizations.js';
import { env } from './config.js';
import { encrypt, decrypt } from './encryption.js';
import { safeRequest } from './safe-http.js';
import { sourceUrl } from './research-schemas.js';
import type { Prisma } from './generated/prisma/client.js';
import { RedisStore } from './redis-store.js';

@Injectable()
export class WebhookService {
  constructor(@Inject(Database) private readonly db: Database) {}
  async emit(tx: Prisma.TransactionClient, organizationId: string, event: 'research.completed' | 'monitor.changed', eventId: string, data: Record<string, string>) {
    const endpoints = await tx.webhookEndpoint.findMany({ where: { organizationId, enabled: true, events: { has: event } }, take: 20 });
    for (const endpoint of endpoints) await tx.webhookDelivery.upsert({ where: { organizationId_endpointId_eventId: { organizationId, endpointId: endpoint.id, eventId } }, create: { organizationId, endpointId: endpoint.id, eventId, payload: { id: eventId, event, createdAt: new Date().toISOString(), data } }, update: {} });
  }
  async deliverPending() {
    const deliveries = await this.db.webhookDelivery.findMany({ where: { status: 'pending', nextAttemptAt: { lte: new Date() } }, take: 20, include: { endpoint: true } });
    for (const delivery of deliveries) {
      if (!delivery.endpoint.enabled) continue;
      const claimed = await this.db.webhookDelivery.updateMany({ where: { id: delivery.id, attempts: delivery.attempts, status: 'pending' }, data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 2 ** (delivery.attempts + 1) * 60_000) } });
      if (!claimed.count) continue;
      try {
        const body = JSON.stringify(delivery.payload); const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = createHmac('sha256', decrypt(delivery.endpoint.encryptedSecret)).update(`${timestamp}.${body}`).digest('hex');
        const response = await safeRequest(delivery.endpoint.url, { method: 'POST', redirects: 0, body, headers: { 'content-type': 'application/json', 'x-rivalscope-signature': `t=${timestamp},v1=${signature}`, 'x-rivalscope-event-id': delivery.eventId }, maxBytes: 100_000 });
        if (response.status < 200 || response.status >= 300) throw new Error('Receiver rejected delivery');
        await this.db.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'delivered', deliveredAt: new Date() } });
      } catch { if (delivery.attempts + 1 >= 6) await this.db.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'dead_letter' } }); }
    }
  }
}

@Controller('organizations/:orgId')
@UseGuards(SessionGuard)
export class IntegrationsController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(TenantPolicy) private readonly policy: TenantPolicy) {}
  @Get('integrations') async status(@Req() req: ActorRequest, @Param('orgId') orgId: string) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'integrations');
    return { ai: { provider: env.AI_PROVIDER, model: env.AI_PROVIDER === 'gemini' ? env.GEMINI_MODEL : env.OPENAI_MODEL, configured: env.AI_PROVIDER === 'gemini' ? !!env.GEMINI_API_KEY : !!env.OPENAI_API_KEY }, search: { configured: !!env.TAVILY_API_KEY }, billing: { configured: !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET }, apiKeys: await this.db.apiKey.findMany({ where: { organizationId: orgId }, select: { id: true, name: true, prefix: true, scopes: true, expiresAt: true, revokedAt: true }, take: 100 }) };
  }
  @Post('api-keys') async createKey(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Body() input: unknown) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'integrations'); if (!req.actor.verified) throw new ForbiddenException('Verify your email first');
    const data = z.object({ name: z.string().min(2).max(100), scopes: z.array(z.enum(['projects:read', 'reports:read'])).min(1).max(2), days: z.number().int().min(1).max(365).default(90) }).strict().parse(input);
    if (await this.db.apiKey.count({ where: { organizationId: orgId, revokedAt: null } }) >= 20) throw new ForbiddenException('API key limit reached. Revoke unused keys.');
    const key = `rs_live_${newToken()}`;
    const record = await this.db.$transaction(async tx => {
      const record = await tx.apiKey.create({ data: { organizationId: orgId, name: data.name, keyHash: hashToken(key), prefix: key.slice(0, 14), scopes: data.scopes, expiresAt: new Date(Date.now() + data.days * 86400_000) } });
      await tx.auditLog.create({ data: { organizationId: orgId, actorId: req.actor.id, action: 'api_key.created', resourceId: record.id } }); return record;
    }); return { id: record.id, key, expiresAt: record.expiresAt };
  }
  @Delete('api-keys/:id') async revoke(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'integrations');
    await this.db.$transaction([this.db.apiKey.updateMany({ where: { id: uuid(id), organizationId: orgId }, data: { revokedAt: new Date() } }), this.db.auditLog.create({ data: { organizationId: orgId, actorId: req.actor.id, action: 'api_key.revoked', resourceId: id } })]); return { message: 'API key revoked' };
  }
  @Get('api-usage') async usage(@Req() req: ActorRequest, @Param('orgId') orgId: string) { await this.policy.authorize(req.actor.id, uuid(orgId), 'integrations'); return this.db.apiUsage.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: 'desc' }, take: 100 }); }
  @Post('api-keys/:id/rotate') async rotateKey(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'integrations'); const key = `rs_live_${newToken()}`;
    const result = await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${orgId}::uuid FOR UPDATE`;
      const old = await tx.apiKey.findFirstOrThrow({ where: { id: uuid(id), organizationId: orgId, revokedAt: null, expiresAt: { gt: new Date() } } });
      await tx.apiKey.update({ where: { id: old.id }, data: { revokedAt: new Date() } });
      const next = await tx.apiKey.create({ data: { organizationId: orgId, name: old.name, scopes: old.scopes, expiresAt: old.expiresAt, keyHash: hashToken(key), prefix: key.slice(0, 14) } });
      await tx.auditLog.create({ data: { organizationId: orgId, actorId: req.actor.id, action: 'api_key.rotated', resourceId: old.id, details: { replacementId: next.id } } }); return next;
    }); return { id: result.id, key, expiresAt: result.expiresAt };
  }
  @Get('webhooks') async webhooks(@Req() req: ActorRequest, @Param('orgId') orgId: string) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'integrations'); return this.db.webhookEndpoint.findMany({ where: { organizationId: orgId }, select: { id: true, url: true, events: true, enabled: true, deliveries: { take: 20, orderBy: { createdAt: 'desc' }, select: { id: true, attempts: true, status: true, createdAt: true } } } });
  }
  @Post('webhooks') async createWebhook(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Body() input: unknown) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'integrations'); if (!req.actor.verified) throw new ForbiddenException('Verify your email first');
    const data = z.object({ url: sourceUrl.refine(v => new URL(v).protocol === 'https:', 'Webhooks require HTTPS'), events: z.array(z.enum(['research.completed', 'monitor.changed'])).min(1).max(2) }).strict().parse(input);
    if (await this.db.webhookEndpoint.count({ where: { organizationId: orgId } }) >= 20) throw new ForbiddenException('Webhook endpoint limit reached');
    const secret = newToken(); const endpoint = await this.db.$transaction(async tx => { const record = await tx.webhookEndpoint.create({ data: { organizationId: orgId, url: data.url, events: data.events, encryptedSecret: encrypt(secret) } }); await tx.auditLog.create({ data: { organizationId: orgId, actorId: req.actor.id, action: 'webhook.created', resourceId: record.id } }); return record; });
    return { id: endpoint.id, secret, message: 'Copy the signing secret now; it will not be shown again' };
  }
  @Post('webhooks/:id/rotate') async rotateWebhook(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'integrations'); const secret = newToken();
    await this.db.$transaction(async tx => { const endpoint = await tx.webhookEndpoint.findFirstOrThrow({ where: { id: uuid(id), organizationId: orgId } }); await tx.webhookEndpoint.update({ where: { id: endpoint.id }, data: { encryptedSecret: encrypt(secret) } }); await tx.auditLog.create({ data: { organizationId: orgId, actorId: req.actor.id, action: 'webhook.secret_rotated', resourceId: endpoint.id } }); }); return { secret };
  }
  @Patch('webhooks/:id') async enableWebhook(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string, @Body() input: unknown) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'integrations'); const data = z.object({ enabled: z.boolean() }).strict().parse(input);
    await this.db.$transaction(async tx => { const endpoint = await tx.webhookEndpoint.findFirstOrThrow({ where: { id: uuid(id), organizationId: orgId } }); await tx.webhookEndpoint.update({ where: { id: endpoint.id }, data }); await tx.auditLog.create({ data: { organizationId: orgId, actorId: req.actor.id, action: 'webhook.status_changed', resourceId: endpoint.id, details: data } }); }); return { message: 'Webhook status updated' };
  }
  @Delete('webhooks/:id') async disableWebhook(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string) { return this.enableWebhook(req, orgId, id, { enabled: false }); }
  @Post('webhooks/:id/retry/:deliveryId') async retry(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string, @Param('deliveryId') deliveryId: string) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'integrations');
    await this.db.$transaction(async tx => {
      const result = await tx.webhookDelivery.updateMany({ where: { id: uuid(deliveryId), endpointId: uuid(id), organizationId: orgId, status: 'dead_letter', endpoint: { enabled: true } }, data: { attempts: 0, status: 'pending', nextAttemptAt: new Date() } });
      if (!result.count) throw new BadRequestException('Choose a failed delivery on an enabled webhook');
      await tx.auditLog.create({ data: { organizationId: orgId, actorId: req.actor.id, action: 'webhook.delivery_retried', resourceId: deliveryId } });
    }); return { message: 'Delivery queued for retry' };
  }
}

@Controller('v1')
export class PublicApiController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(RedisStore) private readonly redis: RedisStore) {}
  private async key(req: Request, scope: string) {
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    if (!token || token.length > 100) throw new UnauthorizedException('A scoped API key is required');
    const key = await this.db.apiKey.findUnique({ where: { keyHash: hashToken(token) } });
    if (!key || key.revokedAt || key.expiresAt <= new Date()) throw new UnauthorizedException('API key is invalid or expired');
    if (!key.scopes.includes(scope)) throw new ForbiddenException('API key does not have the required scope');
    const usage = await this.redis.increment(`rs:api-key:${key.id}`, 60000);
    if (usage.count > 60) throw new HttpException('API key limit reached. Try again in one minute.', 429);
    await this.db.apiUsage.create({ data: { organizationId: key.organizationId, apiKeyId: key.id, endpoint: scope } }); return key;
  }
  @Get('projects') async projects(@Req() req: Request) { const key = await this.key(req, 'projects:read'); return this.db.tenantRead(key.organizationId, tx => tx.project.findMany({ where: { organizationId: key.organizationId, deletedAt: null }, take: 100, select: { id: true, name: true, description: true, createdAt: true, updatedAt: true } })); }
  @Get('reports') async reports(@Req() req: Request) { const key = await this.key(req, 'reports:read'); return this.db.tenantRead(key.organizationId, tx => tx.report.findMany({ where: { organizationId: key.organizationId, project: { deletedAt: null }, run: { status: 'COMPLETED' } }, take: 100, orderBy: { createdAt: 'desc' } })); }
}
