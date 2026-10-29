import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RedisStore } from './redis-store.js';
import { assertRobotsAllowed, extractWebsite, validatePublicUrl } from './safe-http.js';

const sourceSchema=z.object({url:z.url(),title:z.string().max(300),text:z.string().min(100).max(20000),contentHash:z.string().regex(/^[a-f0-9]{64}$/),retrievedAt:z.coerce.date()});
@Injectable()
export class SourceCollector {
  constructor(@Inject(RedisStore)private readonly redis:RedisStore){}
  async extract(organizationId:string,url:string,freshness:'live'|'recent'='recent') {
    const canonical=validatePublicUrl(url).href;const key=`rs:source:${organizationId}:${createHash('sha256').update(canonical).digest('hex')}`;
    if(freshness==='recent'){
      const cached=await this.redis.client.get(key).catch(()=>null);
      if(cached){
        let decoded:unknown;try{decoded=JSON.parse(cached);}catch{decoded=null;}
        const parsed=sourceSchema.safeParse(decoded);
        if(parsed.success&&parsed.data.url===canonical&&parsed.data.retrievedAt.getTime()<=Date.now()&&parsed.data.retrievedAt.getTime()>Date.now()-900000){
          // A cached public page never overrides a newly restrictive robots policy.
          await assertRobotsAllowed(canonical);return parsed.data;
        }
      }
    }
    const source=sourceSchema.parse({...await extractWebsite(canonical),retrievedAt:new Date()});
    await this.redis.client.set(key,JSON.stringify(source),'EX',900).catch(()=>undefined);return source;
  }
}
