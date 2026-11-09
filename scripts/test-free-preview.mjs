// Local, finite Docker acceptance test. Creates only disposable owned containers.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const project = 'rivalscope';
const image = project + '-free-preview';
const healthPath = project === 'rivalscope' ? '/api/health/ready' : '/api/health';
const owned = [];
const env = { ...process.env, PREVIEW_LOGIN_EMAIL: randomBytes(12).toString('hex') + '@synthetic.invalid', PREVIEW_LOGIN_PASSWORD: randomBytes(24).toString('base64url') };
const report = { project, image, tested_at_utc: new Date().toISOString(), memory_limit_bytes: 512 * 1024 * 1024, memory_swap_limit_bytes: 512 * 1024 * 1024, cpus: 1, memory_observations: [], checks: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function docker(args) { return execFileSync('docker', args, { env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function state(name) { return JSON.parse(docker(['inspect', '--format', '{{json .State}}', name])); }
function memory(name, phase) {
  const lines = docker(['exec', name, 'sh', '-c', 'cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.events']).split('\n');
  const observation = { phase, current_bytes: Number(lines[0]), peak_bytes: Number(lines[1]), events: Object.fromEntries(lines.slice(2).map(line => { const [key,value] = line.split(' '); return [key, Number(value)]; })) };
  report.memory_observations.push(observation);
  assert.equal(observation.events.oom, 0, 'No cgroup OOM event permitted');
  assert.equal(observation.events.oom_kill, 0, 'No cgroup OOM kill permitted');
  assert.ok(observation.peak_bytes <= report.memory_limit_bytes);
}
function launch(suffix) {
  const name = project + '-free-preview-acceptance-' + process.pid + '-' + suffix;
  const args = ['run', '-d', '--name', name, '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '128', '-p', '127.0.0.1::4567',
    '-e', 'FREE_PREVIEW=true', '-e', 'ALLOW_PRODUCTION_SEED=true', '-e', 'SEED_ON_START=true', '-e', 'PORT=4567',
    '-e', 'PREVIEW_LOGIN_EMAIL', '-e', 'PREVIEW_LOGIN_PASSWORD'];
  args.push(...(project === 'rivalscope' ? ['-e', 'APP_ORIGIN=https://preview-test.invalid'] : ['-e', 'APP_URL=https://preview-test.invalid', '-e', 'CORS_ORIGINS=https://preview-test.invalid']));
  owned.push(name); docker([...args, image]);
  const host = JSON.parse(docker(['inspect', '--format', '{{json .HostConfig}}', name]));
  assert.equal(host.Memory, report.memory_limit_bytes); assert.equal(host.MemorySwap, report.memory_swap_limit_bytes);
  const ports = JSON.parse(docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name]));
  const binding = ports['4567/tcp'][0];
  assert.equal(binding.HostIp, '127.0.0.1');
  return { name, url: 'http://127.0.0.1:' + binding.HostPort + healthPath };
}
async function ready(container) {
  const bindings = JSON.parse(docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', container.name]));
  container.url = 'http://127.0.0.1:' + bindings['4567/tcp'][0].HostPort + healthPath;
  const start = Date.now();
  while (Date.now() - start < 240000) {
    assert.equal(state(container.name).Running, true, 'Required supervised processes must remain alive');
    try { const response = await fetch(container.url, { signal: AbortSignal.timeout(2000) }); if (response.status === 200) return Math.round((Date.now() - start) / 100) / 10; } catch {}
    await sleep(500);
  }
  throw new Error('Preview readiness timed out');
}
function smoke(container, flag) {
  const output = docker(['exec', container.name, 'node', '--max-old-space-size=64', '--max-semi-space-size=4', 'scripts/free-preview-smoke.mjs', ...(flag ? [flag] : [])]);
  console.log(output);
}
try {
  report.image_id = docker(['image', 'inspect', '--format', '{{.Id}}', image]);
  const first = launch('first');
  report.cold_boot_seconds = await ready(first);
  memory(first.name, 'cold-boot-ready');
  smoke(first);
  memory(first.name, 'authenticated-writes-and-worker');
  report.checks.push('fresh migrations/seeds, private stores, real authenticated writes, fail-closed security and worker');
  docker(['restart', '--timeout', '30', first.name]);
  report.same_container_restart_seconds = await ready(first);
  smoke(first, '--verify-restart');
  memory(first.name, 'restart-reseed');
  report.checks.push('same-container restart/reseed preserves IDs, business edits and password hashes');
  docker(['stop', '--timeout', '30', first.name]);
  assert.equal(state(first.name).ExitCode, 0, 'SIGTERM must shut down cleanly');
  assert.equal(state(first.name).OOMKilled, false);
  report.checks.push('clean SIGTERM exit 0');

  const fresh = launch('replacement');
  report.replacement_boot_seconds = await ready(fresh);
  smoke(fresh, '--replacement');
  memory(fresh.name, 'fresh-replacement');
  report.checks.push('replacement without volumes creates fresh synthetic data and private login');
  const pidFile = project === 'rivalscope' ? '/preview/worker.pid' : '/preview/api.pid';
  const pid = docker(['exec', fresh.name, 'cat', pidFile]);
  assert.match(pid, /^[0-9]+$/);
  docker(['exec', fresh.name, 'bash', '-c', 'kill -KILL "$1"', 'preview-test', pid]);
  for (let attempt = 0; attempt < 90 && state(fresh.name).Running; attempt++) await sleep(500);
  const failed = state(fresh.name);
  assert.equal(failed.Running, false); assert.equal(failed.ExitCode, 1); assert.equal(failed.OOMKilled, false);
  report.checks.push('unexpected required child failure stops siblings and exits 1');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = 'Local acceptance failed; inspect sanitized test output. No credentials are recorded.';
  console.error(error instanceof Error ? error.message : 'Acceptance failed');
  for (const name of owned) {
    try { report.failure_state = state(name); if (report.failure_state.Running) memory(name, 'failure-diagnostics'); } catch {}
    try {
      const logs = (() => { const result = spawnSync('docker', ['logs', '--tail', '20', name], { encoding: 'utf8' }); return (result.stdout || '') + (result.stderr || ''); })().replace(/(?:postgresql|redis):\/\/\S+/g, '[redacted datastore URL]').replace(/[a-f0-9]{64}/gi, '[redacted hex]');
      console.error(logs);
    } catch {}
  }
  process.exitCode = 1;
} finally {
  for (const name of owned) { try { docker(['rm', '-f', name]); } catch {} }
  report.peak_observed_bytes = Math.max(0, ...report.memory_observations.map(item => item.peak_bytes));
  writeFileSync(new URL('../FREE-PREVIEW-TEST-RESULTS.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
