import { Global, Injectable, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { env } from './config.js';
import type { Prisma } from './generated/prisma/client.js';
import { z } from 'zod';

@Injectable()
export class Database extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() { super({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) }); }
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
  async tenantRead<T>(organizationId: string, operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    z.uuid().parse(organizationId);
    return this.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE rivalscope_tenant_reader');
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
      return operation(tx);
    });
  }
}

@Global()
@Module({ providers: [Database], exports: [Database] })
export class DatabaseModule {}
