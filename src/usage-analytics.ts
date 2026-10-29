import { Controller,Get,Inject,Injectable,Param,Req,UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Database } from './database.js';
import { SessionGuard,TenantPolicy } from './security.js';
import type { ActorRequest } from './security.js';
@Injectable()
export class UsageAnalytics {
  constructor(@Inject(Database)private readonly db:Database){}
  async refresh(organizationId:string){
    const rows=await this.db.$queryRaw<{period:Date;units:bigint}[]>`SELECT DATE("createdAt") AS period,SUM(units)::bigint AS units FROM "UsageEvent" WHERE "organizationId"=${organizationId}::uuid AND "createdAt">=NOW()-INTERVAL '30 days' GROUP BY DATE("createdAt")`;
    for(const row of rows)await this.db.metric.upsert({where:{organizationId_name_period:{organizationId,name:'consumed_credits',period:row.period}},create:{organizationId,name:'consumed_credits',period:row.period,value:Number(row.units)},update:{value:Number(row.units)}});
  }
}
@Controller('organizations/:orgId/usage')
@UseGuards(SessionGuard)
export class UsageController{
  constructor(@Inject(Database)private readonly db:Database,@Inject(TenantPolicy)private readonly policy:TenantPolicy,@Inject(UsageAnalytics)private readonly analytics:UsageAnalytics){}
  @Get('events')async events(@Req()req:ActorRequest,@Param('orgId')orgId:string){await this.policy.authorize(req.actor.id,z.uuid().parse(orgId),'billing');return this.db.usageEvent.findMany({where:{organizationId:orgId},orderBy:{createdAt:'desc'},take:100});}
  @Get('metrics')async metrics(@Req()req:ActorRequest,@Param('orgId')orgId:string){await this.policy.authorize(req.actor.id,z.uuid().parse(orgId),'billing');await this.analytics.refresh(orgId);return this.db.metric.findMany({where:{organizationId:orgId,period:{gte:new Date(Date.now()-30*86400000)}},orderBy:{period:'asc'}});}
}
