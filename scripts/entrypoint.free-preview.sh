#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
preview_project=rivalscope
children=()
apps=()
pg_pid=""
redis_pid=""

stop_group() {
  local pid="$1"
  kill -TERM -- "-$pid" 2>/dev/null || true
}
shutdown() {
  trap - EXIT TERM INT
  rm -f /preview/ready
  for pid in "${apps[@]}"; do stop_group "$pid"; done
  local until=$((SECONDS + 20))
  for pid in "${apps[@]}"; do
    while kill -0 "$pid" 2>/dev/null && (( SECONDS < until )); do sleep 0.2; done
    if kill -0 "$pid" 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || true; fi
    wait "$pid" 2>/dev/null || true
  done
  # Datastores are stopped only after application connections/jobs have closed.
  [[ -z "$redis_pid" ]] || kill -TERM "$redis_pid" 2>/dev/null || true
  [[ -z "$pg_pid" ]] || kill -TERM "$pg_pid" 2>/dev/null || true
  until=$((SECONDS + 8))
  for pid in "$redis_pid" "$pg_pid"; do
    [[ -n "$pid" ]] || continue
    while kill -0 "$pid" 2>/dev/null && (( SECONDS < until )); do sleep 0.2; done
    if kill -0 "$pid" 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || true; fi
    wait "$pid" 2>/dev/null || true
  done
}
trap 'exit 0' TERM INT
trap 'result=$?; shutdown; exit "$result"' EXIT

[[ "${FREE_PREVIEW:-}" == true && "${ALLOW_PRODUCTION_SEED:-}" == true && "${SEED_ON_START:-}" == true ]] || {
  echo "Preview requires FREE_PREVIEW, ALLOW_PRODUCTION_SEED and SEED_ON_START opt-ins" >&2; exit 1;
}
: "${PREVIEW_LOGIN_PASSWORD:=}"
[[ -n "${PREVIEW_LOGIN_EMAIL:-}" && ${#PREVIEW_LOGIN_PASSWORD} -ge 16 ]] || {
  echo "Set private PREVIEW_LOGIN_EMAIL and a strong PREVIEW_LOGIN_PASSWORD" >&2; exit 1;
}
export NODE_ENV=production NODE_OPTIONS="--max-old-space-size=96 --max-semi-space-size=4" UV_THREADPOOL_SIZE=2
export PORT="${PORT:-4000}"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT > 1024 && PORT <= 65535 && PORT != 5432 && PORT != 6379 )) || {
  echo "PORT must be an unprivileged HTTP port distinct from the internal stores" >&2; exit 1;
}
# Preview cannot call paid providers or send external email, even if old service settings remain.
unset SMTP_URL GEMINI_API_KEY OPENAI_API_KEY TAVILY_API_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET
unset GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET OTEL_EXPORTER_OTLP_ENDPOINT SENTRY_DSN
export EMBEDDINGS_ENABLED=false BILLING_PROVIDER=stripe
export PGDATA=/preview/postgres
mkdir -p "$PGDATA" /preview/run /preview/redis
rm -f /preview/ready
make_secret() {
  local file="/preview/$1"
  if [[ ! -s "$file" ]]; then node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" > "$file"; fi
  chmod 600 "$file"
}
for name in database.key redis.key encryption.key jwt.key seed.key; do make_secret "$name"; done
db_password="$(cat /preview/database.key)"
redis_password="$(cat /preview/redis.key)"
export ENCRYPTION_KEY="${ENCRYPTION_KEY:-$(cat /preview/encryption.key)}"
export JWT_SECRET="${JWT_SECRET:-$(cat /preview/jwt.key)}"
export SEED_PASSWORD="$(cat /preview/seed.key)"
export DATABASE_URL="postgresql://preview_app:$db_password@127.0.0.1:5432/preview"
if [[ "$preview_project" == sitecraft ]]; then export DATABASE_URL="$DATABASE_URL?connection_limit=4&pool_timeout=10"; fi
export REDIS_URL="redis://:$redis_password@127.0.0.1:6379"
export REDISCLI_AUTH="$redis_password"

if [[ ! -s "$PGDATA/PG_VERSION" ]]; then
  initdb -D "$PGDATA" --username=node --auth-local=peer --auth-host=scram-sha-256 --encoding=UTF8 --locale=C >/dev/null
fi
setsid postgres -D "$PGDATA" -h 127.0.0.1 -p 5432 -k /preview/run \
  -c shared_buffers=16MB -c max_connections=16 -c work_mem=1MB -c maintenance_work_mem=16MB \
  -c temp_buffers=1MB -c wal_buffers=1MB -c max_wal_size=64MB -c min_wal_size=32MB \
  -c max_worker_processes=2 -c max_parallel_workers=0 -c autovacuum_max_workers=1 \
  -c autovacuum_work_mem=8MB -c log_min_error_statement=panic -c log_statement=none &
pg_pid=$!; children+=("$pg_pid")
cat > /preview/redis.conf <<CONF
bind 127.0.0.1
protected-mode yes
port 6379
requirepass $redis_password
dir /preview/redis
maxmemory 24mb
maxmemory-policy noeviction
save ""
appendonly yes
appendfsync everysec
auto-aof-rewrite-percentage 0
CONF
setsid redis-server /preview/redis.conf &
redis_pid=$!; children+=("$redis_pid")
ready=false
for attempt in {1..120}; do
  kill -0 "$pg_pid" 2>/dev/null && kill -0 "$redis_pid" 2>/dev/null || { echo "Internal datastore exited" >&2; exit 1; }
  if pg_isready -q -h /preview/run -U node -d postgres && redis-cli ping 2>/dev/null | grep -qx PONG; then ready=true; break; fi
  sleep 0.5
done
[[ "$ready" == true ]] || { echo "Internal datastore readiness timed out" >&2; exit 1; }
# Only this bootstrap command handles a database password; never echo SQL or the URL.
psql -X -h /preview/run -U node -d postgres -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<SQL
SELECT 'CREATE ROLE preview_app LOGIN NOSUPERUSER NOBYPASSRLS' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='preview_app')\gexec
ALTER ROLE preview_app CREATEROLE PASSWORD '$db_password';
SELECT 'CREATE DATABASE preview OWNER preview_app' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='preview')\gexec
SQL
if [[ "$preview_project" == rivalscope ]]; then
  psql -X -h /preview/run -U node -d preview -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS vector' >/dev/null
fi
# This private file permits in-container verification without leaking generated credentials.
node -e "const fs=require('node:fs');const names=['DATABASE_URL','REDIS_URL','NODE_ENV','FREE_PREVIEW','ALLOW_PRODUCTION_SEED','SEED_ON_START','APP_ORIGIN','APP_URL','CORS_ORIGINS','ENCRYPTION_KEY','JWT_SECRET','EMBEDDINGS_ENABLED','PORT','SEED_PASSWORD','PREVIEW_LOGIN_EMAIL','PREVIEW_LOGIN_PASSWORD'];fs.writeFileSync('/preview/runtime.json',JSON.stringify(Object.fromEntries(names.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))),{mode:0o600})"
setsid bash /app/scripts/initialize.free-preview.sh &
initializer=$!; children+=("$initializer"); apps+=("$initializer")
result=0; exited=""
wait -n -p exited "${children[@]}" || result=$?
[[ "$exited" == "$initializer" && "$result" == 0 ]] || { echo "Preview initialization or datastore failed" >&2; exit 1; }
apps=()
children=("$pg_pid" "$redis_pid")
psql -X -h /preview/run -U node -d postgres -v ON_ERROR_STOP=1 -c 'ALTER ROLE preview_app NOCREATEROLE NOCREATEDB' >/dev/null
if [[ "$preview_project" == rivalscope ]]; then redis-cli DEL rs:worker:heartbeat >/dev/null; fi
setsid node --max-old-space-size=80 dist/main.js &
api_pid=$!; children+=("$api_pid"); apps+=("$api_pid")
echo "$api_pid" > /preview/api.pid
if [[ "$preview_project" == rivalscope ]]; then
  setsid node --max-old-space-size=64 dist/worker.js &
  worker_pid=$!; children+=("$worker_pid"); apps+=("$worker_pid")
  echo "$worker_pid" > /preview/worker.pid
fi
touch /preview/ready
echo "Disposable free preview processes started; readiness still checks live dependencies"
# Any unexpected child exit (including exit 0) fails the whole preview.
result=0
wait -n "${children[@]}" || result=$?
echo "A required preview process exited; stopping siblings" >&2
exit 1
