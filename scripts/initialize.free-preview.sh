#!/usr/bin/env bash
set -Eeuo pipefail
export NODE_OPTIONS="--max-old-space-size=128 --max-semi-space-size=4"
node node_modules/prisma/build/index.js migrate deploy
node dist/seed.js
node dist/seed-demo.js
node scripts/bootstrap.free-preview.mjs
