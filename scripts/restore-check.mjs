import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const backup = process.argv[2]; const target = process.argv[3];
if (!backup || !target || !/^[a-zA-Z0-9_]+_restore_check$/.test(target)) throw new Error('Usage: node scripts/restore-check.mjs absolute-backup.dump unique_name_restore_check');
const bytes = readFileSync(backup); const expected = readFileSync(backup + '.sha256', 'utf8').trim();
if (createHash('sha256').update(bytes).digest('hex') !== expected || bytes.subarray(0, 5).toString() !== 'PGDMP') throw new Error('Backup checksum/format verification failed');
const url = new URL(process.env.DATABASE_URL);
if (decodeURIComponent(url.pathname.slice(1)) === target) throw new Error('Restore target must differ from source');
const pgEnv = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), ...(url.searchParams.has('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode') } : {}) };
const create = spawnSync('createdb', [target], { env: pgEnv, stdio: 'ignore' });
if (create.status !== 0) throw new Error('Target creation failed; existing databases are never overwritten');
const descriptor = openSync(backup, 'r');
try { const result = spawnSync('pg_restore', ['-d', target, '--exit-on-error', '--no-owner', '--no-privileges'], { env: pgEnv, stdio: [descriptor, 'ignore', 'ignore'] }); if (result.status !== 0) throw new Error('Restore failed'); }
finally { closeSync(descriptor); }
const check = spawnSync('psql', ['-d', target, '-tAc', 'SELECT json_build_object(\'users\',(SELECT count(*) FROM "User"),\'organizations\',(SELECT count(*) FROM "Organization"),\'projects\',(SELECT count(*) FROM "Project"))'], { env: pgEnv, encoding: 'utf8' });
if (check.status !== 0) throw new Error('Restored database validation failed');
console.log(JSON.stringify({ restoredDatabase: target, counts: JSON.parse(check.stdout.trim()), sourceBackup: backup }));
