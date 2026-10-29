import { Controller, ForbiddenException, Get, Inject, Injectable } from '@nestjs/common';
import { Database } from './database.js';

@Injectable()
export class OperationPolicy {
  constructor(@Inject(Database) private readonly db: Database) {}
  async requireFeature(id: string) { const flag = await this.db.featureFlag.findUnique({ where: { id } }); if (flag && !flag.enabled) throw new ForbiddenException(`${id.replaceAll('_', ' ')} is temporarily disabled by the platform operator`); }
}
@Controller('system')
export class PublicSettingsController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get('public') async publicSettings() { const settings = await this.db.systemSetting.findMany({ where: { id: { in: ['announcement', 'support_email'] } } }); return Object.fromEntries(settings.map(s => [s.id, s.value])); }
}
