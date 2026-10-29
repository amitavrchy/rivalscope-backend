# RivalScope API and worker

NestJS 12, Prisma 7/PostgreSQL with pgvector, Redis and BullMQ. Includes tenant authorization, MFA/Google OIDC, research and evidence review, embeddings, monitoring/watch rules, reporting, billing, integrations and platform administration.

The complete workspace, Compose configuration, deployment runbooks and Bengali manuals are in [rivalscope-ai](https://github.com/amitavrchy/rivalscope-ai). Clone that repository with `--recurse-submodules` to run the integrated product.

For this repository separately, use Node 24, PostgreSQL 17 with pgvector and Redis. Copy `.env.example` to `.env`, configure an encryption key and infrastructure URLs, then run:

```bash
npm ci
npm run db:generate
npm run db:migrate
npm run db:seed
npm run start:dev
```

Run the worker separately with `npm run worker:dev`. Google OIDC, Tavily, Stripe, SMTP, Slack/Discord and telemetry require operator configuration. Mock billing is explicit development/test configuration and is forbidden in production.

OpenAPI: `/api/docs` and `/api/docs-json`. Cookie-authenticated mutations require the configured `Origin` and JSON content type. Customer endpoints `/api/v1/projects` and `/api/v1/reports` use scoped bearer API keys.

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run build
```

Integration tests require the isolated `rivalscope_test` database and Redis database 1. Apply migrations and seed there first. Tests append unique fixtures, never truncate user data, and use deterministic provider fixtures. `TEST_DATABASE_URL` and `TEST_REDIS_URL` override test infrastructure.

Keep real credentials, generated clients, backups and production data out of Git. The Dockerfile builds the API/worker runtime; production orchestration and CI live in the shared workspace repository.
