import { spawnSync } from 'node:child_process';

describe('explicit free-preview production configuration', () => {
  const check = (preview: string, approval: string) => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "await import('./src/config.ts')"], {
    env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: 'postgresql://fixture@localhost/fixture', REDIS_URL: 'redis://localhost:6379', APP_ORIGIN: 'https://fixture.invalid', ALLOWED_ORIGINS: '', ENCRYPTION_KEY: 'a'.repeat(64), SMTP_URL: '', BILLING_PROVIDER: 'stripe', FREE_PREVIEW: preview, ALLOW_PRODUCTION_SEED: approval }, encoding: 'utf8',
  });
  it('keeps SMTP mandatory for the ordinary production target', () => { const result = check('false', 'true'); expect(result.status).not.toBe(0); expect(result.stderr).toContain('Production SMTP_URL is required'); });
  it('allows unavailable SMTP only for an explicitly approved preview', () => { expect(check('true', 'true').status).toBe(0); });
  it('rejects a preview without the production-seed opt-in', () => { const result = check('true', 'false'); expect(result.status).not.toBe(0); expect(result.stderr).toContain('explicit production-seed approval'); });
});
