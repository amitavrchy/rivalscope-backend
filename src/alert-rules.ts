import { Body, Controller, Delete, ForbiddenException, Get, Inject, Injectable, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Database } from './database.js';
import { SessionGuard,TenantPolicy } from './security.js';
import type { ActorRequest } from './security.js';
import type { Prisma } from './generated/prisma/client.js';
import { lockOrganization } from './credits.js';

const normalize=(text:string)=>text.normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
export function phraseMatches(condition:string,phrase:string,previous:string,current:string){const needle=normalize(phrase);const before=normalize(previous).includes(needle),after=normalize(current).includes(needle);return condition==='APPEARED'?!before&&after:condition==='DISAPPEARED'?before&&!after:false;}
export const alertRuleSchema=z.object({monitorId:z.uuid(),name:z.string().trim().min(2).max(100),phrase:z.string().trim().min(2).max(200),condition:z.enum(['APPEARED','DISAPPEARED']),severity:z.enum(['INFO','WARNING','CRITICAL']).default('INFO')}).strict();
@Injectable()
export class AlertService{
  async evaluate(tx:Prisma.TransactionClient,organizationId:string,monitorId:string,change:{id:string;previousText:string;currentText:string},url:string){
    const rules=await tx.alertRule.findMany({where:{organizationId,monitorId,enabled:true},take:50});
    for(const rule of rules){
      if(!phraseMatches(rule.condition,rule.phrase,change.previousText,change.currentText))continue;
      const created=await tx.alert.createMany({data:{organizationId,ruleId:rule.id,changeId:change.id,severity:rule.severity},skipDuplicates:true});
      if(created.count)await tx.notification.create({data:{organizationId,title:`${rule.severity}: ${rule.name}`,body:`Watch phrase ${rule.condition.toLowerCase()}: “${rule.phrase}” on ${url}. This is a literal text rule; review the source snapshot before interpreting its business meaning.`}});
    }
  }
}
@Controller('organizations/:orgId')
@UseGuards(SessionGuard)
export class AlertRulesController{
  constructor(@Inject(Database)private readonly db:Database,@Inject(TenantPolicy)private readonly policy:TenantPolicy){}
  @Get('alert-rules')async rules(@Req()req:ActorRequest,@Param('orgId')orgId:string){await this.policy.authorize(req.actor.id,z.uuid().parse(orgId));return this.db.alertRule.findMany({where:{organizationId:orgId},include:{monitor:{select:{url:true}}},orderBy:{createdAt:'desc'},take:50});}
  @Get('rule-alerts')async alerts(@Req()req:ActorRequest,@Param('orgId')orgId:string){await this.policy.authorize(req.actor.id,z.uuid().parse(orgId));return this.db.alert.findMany({where:{organizationId:orgId},include:{rule:{select:{name:true,phrase:true,condition:true,monitor:{select:{url:true,projectId:true}}}}},orderBy:{createdAt:'desc'},take:100});}
  @Post('alert-rules')async create(@Req()req:ActorRequest,@Param('orgId')orgId:string,@Body()input:unknown){
    await this.policy.authorize(req.actor.id,z.uuid().parse(orgId),'research');if(!req.actor.verified)throw new ForbiddenException('Verify your email first');const data=alertRuleSchema.parse(input);
    return this.db.$transaction(async tx=>{await lockOrganization(tx,orgId);await tx.monitor.findFirstOrThrow({where:{organizationId:orgId,id:data.monitorId,project:{deletedAt:null}}});if(await tx.alertRule.count({where:{organizationId:orgId}})>=50)throw new ForbiddenException('Remove unused rules before adding more; workspace limit is 50');const rule=await tx.alertRule.create({data:{organizationId:orgId,...data}});await tx.auditLog.create({data:{organizationId:orgId,actorId:req.actor.id,action:'alert_rule.created',resourceId:rule.id}});return rule;});
  }
  @Patch('alert-rules/:id')async update(@Req()req:ActorRequest,@Param('orgId')orgId:string,@Param('id')id:string,@Body()input:unknown){
    await this.policy.authorize(req.actor.id,z.uuid().parse(orgId),'research');const data=alertRuleSchema.omit({monitorId:true}).partial().extend({enabled:z.boolean().optional()}).strict().parse(input);
    return this.db.$transaction(async tx=>{await tx.alertRule.findFirstOrThrow({where:{id:z.uuid().parse(id),organizationId:orgId}});const rule=await tx.alertRule.update({where:{id},data});await tx.auditLog.create({data:{organizationId:orgId,actorId:req.actor.id,action:'alert_rule.updated',resourceId:id}});return rule;});
  }
  @Delete('alert-rules/:id')async remove(@Req()req:ActorRequest,@Param('orgId')orgId:string,@Param('id')id:string){
    await this.policy.authorize(req.actor.id,z.uuid().parse(orgId),'research');return this.db.$transaction(async tx=>{await tx.alertRule.findFirstOrThrow({where:{id:z.uuid().parse(id),organizationId:orgId}});await tx.alertRule.delete({where:{id}});await tx.auditLog.create({data:{organizationId:orgId,actorId:req.actor.id,action:'alert_rule.deleted',resourceId:id}});return{message:'Rule and its matched alert history removed'};});
  }
}
