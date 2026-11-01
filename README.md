# RivalScope

**[Web app](https://rivalscope-132.netlify.app)** · **[API](https://rivalscope-api.onrender.com)** · **[Health](https://rivalscope-api.onrender.com/api/health)** · **[OpenAPI](https://rivalscope-api.onrender.com/api/docs)** · **[Frontend source](https://github.com/amitavrchy/rivalscope-frontend)**

Tenant-scoped competitor research API: queued, cited research runs, workspace billing, and a background worker for monitors, mail, and webhooks.

## Overview

RivalScope is the backend for the RivalScope web app. One NestJS codebase serves the HTTP API (`src/main.ts`) and a separate BullMQ worker (`src/worker.ts`). PostgreSQL stores tenants, research, and pgvector embeddings. Redis stores queues, throttling counters, and the worker heartbeat.

Session requests use an `rs_session` cookie. Mutating requests must come from an allowed browser `Origin` and use JSON. Customer reads at [https://rivalscope-api.onrender.com/api/v1/projects](https://rivalscope-api.onrender.com/api/v1/projects) and [https://rivalscope-api.onrender.com/api/v1/reports](https://rivalscope-api.onrender.com/api/v1/reports) use scoped bearer API keys (`projects:read`, `reports:read`). Interactive docs are at [https://rivalscope-api.onrender.com/api/docs](https://rivalscope-api.onrender.com/api/docs) and [https://rivalscope-api.onrender.com/api/docs-json](https://rivalscope-api.onrender.com/api/docs-json).

The image that is live on Render is `Dockerfile.render`: one container starts Postgres with pgvector, Redis, Mailpit, the worker, and the API. `Dockerfile` is the slimmer API and worker runtime for a host that already provides Postgres and Redis. Render builds from the repository root; both Dockerfiles stay there.

`npm run deploy`, `npm run db:backup`, and `npm run db:restore-check` expect Compose files in the parent rivalscope-ai checkout. This repository runs on its own once `DATABASE_URL` and `REDIS_URL` are set.

## Key features

- **Workspaces.** Organizations, projects, comments, invitations, and roles (`OWNER`, `ADMIN`, `ANALYST`, `EDITOR`, `VIEWER`, `BILLING_MANAGER`) with permission checks on every tenant route.
- **Research pipeline.** A run moves through plan, search, extract, analyze, catalog, verify, and report. Credits are reserved up front and settled from completed stages. Runs stream over server-sent events and can be cancelled.
- **Evidence.** Findings keep quotations tied to retrieved sources. Catalog rows (products, features, prices) must quote the competitor’s own public page. Reports export to JSON, Markdown, PDF, and DOCX. PDF uses `assets/NotoSansBengali.ttf` when Bengali text is present.
- **Copilot.** Project questions are answered from saved sources, retrieved lexically or with 768-dimension embeddings, and rejected when a citation is not in the source text.
- **Monitoring.** URL monitors, change records, phrase alert rules, and Slack or Discord notification hooks.
- **Billing.** Stripe subscriptions and credit packs, invoices, a customer portal, and a mock provider that configuration refuses in production.
- **Platform administration.** Plans, jobs, feature flags, audit logs, credit adjustments, and Prometheus-style metrics for platform admins.
- **Account security.** Argon2 passwords, email verification, MFA with recovery codes, Google sign-in, session revoke, and privacy export or deletion for an account or an organization.

## Tech stack

| Layer | Choice |
| --- | --- |
| HTTP | NestJS 12 on Express, Helmet, cookie sessions, Zod validation |
| Data | Prisma 7, PostgreSQL, pgvector, generated client in `src/generated` (not committed) |
| Jobs | BullMQ on Redis; research and monitor queues, plus mail, webhook, and embedding maintenance |
| Models | Gemini or OpenAI for research and copilot; Gemini embeddings; Tavily for web discovery |
| Billing and mail | Stripe, Nodemailer |
| Auth | `@nestjs/jwt` session flow, `otplib` MFA, `google-auth-library` |
| Observability | Optional OpenTelemetry OTLP export and Sentry. Nothing is sent until those env vars are set |
| Quality | TypeScript strict, oxlint, Vitest, Prettier |

## Project structure

```
├── src/                  API, worker, and domain modules
│   ├── main.ts           HTTP bootstrap and OpenAPI setup
│   ├── worker.ts         BullMQ workers and maintenance loop
│   ├── auth.ts           Register, login, verification, sessions
│   ├── research.ts       Queue, stages, and run API
│   ├── billing.ts        Stripe and sandbox billing
│   └── …                organizations, projects, reports, monitors, admin
├── prisma/               Schema, SQL migrations, seed entry
├── test/                 Vitest specs, including e2e
├── scripts/              Provider check, migrate helper, backup, restore check
├── assets/               Noto Sans Bengali (OFL) for PDF export
├── Dockerfile            API and worker image
├── Dockerfile.render     Render image: Postgres, pgvector, Redis, Mailpit, API, worker
└── docker-entrypoint.render.sh
```

Root files that stay put are the package manifest, TypeScript and Nest config, Prisma config, Vitest and oxlint config, and the Docker build. `npm run build` emits `dist/`.

## API overview

Every route is on [https://rivalscope-api.onrender.com](https://rivalscope-api.onrender.com). Cookie mutations require the `Origin` listed in `APP_ORIGIN` or `ALLOWED_ORIGINS`.

| Area | Live routes |
| --- | --- |
| Health | `GET https://rivalscope-api.onrender.com/api/health`, `GET https://rivalscope-api.onrender.com/api/health/ready` |
| Auth | `POST https://rivalscope-api.onrender.com/api/auth/register`, `login`, `mfa`, `verify`, `forgot-password`, `reset-password`; `GET https://rivalscope-api.onrender.com/api/auth/me`; `GET https://rivalscope-api.onrender.com/api/auth/google/start` |
| Account | `GET https://rivalscope-api.onrender.com/api/account/security`, profile, session revoke, MFA setup |
| Privacy | `GET https://rivalscope-api.onrender.com/api/privacy/account/export`, `POST https://rivalscope-api.onrender.com/api/privacy/account/delete`, organization export and delete |
| Organizations | `GET/POST https://rivalscope-api.onrender.com/api/organizations`, team, invitations, audit, credit ledger, notifications |
| Projects | `GET/POST https://rivalscope-api.onrender.com/api/organizations/:orgId/projects`, archive, restore, comments |
| Research | `POST https://rivalscope-api.onrender.com/api/organizations/:orgId/projects/:projectId/research`, `…/estimate`, `GET …/:runId`, cancel, SSE `…/events` |
| Reports | `GET https://rivalscope-api.onrender.com/api/organizations/:orgId/reports`, `GET …/reports/:id/export?format=json\|markdown\|pdf\|docx` |
| Intelligence | `GET https://rivalscope-api.onrender.com/api/organizations/:orgId/projects/:projectId/intelligence`, saved comparisons |
| Copilot | `GET/POST https://rivalscope-api.onrender.com/api/organizations/:orgId/projects/:projectId/copilot` |
| Monitors | `GET/POST https://rivalscope-api.onrender.com/api/organizations/:orgId/monitors`, alert rules |
| Billing | `GET https://rivalscope-api.onrender.com/api/billing/plans`, org checkout, portal, invoices, `POST https://rivalscope-api.onrender.com/api/billing/webhook` |
| Integrations | API keys, signed webhooks (`research.completed`, `monitor.changed`) |
| Public read API | `GET https://rivalscope-api.onrender.com/api/v1/projects`, `GET https://rivalscope-api.onrender.com/api/v1/reports` with `Authorization: Bearer rs_live_…` |
| Admin | `https://rivalscope-api.onrender.com/api/admin` and `https://rivalscope-api.onrender.com/api/admin/diagnostics` for platform admins |

Webhook deliveries are signed `t=<unix>,v1=<hex>` over `timestamp.body` (HMAC-SHA256).

## Getting started

Use Node 24, PostgreSQL 17 with the `vector` extension, and Redis. Copy `.env.example` to `.env` and set the variables by name. Do not commit `.env`.

| Variable | Role |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. The database needs the `vector` extension. |
| `REDIS_URL` | Redis connection string for BullMQ, throttling, and the worker heartbeat. |
| `APP_ORIGIN` | Browser origin allowed to send cookie mutations. The live web app is [https://rivalscope-132.netlify.app](https://rivalscope-132.netlify.app). |
| `ALLOWED_ORIGINS` | Extra comma-separated browser origins. The live API also accepts [https://rivalscope-api.onrender.com](https://rivalscope-api.onrender.com). |
| `PORT` | Port the HTTP process binds. |
| `ENCRYPTION_KEY` | 32 random bytes as hex (`openssl rand -hex 32`). Required when `NODE_ENV=production`. |
| `SMTP_URL`, `MAIL_FROM` | Mail transport. `SMTP_URL` is required in production. |
| `BILLING_PROVIDER` | `stripe` in production. `mock` is rejected when `NODE_ENV=production`. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe. Leave unset until billing is configured. |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `AI_PROVIDER`, `AI_FALLBACK_PROVIDER` | Research and copilot models. |
| `TAVILY_API_KEY` | Web discovery. Required only when a run enables discovery. |
| `EMBEDDINGS_ENABLED`, `EMBEDDING_MODEL` | pgvector indexing. The Render image sets `EMBEDDINGS_ENABLED` to false. |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Google sign-in. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `SENTRY_DSN` | Optional telemetry. Nothing is exported while these are unset. |
| `TEST_DATABASE_URL`, `TEST_REDIS_URL` | Override the database and Redis used by `npm run test:e2e`. |

```bash
npm ci
npm run db:generate
npm run db:migrate
npm run db:seed
npm run start:dev
```

In another terminal, `npm run worker:dev`. The process listens on `PORT`.

Production also requires `APP_ORIGIN` on HTTPS. Gemini, OpenAI, Tavily, Stripe, Google OAuth, Slack, Discord, and telemetry stay off until their variables are set. On the Render image, a missing `ENCRYPTION_KEY` is generated for that boot only.

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run build
```

`npm run test:e2e` reads `TEST_DATABASE_URL` and `TEST_REDIS_URL`. Apply migrations and seed that database first. Tests add their own fixtures and do not truncate existing users.

`npm run check:provider` calls Gemini with the configured key. `npm run db:backup` and `npm run db:restore-check` shell out to Compose in the parent workspace.

```bash
docker build --secret id=corporate_ca,src=/etc/ssl/certs/ca-certificates.crt -f Dockerfile .
docker build -f Dockerfile.render .
```

The first build accepts an optional corporate CA as a BuildKit secret. Omit a custom CA by pointing the secret at your system bundle, as above. `Dockerfile.render` is the file the Render web service builds, with an empty Root Directory and no extra dashboard path change required for this repository layout.

A GitHub Actions workflow pings `https://rivalscope-api.onrender.com/api/health` every ten minutes so the free-tier service stays awake. `RENDER_HEALTH_URL` overrides that URL.

## Author

**Amitav Roy Chowdhury**
[github.com/amitavrchy](https://github.com/amitavrchy)
