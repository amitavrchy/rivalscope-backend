import { Controller, Get, Inject, Injectable, Req, Res, UseGuards, ForbiddenException } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { SessionGuard } from './security.js';
import type { ActorRequest } from './security.js';
import { Database } from './database.js';
import { RedisStore } from './redis-store.js';
import { env } from './config.js';

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, { count: number; duration: number }>();
  middleware(req: Request, res: Response, next: NextFunction) {
    const requestId = randomUUID(); const start = performance.now(); res.setHeader('X-Request-ID', requestId);
    res.on('finish', () => {
      const route = typeof req.route?.path === 'string' ? req.route.path : 'unmatched';
      const key = `method="${req.method}",route="${route.replaceAll('"', '')}",status="${res.statusCode}"`;
      const duration = (performance.now() - start) / 1000; const current = this.counters.get(key) ?? { count: 0, duration: 0 }; current.count++; current.duration += duration; this.counters.set(key, current);
      if (env.NODE_ENV !== 'test') process.stdout.write(JSON.stringify({ level: res.statusCode >= 500 ? 'error' : 'info', event: 'http_request', method: req.method, route, status: res.statusCode, durationMs: Math.round(duration * 1000), requestId }) + '\n');
    }); next();
  }
  render() { return ['# TYPE rivalscope_http_requests_total counter', '# TYPE rivalscope_http_duration_seconds_sum counter', ...[...this.counters.entries()].flatMap(([labels, value]) => [`rivalscope_http_requests_total{${labels}} ${value.count}`, `rivalscope_http_duration_seconds_sum{${labels}} ${value.duration.toFixed(6)}`]), ''].join('\n'); }
}
@Controller('admin/diagnostics')
@UseGuards(SessionGuard)
export class DiagnosticsController {
  constructor(@Inject(MetricsService) private readonly metrics: MetricsService, @Inject(Database) private readonly db: Database, @Inject(RedisStore) private readonly redis: RedisStore) {}
  private check(req: ActorRequest) { if (!req.actor.platformAdmin || !req.actor.verified) throw new ForbiddenException('Verified platform administrator access required'); }
  @Get('metrics') metricsEndpoint(@Req() req: ActorRequest, @Res() res: Response) { this.check(req); return res.type('text/plain; version=0.0.4').send(this.metrics.render()); }
  @Get() async diagnostics(@Req() req: ActorRequest) {
    this.check(req); const [worker, emailsPending, emailsFailed, webhooksFailed, notificationsFailed] = await Promise.all([this.redis.client.get('rs:worker:heartbeat'), this.db.emailDelivery.count({ where: { deliveredAt: null, attempts: { lt: 6 } } }), this.db.emailDelivery.count({ where: { deliveredAt: null, attempts: { gte: 6 } } }), this.db.webhookDelivery.count({ where: { status: 'dead_letter' } }), this.db.notificationDelivery.count({ where: { status: 'dead_letter' } })]);
    return { workerLastSeen: worker, workerHealthy: !!worker, emailsPending, emailsFailed, webhooksFailed, notificationsFailed, metricsUrl: '/api/admin/diagnostics/metrics' };
  }
  @Get('deliveries') async deliveries(@Req() req: ActorRequest) { this.check(req); return this.db.emailDelivery.findMany({ take: 100, orderBy: { createdAt: 'desc' }, select: { id: true, subject: true, attempts: true, deliveredAt: true, nextAttemptAt: true, createdAt: true } }); }
}
