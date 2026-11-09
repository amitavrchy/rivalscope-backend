import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = new URL(process.env.DATABASE_URL);
const database = decodeURIComponent(url.pathname.slice(1));
const pgEnv = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: database, ...(url.searchParams.has('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode') } : {}) };
const username = new URL(process.env.DATABASE_URL).username;
if (!/^[a-zA-Z0-9_]+$/.test(database) || !/^[a-zA-Z0-9_]+$/.test(username)) throw new Error('Invalid database name/user');
const destination = resolve(root, 'backups', `${database}-${new Date().toISOString().replaceAll(':', '-')}.dump`);
mkdirSync(dirname(destination), { recursive: true });
const descriptor = openSync(destination, 'wx', 0o600);
try {
  const result = spawnSync('pg_dump', ['-Fc', '--no-owner', '--no-privileges'], { env: pgEnv, stdio: ['ignore', descriptor, 'ignore'] });
  if (result.status !== 0) throw new Error('pg_dump failed');
} finally { closeSync(descriptor); }
const bytes = readFileSync(destination); if (bytes.subarray(0, 5).toString() !== 'PGDMP') throw new Error('Backup format validation failed');
writeFileSync(destination + '.sha256', createHash('sha256').update(bytes).digest('hex') + '\n', { mode: 0o600 });
console.log(JSON.stringify({ backup: destination, bytes: bytes.length, checksum: destination + '.sha256', note: 'Backup contains private data. Use encrypted restricted backup storage in production.' }));
