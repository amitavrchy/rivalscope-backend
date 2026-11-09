import './instrumentation.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import { AppModule } from './app.module.js';
import { QUEUE_NAME, ResearchService } from './research.js';
import { MONITOR_QUEUE, MonitoringService } from './monitoring.js';
import { redisConnection } from './config.js';
import { MailService } from './mail.js';
import { WebhookService } from './integrations.js';
import { EmbeddingService } from './embeddings.js';
import { NotificationService } from './notifications.js';
import { RedisStore } from './redis-store.js';
import { researchProcessor } from './worker-errors.js';
import { Database } from './database.js';

const app = await NestFactory.createApplicationContext(AppModule);
const research = app.get(ResearchService); const monitoring = app.get(MonitoringService); const mail = app.get(MailService);
const researchWorker = new Worker<{ runId: string }>(QUEUE_NAME, researchProcessor(research,app.get(Database)), { connection: redisConnection(), concurrency: 2, lockDuration: 120_000 });
const monitorWorker = new Worker<{ monitorId: string }>(MONITOR_QUEUE, job => monitoring.execute(job.data.monitorId), { connection: redisConnection(), concurrency: 2 });
for (const worker of [researchWorker, monitorWorker]) worker.on('error', () => process.stderr.write(JSON.stringify({ level: 'error', event: 'worker_connection_error' }) + '\n'));
let busy = false;
let ticks = 0;
const maintenance = async () => {
  if (busy) return; busy = true;
  try { await research.reconcile(); await app.get(NotificationService).deliver(); await mail.deliverPending(); await app.get(WebhookService).deliverPending(); if (ticks++ % 6 === 0) { await monitoring.reconcile(); await app.get(EmbeddingService).indexPending(); } }
  catch { process.stderr.write(JSON.stringify({ level: 'error', event: 'worker_maintenance_failed' }) + '\n'); }
  finally { busy = false; }
};
let inFlight: Promise<void> | undefined;
const timer = setInterval(() => { if (!busy) inFlight = maintenance(); }, 10_000);
const heartbeat = setInterval(() => { void app.get(RedisStore).client.set('rs:worker:heartbeat', new Date().toISOString(), 'EX', 30).catch(() => undefined); }, 5000);
inFlight = maintenance(); await inFlight;
let closing = false;
const shutdown = async () => { if (closing) return; closing = true; clearInterval(timer); clearInterval(heartbeat); await Promise.all([researchWorker.close(), monitorWorker.close(), inFlight]); await app.close(); };
process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
