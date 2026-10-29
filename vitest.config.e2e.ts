import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: 'test',
      GEMINI_API_KEY: 'fixture_only_not_a_real_provider_key',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://rivalscope:rivalscope_local@localhost:5433/rivalscope_test',
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6380/1',
      SMTP_URL: 'smtp://localhost:1025',
      APP_ORIGIN: 'http://localhost:3000',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      STRIPE_SECRET_KEY: 'sk_test_automated_fixture_only',
      STRIPE_WEBHOOK_SECRET: 'whsec_automated_fixture_only',
      MOCK_BILLING_WEBHOOK_SECRET: 'sandbox_automated_fixture_only',
    },
  },
});
