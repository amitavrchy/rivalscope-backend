import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const snapshot = async () => {
    const result = {};
    for (const table of ['Plan', 'User', 'Organization', 'Membership', 'Subscription', 'Project', 'Competitor']) {
      const { rows } = await client.query(`SELECT row_to_json(t) AS row FROM "${table}" t ORDER BY id`);
      result[table] = rows;
    }
    return result;
  };
  const before = await snapshot();
  for (const script of ['db:seed', 'db:seed:demo']) {
    const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', script], { stdio: 'inherit' });
    assert.equal(result.status, 0);
  }
  assert.equal(JSON.stringify(await snapshot()) === JSON.stringify(before), true, 'Seed reruns must preserve IDs, passwords and business fields');
  console.log('Seed rerun preserved every selected database row, including password hashes.');
} finally { await client.end(); }
