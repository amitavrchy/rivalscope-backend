#!/bin/sh
set -eu
: "${DATABASE_URL:?Set external persistent DATABASE_URL}"
: "${REDIS_URL:?Set external persistent REDIS_URL}"
if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then npm run db:migrate; fi
if [ "${SEED_ON_START:-false}" = "true" ]; then
  [ "${ALLOW_PRODUCTION_SEED:-false}" = "true" ] || { echo 'Explicit seed approval is required' >&2; exit 1; }
  npm run db:seed
fi
exec "$@"
