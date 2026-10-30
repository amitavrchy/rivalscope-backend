import 'dotenv/config';
import { z } from 'zod';

const optional = z.preprocess(v => v === '' ? undefined : v, z.string().optional());
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  APP_ORIGIN: z.url().default('http://localhost:3000'),
  // Comma-separated extra browser origins allowed for CSRF Origin checks (e.g. Netlify + API host).
  ALLOWED_ORIGINS: optional,
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  AI_PROVIDER: z.enum(['gemini', 'openai']).default('gemini'),
  GEMINI_API_KEY: optional,
  GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),
  OPENAI_API_KEY: optional,
  OPENAI_MODEL: optional,
  AI_FALLBACK_PROVIDER: z.preprocess(v => v === '' ? undefined : v, z.enum(['gemini', 'openai']).optional()),
  TAVILY_API_KEY: optional,
  SMTP_URL: optional,
  MAIL_FROM: z.string().default('RivalScope <noreply@rivalscope.local>'),
  STRIPE_SECRET_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  ENCRYPTION_KEY: optional,
  GOOGLE_OAUTH_CLIENT_ID: optional,
  GOOGLE_OAUTH_CLIENT_SECRET: optional,
  REPORT_FONT_PATH: optional,
  EMBEDDING_MODEL: z.string().default('gemini-embedding-2'),
  EMBEDDINGS_ENABLED: z.enum(['true', 'false']).default('true'),
  AI_MAX_INPUT_CHARS: z.coerce.number().int().min(10000).max(500000).default(180000),
  AI_DAILY_TOKEN_LIMIT: z.coerce.number().int().min(1000).default(500000),
  AI_INPUT_USD_PER_MILLION: z.preprocess(v => v === '' ? undefined : v, z.coerce.number().min(0).optional()),
  AI_OUTPUT_USD_PER_MILLION: z.preprocess(v => v === '' ? undefined : v, z.coerce.number().min(0).optional()),
  BILLING_PROVIDER: z.enum(['stripe', 'mock']).default('stripe'),
  MOCK_BILLING_WEBHOOK_SECRET: optional,
  BILLING_GRACE_DAYS: z.coerce.number().int().min(0).max(30).default(3),
});

export const env = schema.parse(process.env);
if (env.NODE_ENV === 'production') {
  if (env.BILLING_PROVIDER === 'mock') throw new Error('Mock billing is forbidden in production');
  if (new URL(env.APP_ORIGIN).protocol !== 'https:') throw new Error('Production APP_ORIGIN must use HTTPS');
  if (!env.SMTP_URL) throw new Error('Production SMTP_URL is required for account verification');
  if (!env.ENCRYPTION_KEY || !/^[a-f\d]{64}$/i.test(env.ENCRYPTION_KEY)) throw new Error('ENCRYPTION_KEY must be 32 random bytes encoded as hex');
}


/** Browser origins accepted by originProtection (APP_ORIGIN + ALLOWED_ORIGINS; localhost in non-production). */
export function allowedOrigins(): Set<string> {
  const origins = new Set<string>();
  origins.add(new URL(env.APP_ORIGIN).origin);
  for (const part of (env.ALLOWED_ORIGINS ?? '').split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try { origins.add(new URL(trimmed).origin); } catch { /* ignore invalid entries */ }
  }
  if (env.NODE_ENV !== 'production') {
    origins.add('http://localhost:3000');
    origins.add('http://127.0.0.1:3000');
  }
  return origins;
}
export function redisConnection() {
  const url = new URL(env.REDIS_URL);
  return { host: url.hostname, port: Number(url.port || 6379), username: url.username || undefined,
    password: decodeURIComponent(url.password) || undefined, db: Number(url.pathname.slice(1) || 0),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}), maxRetriesPerRequest: null };
}
