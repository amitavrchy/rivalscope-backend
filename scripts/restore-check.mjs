import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const backup = process.argv[2]; const target = process.argv[3];
if (!backup || !target || !/^[a-zA-Z0-9_]+_restore_check$/.test(target)) throw new Error('Usage: node scripts/restore-check.mjs absolute-backup.dump unique_name_restore_check');
const bytes = readFileSync(backup); const expected = readFileSync(backup + '.sha256', 'utf8').trim();
if (createHash('sha256').update(bytes).digest('hex') !== expected || bytes.subarray(0, 5).toString() !== 'PGDMP') throw new Error('Backup checksum/format verification failed');
const username = new URL(process.env.DATABASE_URL).username;
const compose = ['compose', '-f', resolve(root, process.argv.includes('--production') ? 'docker-compose.production.yml' : 'docker-compose.yml'), 'exec', '-T', 'postgres'];
const create = spawnSync('docker', [...compose, 'createdb', '-U', username, target], { stdio: 'inherit' });
if (create.status !== 0) throw new Error('Target creation failed; existing databases are never overwritten');
const descriptor = openSync(backup, 'r');
try { const result = spawnSync('docker', [...compose, 'pg_restore', '-U', username, '-d', target, '--exit-on-error', '--no-owner', '--no-privileges'], { stdio: [descriptor, 'inherit', 'inherit'] }); if (result.status !== 0) throw new Error('Restore failed'); }
finally { closeSync(descriptor); }
const check = spawnSync('docker', [...compose, 'psql', '-U', username, '-d', target, '-tAc', 'SELECT json_build_object(\'users\',(SELECT count(*) FROM "User"),\'organizations\',(SELECT count(*) FROM "Organization"),\'projects\',(SELECT count(*) FROM "Project"))'], { encoding: 'utf8' });
if (check.status !== 0) throw new Error('Restored database validation failed');
console.log(JSON.stringify({ restoredDatabase: target, counts: JSON.parse(check.stdout.trim()), sourceBackup: backup }));
