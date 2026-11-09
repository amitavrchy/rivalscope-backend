# RivalScope deployment runbook

Prepared locally on 2026-11-09. No public deployment or resource provisioning was performed. Historical hosting links are not ownership verification. Render workspace **Heyhoo** is approved; service plans, regions, persistent databases and Redis still need explicit approval and credentials.

## Required topology and approval gate

Use one Docker web service and a separate continuously running background worker from this repository, one persistent PostgreSQL database with pgvector, and persistent Redis with a no-eviction policy. Deploy the frontend from `rivalscope-frontend` on Netlify. Database and Redis must be reachable by both processes and must survive service replacement. Never use the previous all-in-one Render container: it lost database/queue data with ephemeral disk and generated a different encryption key on boot.

Before provisioning, obtain an exact account quote covering both projects: provider, region, service names, instance plans, database storage/backups, Redis persistence, monthly total and any trial expiry. Approval of a workspace is not approval of paid resources. An always-on worker is required for research and monitoring. Sleeping free web services cannot provide timely scheduled work. [Render free PostgreSQL expires after 30 days](https://render.com/docs/free); it is not permanent production storage.

## Environment-variable names

Supply values through provider secret settings. Do not put credentials in Git, Docker build arguments, logs, or frontend variables.

| Purpose | Names |
| --- | --- |
| API and worker, required | `NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, `APP_ORIGIN`, `SMTP_URL`, `ENCRYPTION_KEY` |
| HTTP and mail | `PORT`, `ALLOWED_ORIGINS`, `MAIL_FROM` |
| Startup controls, normally disabled | `RUN_MIGRATIONS`, `SEED_ON_START`, `ALLOW_PRODUCTION_SEED` |
| AI and discovery | `AI_PROVIDER`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `AI_FALLBACK_PROVIDER`, `TAVILY_API_KEY` |
| Embeddings | `EMBEDDINGS_ENABLED`, `EMBEDDING_MODEL` |
| Cost and quota configuration | `AI_MAX_INPUT_CHARS`, `AI_DAILY_TOKEN_LIMIT`, `AI_INPUT_USD_PER_MILLION`, `AI_OUTPUT_USD_PER_MILLION` |
| Billing | `BILLING_PROVIDER`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BILLING_GRACE_DAYS` |
| Google sign-in | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` |
| Optional diagnostics | `REPORT_FONT_PATH`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `SENTRY_DSN`, `OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET` |
| Netlify, server-only build setting | `API_INTERNAL_URL` |
| Isolated integration tests | `TEST_DATABASE_URL`, `TEST_REDIS_URL` |

Use production mode, an exact HTTPS frontend origin and a stable independently generated encryption key. Extra allowed origins must also be exact HTTPS origins. Share the encryption key across API and worker and preserve it in secret storage/backups. Use TLS for external database/Redis connections. Mock billing is rejected in production. Research, paid billing, Google OAuth and actual mail delivery require their providers to be configured and tested separately.

## Ordered deployment procedure

1. Review the branch and local verification report, approve the exact hosting plan, and confirm ownership of both provider accounts and selected domains. No repository push or provider creation was performed by this task.
2. Create or select the approved persistent PostgreSQL and Redis services in the approved region. Enable backups and test a restore to an isolated database. Verify pgvector availability. RivalScope migrations also create `rivalscope_tenant_reader`, grant membership and install row-level read policies: the migration principal needs the corresponding role/extension privileges. Check this on the actual provider before launching; do not remove tenant isolation to bypass a failed migration.
3. Configure API and worker environment variables. Keep seed-on-start disabled. Back up any existing database and encryption key before migration.
4. Build from repository root using `Dockerfile.render` (identical to `Dockerfile`): `docker build -f Dockerfile.render -t rivalscope-api .`. Runtime is UID 1000. No database, Redis or mail server is packaged in this image.
5. Apply `npm run db:migrate` once in the built image against the approved database using a migration job/pre-deploy command. If the selected Render plan lacks that facility, run an approved one-off container with the environment supplied securely. The entrypoint optionally supports migrations; enable that only for the API release, never concurrently across API/worker. It executes the requested process directly for signal handling.
6. Run `npm run db:seed` once as an explicit operator action with production seeding authorized. This installs product plans/permissions and preserves existing edits. Disable seed approval afterwards. Synthetic examples are a separate opt-in command, `npm run db:seed:demo`; they never create known-password accounts or platform administrators. See [seed provenance](SEED-DATA.md).
7. In Render, choose Docker, empty root directory, `Dockerfile.render`, default command `node dist/main.js`, and health path `/api/health/ready`. The app binds the assigned port on all interfaces. Add a separate background worker with the same image and command `node dist/worker.js`. The image's HTTP Docker health check applies to the API; a local worker container should use `--no-healthcheck`. Check worker heartbeat through authenticated diagnostics/Redis rather than an HTTP endpoint.
8. In Netlify, import the frontend repository, base/package directory repository root, build `npm run build`, publish `.next`, Node 24 and the Next.js adapter from `netlify.toml`. Set the server-only API destination before building. Rebuild whenever it changes. The configuration refuses a missing/non-HTTPS API destination on Netlify.
9. Set the API frontend-origin allowlist to the actual Netlify/custom HTTPS origin. Browser requests use the frontend's `/api` rewrite. Cookies are host-only, HttpOnly, Secure in production and SameSite Lax; keep the proxy so cross-site cookies are unnecessary. Origin is preserved for CSRF checks. Do not use wildcard credentialed CORS or enable arbitrary deploy-preview origins.
10. Register and verify a real operator account using working SMTP. Platform elevation is an explicit server-side action using `node dist/admin-cli.js` with the intended command/account arguments. Synthetic users have no known passwords and no platform privileges. Configure Stripe prices/webhooks only in the intended account; verify signed webhook delivery and idempotency before enabling payments.
11. Check actual live endpoints before declaring success: frontend `/`, `/login`; proxied `/api/health/ready`; backend `/api/health/ready`; anonymous `/api/auth/me` must reject access; register/login/logout, cookie flags, permitted/forbidden Origins, tenant substitution, a queued research job, worker heartbeat, and a restart with persisted records. Verify Netlify never caches private API responses. Confirm no credentials appear in HTML/static assets. Test integrations with approved provider credentials and test-mode payments.
12. Retain the previous image and a tested database backup for rollback. Migrations are forward-only here; reverting application code is safe only after checking schema compatibility. Never automatically reset or force-push databases to undo a release.

## Local verification and backup notes

Install with `npm ci`, generate with `npm run db:generate`, migrate the isolated database, seed it, and run `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`, `npm run build`, `npm audit`. Integration tests require a database named `rivalscope_test`. `npm run db:seed:verify` compares stored rows before/after a seed rerun; run it after initial seeding with no concurrent writers.

`npm run db:backup` now uses `pg_dump` against the configured database and writes restricted files under this repository's ignored `backups/`. `npm run db:restore-check -- <backup-file> <unique-database-name-ending-in-_restore_check>` creates a fresh database and never overwrites an existing one. Install matching PostgreSQL client tools first; they were unavailable on the Windows host, so these revised native commands were syntax-checked but not exercised here. Encrypt/export backups to persistent restricted storage; container-local backup files are not durable backups.

NestJS Observe is not configured automatically. No production telemetry was consulted and no production performance/regression claim is made. If investigating a live failure, connect Observe or supply the dashboard's copied agent prompt as directed by `AGENTS.md`.
