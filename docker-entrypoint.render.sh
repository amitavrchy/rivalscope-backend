#!/usr/bin/env bash
set -euo pipefail

export PGDATA="${PGDATA:-/var/lib/postgresql/data}"
export POSTGRES_USER="${POSTGRES_USER:-rivalscope}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-rivalscope}"
export POSTGRES_DB="${POSTGRES_DB:-rivalscope}"
export DATABASE_URL="${DATABASE_URL:-postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export SMTP_URL="${SMTP_URL:-smtp://127.0.0.1:1025}"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-4000}"
export NODE_ENV="${NODE_ENV:-production}"
export BILLING_PROVIDER="${BILLING_PROVIDER:-stripe}"
export EMBEDDINGS_ENABLED="${EMBEDDINGS_ENABLED:-false}"
export MAIL_FROM="${MAIL_FROM:-RivalScope <noreply@rivalscope.local>}"

if [ -z "${ENCRYPTION_KEY:-}" ]; then
  ENCRYPTION_KEY="$(openssl rand -hex 32)"
  export ENCRYPTION_KEY
  echo "[entrypoint] Generated ephemeral ENCRYPTION_KEY for this boot"
fi

PG_BIN="$(ls -d /usr/lib/postgresql/*/bin | head -n1)"
export PATH="$PG_BIN:$PATH"

mkdir -p "$PGDATA" /var/run/postgresql /tmp/redis
chown -R postgres:postgres "$PGDATA" /var/run/postgresql

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[entrypoint] Initializing Postgres in $PGDATA"
  su -s /bin/bash postgres -c "$PG_BIN/initdb -D '$PGDATA' --auth-local=trust --auth-host=md5 --username='$POSTGRES_USER'"
  cat >> "$PGDATA/postgresql.conf" <<CONF
listen_addresses = '127.0.0.1'
port = 5432
shared_buffers = 64MB
work_mem = 4MB
maintenance_work_mem = 64MB
max_connections = 40
effective_cache_size = 128MB
wal_level = minimal
max_wal_senders = 0
checkpoint_completion_target = 0.9
CONF
  cat > "$PGDATA/pg_hba.conf" <<HBA
local   all             all                                     trust
host    all             all             127.0.0.1/32            trust
host    all             all             ::1/128                 trust
HBA
  chown postgres:postgres "$PGDATA/postgresql.conf" "$PGDATA/pg_hba.conf"
fi

echo "[entrypoint] Starting Postgres"
su -s /bin/bash postgres -c "$PG_BIN/postgres -D '$PGDATA'" &
PG_PID=$!

echo "[entrypoint] Starting Redis"
# Foreground binary backgrounded as root into /tmp (daemonize+system dirs fail on slim images)
redis-server \
  --bind 127.0.0.1 \
  --port 6379 \
  --dir /tmp/redis \
  --dbfilename dump.rdb \
  --save "" \
  --appendonly no \
  --protected-mode no \
  --daemonize no \
  --logfile /tmp/redis/redis.log \
  >/tmp/redis/stdout.log 2>&1 &
REDIS_PID=$!

echo "[entrypoint] Starting Mailpit (local SMTP)"
mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025 >/tmp/mailpit.log 2>&1 &
MAIL_PID=$!

cleanup() {
  echo "[entrypoint] Shutting down"
  kill -TERM "$MAIL_PID" 2>/dev/null || true
  kill -TERM "$REDIS_PID" 2>/dev/null || true
  kill -TERM "$PG_PID" 2>/dev/null || true
  wait "$PG_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[entrypoint] Waiting for Postgres"
for i in $(seq 1 90); do
  if pg_isready -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [ "$i" -eq 90 ]; then
    echo "[entrypoint] Postgres failed to become ready" >&2
    exit 1
  fi
done

echo "[entrypoint] Waiting for Redis"
for i in $(seq 1 30); do
  if redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null | grep -q PONG; then
    echo "[entrypoint] Redis is up"
    break
  fi
  sleep 1
  if [ "$i" -eq 30 ]; then
    echo "[entrypoint] Redis failed to become ready" >&2
    cat /tmp/redis/redis.log /tmp/redis/stdout.log 2>/dev/null || true
    exit 1
  fi
done

su -s /bin/bash postgres -c "psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U '$POSTGRES_USER' -d postgres" <<SQL
DO \$\$
BEGIN
  EXECUTE format('ALTER USER %I WITH PASSWORD %L', '$POSTGRES_USER', '$POSTGRES_PASSWORD');
EXCEPTION WHEN OTHERS THEN
  NULL;
END
\$\$;
SQL

DB_EXISTS=$(su -s /bin/bash postgres -c "psql -h 127.0.0.1 -U '$POSTGRES_USER' -d postgres -tAc \"SELECT 1 FROM pg_database WHERE datname='$POSTGRES_DB'\"" | tr -d '[:space:]')
if [ "$DB_EXISTS" != "1" ]; then
  echo "[entrypoint] Creating database $POSTGRES_DB"
  su -s /bin/bash postgres -c "$PG_BIN/createdb -h 127.0.0.1 -U '$POSTGRES_USER' '$POSTGRES_DB'"
fi

echo "[entrypoint] Ensuring pgvector extension"
su -s /bin/bash postgres -c "psql -h 127.0.0.1 -U '$POSTGRES_USER' -d '$POSTGRES_DB' -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS vector;'"

cd /app
echo "[entrypoint] prisma migrate deploy"
npx prisma migrate deploy

echo "[entrypoint] seed plans/permissions"
npm run db:seed || npx tsx prisma/seed.ts || npx tsx src/seed.ts || true

echo "[entrypoint] Starting BullMQ worker"
node dist/worker.js >/tmp/worker.log 2>&1 &
WORKER_PID=$!

echo "[entrypoint] Starting Nest API on ${HOST}:${PORT}"
exec node dist/main.js