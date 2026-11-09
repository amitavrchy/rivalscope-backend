# Local security and deployment verification

Date: 2026-11-09. Branch: `harden/deployment-readiness`. The repository was clean at inspection; no existing uncommitted changes were overwritten. Work was independently inspected. No public deploy, resource creation, account billing change, push, history rewrite or repository visibility change was performed.

## Verified fixes and audit boundaries

- Replaced the all-in-one Render image's ephemeral PostgreSQL/Redis/Mailpit, default database credential and per-boot encryption key with the non-root application-only runtime and required external datastores. PostgreSQL/queue data now have explicit persistence requirements.
- Added credentialed exact-origin CORS and private no-store API headers. Production origins must be exact HTTPS origins. Kept strict cookie Origin/JSON checks, signed webhook exception, HttpOnly/Secure production/SameSite Lax cookie behavior and tenant authorization.
- Disabled Nest's competing default body parser so the configured bounded JSON parser retains exact raw bytes for Stripe signature verification.
- Updated vulnerable dependency chains. The Gaxios/Rimraf override is scoped; installed versions and builds/tests were checked. No forced major application dependency upgrade was applied.
- Added guarded deterministic synthetic seeding and a production-compatible compiled seed runner. Reruns leave passwords and business edits alone. Migrations no longer implicitly seed. Backup scripts now target this repository/configured database rather than missing parent-workspace Compose files.
- Removed scheduled pings to an ownership-unverified historical URL and unsafe workflow-expression shell interpolation. A manual health workflow requires an explicitly configured URL.
- Worker shutdown now waits for active maintenance before closing dependencies.

Reviewed authentication/MFA/session and account deletion paths, role/tenant policy, scoped API keys, signed webhooks, source collection/SSRF, request validation/raw SQL, report sharing/export, private reads, billing credit accounting and worker queues. Existing SSRF code pins validated public DNS results, blocks local/reserved destinations, validates redirects and forbids POST redirects; existing security tests cover unsafe URL forms. SQL tenant variables are parameterized; the static SET ROLE operation has no user input. This was code/test inspection, not production telemetry, penetration testing or a claim that all vulnerabilities are eliminated.

Tracked-file and all-branch Git-history pattern scans found no provider-key/private-key matches for the patterns examined. Connection-string matches in the current tree were local/build/test examples. The retired Render Dockerfile contained a publicly committed default PostgreSQL credential: **rotate the actual database credentials externally if that image/password was ever used**, and review access logs. Preserve/recover the previous encryption key before migrating encrypted data; generating a replacement key cannot decrypt old ciphertext. No live provider-secret inventory was available; the pattern scan is not exhaustive and history was not erased.

## Actual command outcomes

| Check | Outcome |
| --- | --- |
| `npm ci` / Prisma generation | Passed |
| Fresh migrations | All 11 passed on isolated PostgreSQL 17; pgvector extension 0.8.7 present |
| `npm run typecheck` | Passed |
| `npm test` | 38 tests passed |
| `npm run test:e2e` | 46 tests passed, including tenant substitution, credits/payment idempotency and new cache/CORS/Origin regression |
| `npm run build` | Passed |
| `npm run lint` | Windows native binding blocked by host Application Control; same command passed in Linux build container: zero warnings/errors |
| `npm audit` | Initially 8 moderate findings; final scan 0 reported findings |
| Seed and rerun | Product/demo seeds persisted successfully; row snapshot verification passed, including IDs/password hashes |
| Production image seed command | Passed; startup seed without explicit approval correctly rejected |
| `docker build -f Dockerfile.render ...` | Passed; runtime UID 1000 |
| Production container smoke | Health/readiness 200 on nondefault assigned port; anonymous private endpoint 401; no-store headers present |
| Worker smoke | Process ran against external PostgreSQL/Redis; Redis heartbeat TTL present; clean termination |
| Container shutdown/restart | API and worker termination exit 0; API restart returned readiness; data remains in separate named volumes |
| Frontend/browser compatibility | RivalScope frontend's 2 real API/proxy Playwright tests passed: registration, session, project write, sign-out, public/anonymous behavior |
| Native backup/restore scripts | Syntax checks passed; not executed because PostgreSQL CLI tools were absent on the host |

No real AI/search, Stripe, Google, SMTP delivery or external webhook was exercised. Tests use local fixtures; they do not prove a provider account is configured. OS image CVE scanning, sustained load testing, actual Render role privileges, Netlify adapter deployment, production backup restore, live telemetry and public endpoint acceptance remain release checks. No reusable production database/Redis was verified. Production Render/Netlify resource credentials, exact cost/region/plan approval and provider acceptance are blockers.

See [deployment steps and environment names](DEPLOYMENT.md) and [seed provenance](SEED-DATA.md). The changed-file inventory below records the full scope; commit IDs are available with `git log main..HEAD --oneline`.

## Changed-file inventory

- `.dockerignore`
- `.env.example`
- `.github/workflows/keep-alive.yml`
- `.gitignore`
- `DEPLOYMENT.md`
- `Dockerfile`
- `Dockerfile.render`
- `README.md`
- `SEED-DATA.md`
- `VERIFICATION.md`
- `docker-entrypoint.render.sh`
- `package-lock.json`
- `package.json`
- `scripts/backup.mjs`
- `scripts/migrate.mjs`
- `scripts/restore-check.mjs`
- `scripts/seed.mjs`
- `scripts/verify-seed.mjs`
- `src/bootstrap.ts`
- `src/config.ts`
- `src/main.ts`
- `src/seed-demo.ts`
- `src/seed.ts`
- `src/worker.ts`
- `test/app.e2e-spec.ts`
