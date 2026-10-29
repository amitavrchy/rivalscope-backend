import { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { json as expressJson } from 'express';
import type { Request } from 'express';
import { ApiExceptionFilter, originProtection } from './security.js';
import { env } from './config.js';
import { MetricsService } from './observability.js';

export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('api');
  if (env.NODE_ENV === 'production') app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.use(helmet());
  app.use(cookieParser());
  const metrics = app.get(MetricsService); app.use(metrics.middleware.bind(metrics));
  app.use(expressJson({ limit: '128kb', verify: (req, _res, buffer) => { (req as Request & { rawBody: Buffer }).rawBody = buffer; } }));
  app.use(originProtection);
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  return app;
}
