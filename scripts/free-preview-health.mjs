import { existsSync } from 'node:fs';
import { get } from 'node:http';
if (!existsSync('/preview/ready')) process.exit(1);
const req = get({ hostname: '127.0.0.1', port: Number(process.env.PORT || 4000), path: '/api/health/ready' }, res => { res.resume(); process.exitCode = res.statusCode === 200 ? 0 : 1; });
req.setTimeout(3000, () => { req.destroy(); });
req.on('error', () => { process.exitCode = 1; });
