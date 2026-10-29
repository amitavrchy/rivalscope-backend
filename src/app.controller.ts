import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { AppService } from './app.service.js';
import { Database } from './database.js';

@Controller()
export class AppController {
  constructor(@Inject(AppService) private readonly appService: AppService, @Inject(Database) private readonly db: Database) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
  @Get('health') health() { return { status: 'ok', service: 'rivalscope-api' }; }
  @Get('health/ready') async ready() {
    try { await this.db.$queryRaw`SELECT 1`; return { status: 'ready' }; }
    catch { throw new ServiceUnavailableException('Database unavailable'); }
  }
}
