import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { Database } from './database.js';
import { env } from './config.js';
import { encrypt, decrypt } from './encryption.js';
import type { Prisma } from './generated/prisma/client.js';

@Injectable()
export class MailService {
  constructor(@Inject(Database) private readonly db: Database) {}
  async enqueue(tx: Prisma.TransactionClient, recipient: string, subject: string, body: string, idempotencyKey?: string) {
    if (!env.SMTP_URL) throw new ServiceUnavailableException('Email delivery is not configured. Set SMTP_URL.');
    const data = { recipient, subject, encryptedBody: encrypt(body), idempotencyKey };
    if (idempotencyKey) await tx.emailDelivery.upsert({ where: { idempotencyKey }, create: data, update: {} });
    else await tx.emailDelivery.create({ data });
  }
  async deliverPending() {
    if (!env.SMTP_URL) return;
    const transport = nodemailer.createTransport(env.SMTP_URL);
    const pending = await this.db.emailDelivery.findMany({ where: { deliveredAt: null, attempts: { lt: 6 }, nextAttemptAt: { lte: new Date() } }, take: 20 });
    for (const mail of pending) {
      const claimed = await this.db.emailDelivery.updateMany({ where: { id: mail.id, attempts: mail.attempts, deliveredAt: null }, data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 2 ** (mail.attempts + 1) * 60_000) } });
      if (!claimed.count) continue;
      try {
        await transport.sendMail({ from: env.MAIL_FROM, to: mail.recipient, subject: mail.subject, text: decrypt(mail.encryptedBody) });
        await this.db.emailDelivery.update({ where: { id: mail.id }, data: { deliveredAt: new Date(), encryptedBody: '' } });
      } catch { process.stderr.write(JSON.stringify({ level: 'warn', event: 'email_delivery_failed', deliveryId: mail.id }) + '\n'); }
    }
    transport.close();
  }
}
