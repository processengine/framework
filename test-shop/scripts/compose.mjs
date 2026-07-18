import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compose = path.join(shop, 'deploy/compose.yaml');
const args = ['compose', '--file', compose];

function docker(command, options = {}) {
  const result = spawnSync('docker', [...args, ...command], { cwd: shop, encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit' });
  if (result.status !== 0) throw new Error(`docker ${[...args, ...command].join(' ')} failed: ${(result.stderr || '').trim()}`);
  return (result.stdout ?? '').trim();
}

function urlFor(service, port) {
  const address = docker(['port', service, String(port)], { capture: true }).split('\n')[0]?.trim();
  const match = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)$/u.exec(address ?? '');
  if (!match?.[1]) throw new Error(`Cannot parse dynamic port for ${service}:${port}: ${address}`);
  return `http://127.0.0.1:${match[1]}`;
}

const command = process.argv[2];
if (command === 'doctor') {
  spawnSync('docker', ['version'], { stdio: 'inherit' });
  docker(['config', '--quiet']);
} else if (command === 'up') {
  docker(['up', '--detach', '--build', '--wait', '--wait-timeout', '300']);
  docker(['ps', '--all']);
} else if (command === 'test') {
  const urls = {
    host: urlFor('shop-host', 3000),
    warehouse: urlFor('shop-warehouse', 8081),
    payment: urlFor('shop-payment', 8082),
  };
  const result = spawnSync(process.execPath, [
    path.join(shop, 'scripts/acceptance.mjs'),
    '--base-url', urls.host,
    '--warehouse-url', urls.warehouse,
    '--payment-url', urls.payment,
  ], { cwd: shop, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`acceptance exited with ${result.status}`);
} else if (command === 'status') {
  docker(['ps', '--all']);
} else if (command === 'down') {
  docker(['down', '--remove-orphans']);
} else {
  throw new TypeError('Usage: node scripts/compose.mjs <doctor|up|test|status|down>');
}

