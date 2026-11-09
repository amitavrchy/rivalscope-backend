# RivalScope API

Tenant-scoped competitor research built with NestJS, Prisma/PostgreSQL with pgvector, and Redis/BullMQ. The HTTP API and background worker run separately. Research uses retrieved public evidence; private organization/project data requires authorization.

For the newly authorized disposable all-in-one Render Free target, use [FREE-PREVIEW.md](FREE-PREVIEW.md). The external-store production targets remain available.

Start with [deployment and environment names](DEPLOYMENT.md), [synthetic seed provenance](SEED-DATA.md), and [verification results](VERIFICATION.md). Historical hosting addresses were removed because ownership and live deployment were not verified for the current accounts.

## Local setup

Use Node 24, PostgreSQL with pgvector and Redis. Copy `.env.example` locally and supply your own configuration. Run:

```sh
npm ci
npm run db:generate
npm run db:migrate
npm run db:seed
npm run start:dev
```

Start `npm run worker:dev` in another terminal. Optional synthetic examples: `npm run db:seed:demo`. Seed reruns preserve existing records/passwords. Production seed execution is explicitly guarded; no seed creates a platform administrator or a known-password login.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run build
npm audit
npm run db:seed:verify
```

Supply isolated integration-test database/Redis variables; integration tests require the database name `rivalscope_test`. Seed verification requires an already seeded, idle demonstration database. Never run tests against production.

## Runtime and routes

`Dockerfile` and `Dockerfile.render` both build the non-root API/worker runtime and require external persistent PostgreSQL/Redis. Neither starts a database, Redis or a mail server. Startup migrations/seeding are optional, guarded operations. `npm run deploy` intentionally directs operators to the approval-based runbook instead of relying on missing parent-workspace Compose files.

The API binds all interfaces using the platform port. Routes are relative to the configured backend: `/api/health`, `/api/health/ready`, `/api/docs`, `/api/auth`, `/api/organizations`, `/api/billing`, `/api/v1/projects`, `/api/v1/reports`, `/api/admin`. Interactive browser sessions use an HttpOnly cookie; mutations require an allowed Origin and JSON. Public read APIs require scoped bearer keys. Private API responses are not cacheable.

Plans, workspace roles, source-backed research/report exports, project collaboration, monitors, notifications, Stripe billing, API keys, MFA, Google sign-in and administrative diagnostics are implemented in `src/`. External providers still require their credentials and acceptance testing. Readiness does not mean every provider is configured or every vulnerability eliminated.
