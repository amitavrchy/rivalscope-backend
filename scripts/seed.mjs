import { spawnSync } from 'node:child_process';
const name = process.argv.includes('--demo') ? 'seed-demo' : 'seed';
const args = process.env.NODE_ENV === 'production'
  ? [`dist/${name}.js`]
  : ['--import', 'tsx', `src/${name}.ts`];
const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
