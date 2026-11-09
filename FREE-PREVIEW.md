# RivalScope: one-container Render Free preview

This is the explicitly approved disposable preview exception to the durable deployment guide. PostgreSQL, pgvector, Redis, API and the separate BullMQ worker run in **one** container. No external database, separate worker service, paid integration, disk, billing setup or keepalive is needed. Nothing was deployed by this task.

Use only synthetic/nonessential data. Render sleep stops the processes and pauses jobs. Cold startup initializes stores, migrates and seeds before readiness; it can take time. Render can replace the filesystem on restart, spin-down or redeploy: accounts, uploads, research, queues and business edits can reset. Persistence, missed-job catch-up and always-on operation are not promised. See [Render's Free limitations](https://render.com/docs/free).

## Exact Render settings

| Setting | Value |
| --- | --- |
| Workspace | `Heyhoo` |
| Repository | `amitavrchy/rivalscope-backend` |
| Branch | `harden/deployment-readiness` |
| Service type / plan | Web Service / Free |
| Runtime | Docker |
| Root Directory | Empty |
| Dockerfile path | `./Dockerfile.render.free-preview` |
| Docker build context | `.` — this repository root |
| Docker command override | Empty; retain the image entrypoint |
| Pre-deploy command | Empty; guarded startup performs migrations/seeds |
| Health check path | `/api/health/ready` |
| Disk / other services | None |

The existing `Dockerfile` and `Dockerfile.render` are unchanged external-database targets. Do not select them for this preview. The preview runs as UID 1000. Only HTTP binds all interfaces on the assigned port; PostgreSQL and Redis bind loopback and are not published.

## Environment-variable names

Required names, with private values supplied through Render's environment settings:

- `FREE_PREVIEW`
- `ALLOW_PRODUCTION_SEED`
- `SEED_ON_START`
- `APP_ORIGIN`
- `PREVIEW_LOGIN_EMAIL`
- `PREVIEW_LOGIN_PASSWORD`

Optional names: `PORT`, `ALLOWED_ORIGINS`, `ENCRYPTION_KEY`.

Enable all three preview/seed flags explicitly. Use the real HTTPS Netlify/custom frontend origin; extra allowed origins must be exact HTTPS origins too. Supply a private valid login email and a strong password of at least 16 characters. Never put these credentials in Git, reports, screenshots or public demo instructions. There is no public default administrator password.

The preview generates private internal datastore credentials and an encryption key under `/preview` if needed; they survive a same-container Docker restart, but not replacement. It overrides datastore destinations to its internal stores and removes AI/search/Stripe/Google/SMTP/telemetry credentials from application processes. External integrations cannot be accidentally enabled by retained service settings. Do not configure external `DATABASE_URL`, `REDIS_URL` or SMTP for this target.

## Startup, authentication and shutdown

Startup requires the opt-ins, initializes PostgreSQL 15 and Redis, waits for both, enables pgvector 0.8.2, applies all migrations, runs the existing guarded product/synthetic seeds, then bootstraps the private preview login. PostgreSQL credentials are never logged. The application database role is not a superuser and loses role-creation privileges after migration.

The private account is a tenant owner in a separate synthetic interactive workspace and a viewer in the three seeded research studios. It is **not** a platform administrator and its email remains unverified. Existing identities/passwords/business edits are never reset by reseeding. If its email is changed, supplied identity settings must match; namespace conflicts fail rather than overwriting users. A replacement initializes the original supplied credentials again because it is a new disposable database.

Login and authorized project CRUD are real. SMTP is unavailable: registration/verification/reset paths that require mail fail honestly and registration rolls back. Research remains blocked for an unverified account. AI/search providers, payments and Google sign-in are unavailable; no successful delivery, research run or payment is fabricated. Normal production still requires SMTP, and mock billing is still forbidden. The Netlify UI displays actual API errors.

The Bash supervisor detects unexpected PostgreSQL/Redis/API/worker exits and shuts siblings down with a nonzero status. SIGTERM stops API/worker process groups before Redis/PostgreSQL and waits for clean termination, with bounded escalation. Readiness checks the database, Redis-backed protection and a fresh worker heartbeat; the API is not started until migration/seeding succeeds.

## Memory budget and local verification

Runtime Node old-space heaps are capped at 80 MiB for the API and 64 MiB for the worker, with 4 MiB semi-spaces; initializer heap at 128 MiB; database pools at four connections per runtime. Preview worker concurrency is one. PostgreSQL uses 16 MiB shared buffers, 16 connections, 1 MiB work memory, bounded maintenance/autovacuum settings and no parallel queries. Redis has a 24 MiB allocation budget and `noeviction`: full queues fail commands instead of silently losing keys. AOF is internal/ephemeral; automatic rewrite/snapshot forks are disabled. No persistence guarantee follows from AOF.

Argon2's normal work factor is preserved. Preview serializes expensive auth/account/privacy writes with an explicit busy response rather than allocating multiple native hashes at once. Telemetry libraries load only when configured. Large exports, high concurrency or large datasets can still exceed this small budget; this is not a production capacity claim.

Build and run the finite local acceptance test from this repository root:

```sh
docker build -f Dockerfile.render.free-preview -t rivalscope-free-preview .
node scripts/test-free-preview.mjs
```

The harness generates private temporary credentials without printing them, enforces 512 MiB RAM with no extra swap, uses one CPU, and removes only its own disposable test containers. It checks migrations/seeds, loopback stores, HTTP port binding, real authenticated writes/archive/restore, fail-closed Origin/mail/research/billing behavior, real BullMQ cancellation processing, same-container restart/reseed/password preservation, replacement reset, graceful shutdown and worker-failure supervision. It records cgroup peaks/OOM counters in [FREE-PREVIEW-TEST-RESULTS.json](FREE-PREVIEW-TEST-RESULTS.json). A cancelled fixture demonstrates queue execution, not completed AI research.

For a build under a local 512 MiB BuildKit-container cap as well, create a dedicated builder with `--driver docker-container`, `--driver-opt memory=512m`, `--driver-opt memory-swap=512m`, and `--buildkitd-config scripts/buildkit.free-preview.toml`, then use `docker buildx build --builder <dedicated-builder-name> --load` with the same Dockerfile/context/tag. The configuration serializes build steps; the build-stage Node heap is bounded separately. Preview JavaScript is emitted per file with the same TypeScript decorator metadata settings to bound compiler memory. Full `npm run typecheck` is a separate required check and was run; the external-store Dockerfiles retain the normal Nest build. This does not change the existing default builder or Render's build infrastructure.

Local runtime tests use one CPU, not Render Free's smaller CPU share. They do not establish real Render cold-start time, sustained-load safety or actual Netlify HTTPS proxy behavior. Consult the result artifact and test notes before claiming success.

## Deployment steps for the operator

1. Select the pushed branch and exact Render settings above. Choose only Free; do not add a database service, external provider, disk, separate worker or payment method. Leave automatic deployment off until ready to deploy deliberately.
2. Supply the required environment names privately and enable the explicit opt-ins. Set the actual frontend HTTPS origin; do not invent a hosting URL.
3. Deploy manually only when you choose to. Wait for `/api/health/ready`; inspect startup errors if it does not become ready. Free cold starts can exceed local timings.
4. After Render assigns the real HTTPS backend URL, set the frontend's server-only `API_INTERNAL_URL` to that actual backend origin and rebuild Netlify. Keep the same-origin `/api` proxy and backend exact-origin protection. No frontend code change is required.
5. Check the actual frontend proxy, cookie flags, private login, project CRUD and a worker heartbeat. Research/email/payment unavailability must remain explicit. Do not publish preview credentials or interpret synthetic studios as real customers.
6. Accept resets on sleep/restart/replacement and jobs running only while awake. Do not install uptime pings, keepalive actions or schedulers to defeat sleeping. A local acceptance pass is not a successful public deployment.

## Recorded local outcome (2026-11-09)

Final runtime acceptance: **passed**, with a configured 512 MiB memory limit and no additional swap. Peak cgroup memory: **512.0 MiB**. Every recorded phase had zero `oom` and `oom_kill` events. Fresh boot/restart/replacement readiness took 15.3/11.8/15.7 seconds locally with one CPU. These are measured local timings, not Render promises. Both final Docker builds also completed in a dedicated BuildKit container configured with 512 MiB RAM/no extra swap and serialized build steps.

RivalScope reached the memory ceiling and caused cgroup reclaim events. There is little tested peak headroom; high concurrency, larger datasets/exports and actual Free CPU performance remain unverified. Earlier full-program compiler attempts exhausted the 256 MiB V8 build heap (and another compile was stopped under pressure); the final per-file emitter build passed. A previous smoke connection closed before its OOM state was captured, so that event is not labelled a confirmed kernel OOM or a pass. The final smaller API/worker/young-generation profile passed all measured phases.

Full source typecheck, 43 unit tests, 46 PostgreSQL/Redis integration tests and Linux oxlint passed; npm audit reported zero findings. Optional provider delivery/research/payments were intentionally not exercised as successful integrations. Early harness issues included the required JSON DELETE body and tracking Docker's reassigned random host port after restart; these were corrected before the final acceptance run. Tests use actual responses and no success mocks.

Actual hosted endpoints, Netlify HTTPS cookie/proxy behavior, sustained-load safety and real-world provider integrations remain untested because deployment was explicitly excluded. The existing external-store production Dockerfiles and entrypoints are unchanged. Neither frontend repository/app needed a compatibility code change.

A later integration recheck had 45 passes and one timeout, and its accompanying npm audit failed on DNS resolution. The subsequent complete rerun passed all 46 tests and npm audit completed with zero findings. No timeout threshold or financial assertion was weakened.
