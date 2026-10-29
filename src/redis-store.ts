import { Global, Inject, Injectable, Module, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { redisConnection } from './config.js';

@Injectable()
export class RedisStore implements OnModuleDestroy {
  readonly client = new Redis({ ...redisConnection(), maxRetriesPerRequest: 2, connectTimeout: 5000 });
  constructor() { this.client.on('error', () => undefined); }
  async onModuleDestroy() { await this.client.quit(); }
  async increment(key: string, ttl: number) {
    const result = await this.client.eval("local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end;return {n,redis.call('PTTL',KEYS[1])}", 1, key, ttl) as [number, number];
    return { count: Number(result[0]), remainingMs: Number(result[1]) };
  }
}
@Injectable()
export class RedisThrottleStorage implements ThrottlerStorage {
  constructor(@Inject(RedisStore) private readonly store: RedisStore) {}
  async increment(key: string, ttl: number, limit: number, _blockDuration: number, throttlerName: string) {
    try {
      const result = await this.store.increment(`rs:throttle:${throttlerName}:${key}`, ttl); const isBlocked = result.count > limit;
      return { totalHits: result.count, timeToExpire: Math.max(0, Math.ceil(result.remainingMs / 1000)), isBlocked, timeToBlockExpire: isBlocked ? Math.max(0, Math.ceil(result.remainingMs / 1000)) : 0 };
    } catch { throw new ServiceUnavailableException('Request protection is temporarily unavailable'); }
  }
}
@Global()
@Module({ providers: [RedisStore, RedisThrottleStorage], exports: [RedisStore, RedisThrottleStorage] })
export class RedisModule {}
