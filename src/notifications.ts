import { Body, Controller, Delete, ForbiddenException, Get, Inject, Injectable, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Database } from './database.js';
import { SessionGuard, TenantPolicy, can } from './security.js';
import type { ActorRequest } from './security.js';
import { MailService } from './mail.js';
import { decrypt, encrypt } from './encryption.js';
import { safeRequest, validatePublicUrl } from './safe-http.js';

@Injectable()
export class NotificationService {
  constructor(@Inject(Database) private readonly db: Database, @Inject(MailService) private readonly mail: MailService) {}
  async deliver() {
    const notifications = await this.db.notification.findMany({ where: { dispatchPlannedAt: null }, orderBy: { createdAt: 'asc' }, take: 100 });
    for (const notification of notifications) {
      const integrations = await this.db.integration.findMany({ where: { organizationId: notification.organizationId, provider: { in: ['slack', 'discord'] } } });
      const preferences = await this.db.notificationPreference.findMany({ where: { organizationId: notification.organizationId, emailEnabled: true, frequency: 'INSTANT', createdAt: { lte: notification.createdAt } }, include: { user: { include: { memberships: { where: { organizationId: notification.organizationId } } } } } });
      for (const integration of integrations) await this.db.notificationDelivery.upsert({ where: { notificationId_channel_recipient: { notificationId: notification.id, channel: integration.provider, recipient: integration.id } }, create: { organizationId: notification.organizationId, notificationId: notification.id, channel: integration.provider, recipient: integration.id }, update: {} });
      for (const pref of preferences) {
        if (!pref.user.emailVerifiedAt || pref.user.deletedAt || !pref.user.memberships.some(m => can(m.role, 'read'))) continue;
        await this.db.$transaction(async tx => {
          await this.mail.enqueue(tx, pref.user.email, notification.title, notification.body, `notification-${notification.id}-${pref.userId}`);
        });
      }
      await this.db.notification.update({ where: { id: notification.id }, data: { dispatchPlannedAt: new Date() } });
    }
    const pending = await this.db.notificationDelivery.findMany({ where: { status: 'pending', nextAttemptAt: { lte: new Date() } }, take: 20, include: { notification: true } });
    for (const delivery of pending) {
      const claimed = await this.db.notificationDelivery.updateMany({ where: { id: delivery.id, attempts: delivery.attempts, status: 'pending' }, data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 2 ** (delivery.attempts + 1) * 60000) } });
      if (!claimed.count) continue;
      try {
        const integration = await this.db.integration.findFirst({ where: { id: delivery.recipient, organizationId: delivery.organizationId, provider: delivery.channel } });
        if (!integration) { await this.db.notificationDelivery.update({ where: { id: delivery.id }, data: { status: 'cancelled' } }); continue; }
        const { url } = z.object({ url: z.url() }).parse(JSON.parse(decrypt(integration.encryptedCredentials)));
        const text = `${delivery.notification.title}\n${delivery.notification.body}`.replaceAll('@', '＠').slice(0, 1800);
        const body = delivery.channel === 'discord' ? { content: text, allowed_mentions: { parse: [] } } : { text };
        const response = await safeRequest(url, { method: 'POST', redirects: 0, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), maxBytes: 100000 });
        if (response.status < 200 || response.status >= 300) throw new Error('Notification receiver rejected delivery');
        await this.db.notificationDelivery.update({ where: { id: delivery.id }, data: { status: 'delivered', deliveredAt: new Date() } });
      } catch { if (delivery.attempts >= 5) await this.db.notificationDelivery.update({ where: { id: delivery.id }, data: { status: 'dead_letter' } }); }
    }
    const digests = await this.db.notificationPreference.findMany({ where: { emailEnabled: true, frequency: { in: ['DAILY', 'WEEKLY'] }, nextDigestAt: { lte: new Date() } }, include: { user: true }, take: 50 });
    for (const pref of digests) {
      const member = await this.db.membership.findUnique({ where: { organizationId_userId: { organizationId: pref.organizationId, userId: pref.userId } } });
      if (!member || !can(member.role, 'read') || !pref.user.emailVerifiedAt || pref.user.deletedAt) continue;
      const items = await this.db.notification.findMany({ where: { organizationId: pref.organizationId, createdAt: { gt: pref.lastDigestAt } }, orderBy: { createdAt: 'desc' }, take: 50 });
      await this.db.$transaction(async tx => {
        const claimed = await tx.notificationPreference.updateMany({ where: { id: pref.id, nextDigestAt: pref.nextDigestAt }, data: { lastDigestAt: new Date(), nextDigestAt: new Date(Date.now() + (pref.frequency === 'DAILY' ? 1 : 7) * 86400_000) } });
        if (claimed.count && items.length) await this.mail.enqueue(tx, pref.user.email, `RivalScope ${pref.frequency.toLowerCase()} digest`, items.map(item => `${item.title}\n${item.body}`).join('\n\n'), `digest-${pref.id}-${pref.nextDigestAt.toISOString()}`);
      });
    }
  }
}

@Controller('organizations/:orgId')
@UseGuards(SessionGuard)
export class NotificationSettingsController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(TenantPolicy) private readonly policy: TenantPolicy) {}
  @Get('notification-preferences') async preferences(@Req() req: ActorRequest, @Param('orgId') orgId: string) { await this.policy.authorize(req.actor.id, z.uuid().parse(orgId)); return await this.db.notificationPreference.findUnique({ where: { organizationId_userId: { organizationId: orgId, userId: req.actor.id } } }) ?? { emailEnabled: false, frequency: 'INSTANT' }; }
  @Post('notification-preferences') async save(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Body() input: unknown) {
    await this.policy.authorize(req.actor.id, z.uuid().parse(orgId)); if (!req.actor.verified) throw new ForbiddenException('Verify your email first');
    const data = z.object({ emailEnabled: z.boolean(), frequency: z.enum(['INSTANT','DAILY','WEEKLY']) }).strict().parse(input); const times = { lastDigestAt: new Date(), nextDigestAt: new Date(Date.now() + (data.frequency === 'WEEKLY' ? 7 : 1) * 86400_000) };
    return this.db.notificationPreference.upsert({ where: { organizationId_userId: { organizationId: orgId, userId: req.actor.id } }, create: { organizationId: orgId, userId: req.actor.id, ...data, ...times }, update: { ...data, ...times } });
  }
  @Get('notification-integrations') async list(@Req() req: ActorRequest, @Param('orgId') orgId: string) { await this.policy.authorize(req.actor.id, z.uuid().parse(orgId), 'integrations'); return this.db.integration.findMany({ where: { organizationId: orgId, provider: { in: ['slack','discord'] } }, select: { id: true, provider: true, createdAt: true } }); }
  @Post('notification-integrations') async connect(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Body() input: unknown) {
    await this.policy.authorize(req.actor.id, z.uuid().parse(orgId), 'integrations');
    const data = z.object({ provider: z.enum(['slack','discord']), url: z.url().max(2048) }).strict().parse(input); const url = validatePublicUrl(data.url);
    if (url.protocol !== 'https:' || (data.provider === 'slack' ? url.hostname !== 'hooks.slack.com' || !url.pathname.startsWith('/services/') : !['discord.com','discordapp.com'].includes(url.hostname) || !url.pathname.startsWith('/api/webhooks/'))) throw new ForbiddenException('Use an official Slack or Discord HTTPS incoming webhook URL');
    await this.db.$transaction(async tx => { await tx.integration.upsert({ where: { organizationId_provider: { organizationId: orgId, provider: data.provider } }, create: { organizationId: orgId, provider: data.provider, encryptedCredentials: encrypt(JSON.stringify({ url: url.href })) }, update: { encryptedCredentials: encrypt(JSON.stringify({ url: url.href })) } }); await tx.auditLog.create({ data: { organizationId: orgId, actorId: req.actor.id, action: 'notification_integration.configured', resourceId: data.provider } }); }); return { message: 'Integration configured. New workspace alerts will be queued for delivery.' };
  }
  @Delete('notification-integrations/:provider') async disconnect(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('provider') provider: string) { await this.policy.authorize(req.actor.id, z.uuid().parse(orgId), 'integrations'); z.enum(['slack','discord']).parse(provider); await this.db.integration.deleteMany({ where: { organizationId: orgId, provider } }); return { message: 'Integration disconnected' }; }
}
