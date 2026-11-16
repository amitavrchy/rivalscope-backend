import './instrumentation.js';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { env } from './config.js';
import { installApiContracts } from './api-contracts.js';

async function bootstrap() {
  const app = configureApp(await NestFactory.create(AppModule, { rawBody: true, bodyParser: true }));
  const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('RivalScope API').setDescription('Tenant-scoped competitor research. Session cookie and Origin header are required for mutations.').setVersion('0.1.0').addCookieAuth('rs_session').build());
  SwaggerModule.setup('api/docs', app, installApiContracts(document));
  await app.listen(env.PORT, '0.0.0.0');
}
await bootstrap();
