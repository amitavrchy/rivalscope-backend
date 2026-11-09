import { Controller, Get, Inject, Optional, ServiceUnavailableException } from '@nestjs/common';
import { AppService } from './app.service.js';
import { Database } from './database.js';
import { RedisStore } from './redis-store.js';
import { env } from './config.js';

@Controller()
export class AppController {
  constructor(@Inject(AppService) private readonly appService: AppService, @Inject(Database) private readonly db: Database, @Optional() @Inject(RedisStore) private readonly redis?: RedisStore) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
  @Get('health') health() { return { status: 'ok', service: 'rivalscope-api' }; }
  @Get('health/ready') async ready() {
    try {
      await this.db.$queryRaw`SELECT 1`;
      if (env.FREE_PREVIEW === 'true') {
        const heartbeat = await this.redis?.client.get('rs:worker:heartbeat');
        if (!heartbeat || !Number.isFinite(Date.parse(heartbeat)) || Date.now() - Date.parse(heartbeat) > 30000) throw new Error('Worker unavailable');
      }
      return { status: 'ready' };
    } catch { throw new ServiceUnavailableException('A required datastore or preview worker is unavailable'); }
  }
}
