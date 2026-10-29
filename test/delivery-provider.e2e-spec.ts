import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHmac, randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { Database } from '../src/database.js';
import { RedisStore } from '../src/redis-store.js';
import { WebhookService } from '../src/integrations.js';
import { AiService, GeminiProvider, OpenAiProvider, ProviderError, SearchService } from '../src/providers.js';
import { NotificationService } from '../src/notifications.js';
import { SourceCollector } from '../src/source-collector.js';
import { env } from '../src/config.js';
import * as sourceHttp from '../src/safe-http.js';
import { z } from 'zod';

describe('provider budgets, caching and durable integrations', () => {
  let app: INestApplication; let db: Database; let orgId: string; let userId: string; let cookie: string;
  const suffix=randomUUID(); const headers=()=>({Cookie:cookie,Origin:env.APP_ORIGIN});
  beforeAll(async()=>{
    if(!new URL(env.DATABASE_URL).pathname.endsWith('/rivalscope_test'))throw new Error('Use the isolated test database');
    const module=await Test.createTestingModule({imports:[AppModule]}).compile();app=configureApp(module.createNestApplication());await app.init();db=app.get(Database);
    const redis=app.get(RedisStore);const keys=await redis.client.keys('rs:throttle:*');if(keys.length)await redis.client.del(...keys);
    const register=await request(app.getHttpServer()).post('/api/auth/register').set('Origin',env.APP_ORIGIN).send({name:'Integration fixture',email:`integration-${suffix}@example.test`,password:'a-unique-provider-fixture-password-123',organizationName:'Integration fixture workspace'}).expect(201);
    cookie=String(register.headers['set-cookie'][0]).split(';')[0]!;const me=await request(app.getHttpServer()).get('/api/auth/me').set('Cookie',cookie).expect(200);userId=me.body.id;orgId=me.body.memberships[0].organization.id;
    await db.user.update({where:{id:userId},data:{emailVerifiedAt:new Date()}});
  });
  afterAll(async()=>{if(app)await app.close();});
  it('meters requests, enforces the per-key limit and rotates keys atomically',async()=>{
    const created=await request(app.getHttpServer()).post(`/api/organizations/${orgId}/api-keys`).set(headers()).send({name:'Rotating fixture',scopes:['projects:read']}).expect(201);
    for(let i=0;i<60;i++)await request(app.getHttpServer()).get('/api/v1/projects').set('Authorization',`Bearer ${created.body.key}`).expect(200);
    await request(app.getHttpServer()).get('/api/v1/projects').set('Authorization',`Bearer ${created.body.key}`).expect(429);
    expect(await db.apiUsage.count({where:{organizationId:orgId,apiKeyId:created.body.id}})).toBe(60);
    const next=await request(app.getHttpServer()).post(`/api/organizations/${orgId}/api-keys/${created.body.id}/rotate`).set(headers()).send({}).expect(201);
    await request(app.getHttpServer()).get('/api/v1/projects').set('Authorization',`Bearer ${created.body.key}`).expect(401);
    await request(app.getHttpServer()).get('/api/v1/projects').set('Authorization',`Bearer ${next.body.key}`).expect(200);
    await request(app.getHttpServer()).get('/api/v1/reports').set('Authorization',`Bearer ${next.body.key}`).expect(403);
    expect((await db.apiKey.findUniqueOrThrow({where:{id:next.body.id}})).expiresAt.toISOString()).toBe(created.body.expiresAt);
  });
  it('signs each delivery, deduplicates events, dead-letters failures and recovers explicitly',async()=>{
    const endpoint=await request(app.getHttpServer()).post(`/api/organizations/${orgId}/webhooks`).set(headers()).send({url:'https://receiver.example/events',events:['research.completed']}).expect(201);
    const service=app.get(WebhookService);const eventId=randomUUID();
    await db.$transaction(async tx=>{await service.emit(tx,orgId,'research.completed',eventId,{runId:randomUUID()});await service.emit(tx,orgId,'research.completed',eventId,{});});
    expect(await db.webhookDelivery.count({where:{endpointId:endpoint.body.id}})).toBe(1);
    const transport=vi.spyOn(sourceHttp,'safeRequest').mockImplementation(async(url,options)=>{
      expect(url).toBe('https://receiver.example/events');expect(options?.redirects).toBe(0);
      const signature=options?.headers?.['x-rivalscope-signature'];if(!signature)throw new Error('Signing header missing');const timestamp=signature.split(',')[0]!.slice(2);
      expect(signature).toBe(`t=${timestamp},v1=${createHmac('sha256',endpoint.body.secret).update(`${timestamp}.${options?.body}`).digest('hex')}`);
      return{status:200,text:'ok',url,contentType:'text/plain'};
    });
    try{
      await service.deliverPending();expect((await db.webhookDelivery.findFirstOrThrow({where:{endpointId:endpoint.body.id}})).status).toBe('delivered');
      await db.$transaction(tx=>service.emit(tx,orgId,'research.completed',randomUUID(),{}));
      const failed=await db.webhookDelivery.findFirstOrThrow({where:{endpointId:endpoint.body.id,status:'pending'}});
      transport.mockResolvedValue({status:503,text:'unavailable',url:'https://receiver.example/events',contentType:'text/plain'});
      for(let i=0;i<6;i++){await db.webhookDelivery.update({where:{id:failed.id},data:{nextAttemptAt:new Date(0)}});await service.deliverPending();}
      expect((await db.webhookDelivery.findUniqueOrThrow({where:{id:failed.id}})).status).toBe('dead_letter');
      await request(app.getHttpServer()).post(`/api/organizations/${orgId}/webhooks/${endpoint.body.id}/retry/${failed.id}`).set(headers()).send({}).expect(201);
      transport.mockResolvedValue({status:200,text:'ok',url:'https://receiver.example/events',contentType:'text/plain'});await service.deliverPending();
      expect((await db.webhookDelivery.findUniqueOrThrow({where:{id:failed.id}})).status).toBe('delivered');
      const listing=await request(app.getHttpServer()).get(`/api/organizations/${orgId}/webhooks`).set('Cookie',cookie).expect(200);expect(JSON.stringify(listing.body)).not.toContain(endpoint.body.secret);
    }finally{transport.mockRestore();}
  });
  it('caches validated AI output and refuses new requests after a daily budget is exhausted',async()=>{
    const ai=app.get(AiService);const resultSchema=z.object({answer:z.string()});const generation=vi.spyOn(GeminiProvider.prototype,'generate').mockResolvedValue({data:{answer:'Evidence only'},tokens:30,inputTokens:20,outputTokens:10,provider:'gemini',model:env.GEMINI_MODEL});
    const original=env.AI_DAILY_TOKEN_LIMIT;
    try{
      const input={fixture:suffix};await ai.generate(resultSchema,'Fixture policy',input,{organizationId:orgId});const cached=await ai.generate(resultSchema,'Fixture policy',input,{organizationId:orgId});expect(cached.tokens).toBe(0);expect(generation).toHaveBeenCalledTimes(1);
      env.AI_DAILY_TOKEN_LIMIT=1000;await expect(ai.generate(resultSchema,'Different policy',input,{organizationId:orgId})).rejects.toThrow('budget');expect(generation).toHaveBeenCalledTimes(1);
      expect(await db.providerUsage.count({where:{organizationId:orgId,status:'completed'}})).toBe(1);
    }finally{generation.mockRestore();env.AI_DAILY_TOKEN_LIMIT=original;}
  });
  it('uses an explicitly configured fallback only after retryable primary failures',async()=>{
    const original={fallback:env.AI_FALLBACK_PROVIDER,key:env.OPENAI_API_KEY,model:env.OPENAI_MODEL};env.AI_FALLBACK_PROVIDER='openai';env.OPENAI_API_KEY='fixture-only';env.OPENAI_MODEL='fixture-model';
    const primary=vi.spyOn(GeminiProvider.prototype,'generate').mockRejectedValue(new ProviderError('gemini',true,503));const fallback=vi.spyOn(OpenAiProvider.prototype,'generate').mockResolvedValue({data:{answer:'Fallback evidence'},tokens:20,provider:'openai',model:'fixture-model'});
    try{const result=await app.get(AiService).generate(z.object({answer:z.string()}),'Fallback fixture',{suffix},{organizationId:orgId});expect(result.provider).toBe('openai');expect(primary).toHaveBeenCalledTimes(2);expect(fallback).toHaveBeenCalledTimes(1);}
    finally{primary.mockRestore();fallback.mockRestore();env.AI_FALLBACK_PROVIDER=original.fallback;env.OPENAI_API_KEY=original.key;env.OPENAI_MODEL=original.model;}
  });
  it('normalizes and caches search adapter results without inventing absent credentials',async()=>{
    const original=env.TAVILY_API_KEY;env.TAVILY_API_KEY='fixture-only';const transport=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({results:[{url:'https://fixture.example/pricing#top',title:'Pricing'},{url:'https://fixture.example/pricing',title:'Pricing duplicate'}]}),{status:200,headers:{'content-type':'application/json'}}));
    try{const service=app.get(SearchService);const result=await service.search(`Fixture  ${suffix}`,3);expect(result).toHaveLength(1);await service.search(`Fixture ${suffix}`,3);expect(transport).toHaveBeenCalledTimes(1);env.TAVILY_API_KEY=undefined;await expect(service.search('Unconfigured fixture')).rejects.toThrow('TAVILY');}
    finally{transport.mockRestore();env.TAVILY_API_KEY=original;}
  });
  it('queues daily digests and sends configured Slack alerts without duplicate deliveries',async()=>{
    await request(app.getHttpServer()).post(`/api/organizations/${orgId}/notification-preferences`).set(headers()).send({emailEnabled:true,frequency:'DAILY'}).expect(201);
    await db.notificationPreference.update({where:{organizationId_userId:{organizationId:orgId,userId}},data:{nextDigestAt:new Date(0),lastDigestAt:new Date(Date.now()-1000)}});
    await request(app.getHttpServer()).post(`/api/organizations/${orgId}/notification-integrations`).set(headers()).send({provider:'slack',url:'https://hooks.slack.com/services/fixture/test/token'}).expect(201);
    const notification=await db.notification.create({data:{organizationId:orgId,title:'Fixture alert',body:'Review @everyone as literal source text.'}});
    const transport=vi.spyOn(sourceHttp,'safeRequest').mockResolvedValue({status:200,text:'ok',url:'https://hooks.slack.com/services/fixture/test/token',contentType:'text/plain'});
    try{await app.get(NotificationService).deliver();await app.get(NotificationService).deliver();expect(await db.notificationDelivery.count({where:{notificationId:notification.id,status:'delivered'}})).toBe(1);expect(transport).toHaveBeenCalledTimes(1);expect(await db.emailDelivery.count({where:{recipient:`integration-${suffix}@example.test`,idempotencyKey:{startsWith:'digest-'}}})).toBe(1);}
    finally{transport.mockRestore();}
  });
  it('preserves source retrieval time on cache hits, rechecks robots and supports a live fetch',async()=>{
    const url='https://caching.example/pricing';const text='Published source text for cache isolation and freshness checks. '.repeat(3);
    const extract=vi.spyOn(sourceHttp,'extractWebsite').mockResolvedValue({url,title:'Cache fixture',text,contentHash:'e'.repeat(64)});const robots=vi.spyOn(sourceHttp,'assertRobotsAllowed').mockResolvedValue(undefined);
    try{const collector=app.get(SourceCollector);const first=await collector.extract(orgId,url);const cached=await collector.extract(orgId,url);expect(cached.retrievedAt.toISOString()).toBe(first.retrievedAt.toISOString());expect(extract).toHaveBeenCalledTimes(1);expect(robots).toHaveBeenCalledTimes(1);await collector.extract(orgId,url,'live');await collector.extract(randomUUID(),url);expect(extract).toHaveBeenCalledTimes(3);}finally{extract.mockRestore();robots.mockRestore();}
  });
});
