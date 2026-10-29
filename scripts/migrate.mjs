import { spawnSync } from 'node:child_process';
for (const [command, args] of [['node', ['node_modules/prisma/build/index.js', 'migrate', 'deploy']], ['node', ['dist/seed.js']]]) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
