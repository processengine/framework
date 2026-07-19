import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildImages, contentTag } from './images.mjs';
import { prepareBuild, resolveMode, writeSourceManifest } from './consumer.mjs';

const shop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compose = path.join(shop, 'deploy/compose.yaml');
const args = ['compose', '--file', compose];

function docker(command, options = {}) {
  const result = spawnSync('docker', [...args, ...command], {
    cwd: shop, encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.status !== 0) throw new Error(`docker ${[...args, ...command].join(' ')} failed: ${(result.stderr || '').trim()}`);
  return (result.stdout ?? '').trim();
}

function urlFor(service, port) {
  const address = docker(['port', service, String(port)], { capture: true }).split('\n')[0]?.trim();
  const match = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)$/u.exec(address ?? '');
  if (!match?.[1]) throw new Error(`Cannot parse dynamic port for ${service}:${port}: ${address}`);
  return `http://127.0.0.1:${match[1]}`;
}

function runAcceptance() {
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
}

async function deploy(mode) {
  const build = await prepareBuild(mode);
  await buildImages({ contextDir: build.contextDir, contentTag: build.contentTag });
  const tag = await contentTag({ contentTag: build.contentTag, contextDir: build.contextDir });
  const directory = path.join(shop, '.artifacts', 'compose', `${new Date().toISOString().replaceAll(':', '-')}-${mode}`);
  const manifest = { ...build.manifest, imageContentTag: tag };
  const manifestFile = await writeSourceManifest(directory, manifest);
  console.log(`\n=== Compose deploy: mode=${mode}, imageContentTag=${tag} ===\n    source manifest: ${manifestFile}\n`);
  // No --build: consume the images our mode-aware builder just produced.
  docker(['up', '--detach', '--wait', '--wait-timeout', '300'], { env: { TEST_SHOP_IMAGE_TAG: tag } });
  docker(['ps', '--all'], { env: { TEST_SHOP_IMAGE_TAG: tag } });
  runAcceptance();
}

const command = process.argv[2];
if (command === 'doctor') {
  spawnSync('docker', ['version'], { stdio: 'inherit' });
  docker(['config', '--quiet']);
} else if (command === 'deploy') {
  await deploy(resolveMode(process.argv[3]));
} else if (command === 'up') {
  docker(['up', '--detach', '--build', '--wait', '--wait-timeout', '300']);
  docker(['ps', '--all']);
} else if (command === 'test') {
  runAcceptance();
} else if (command === 'status') {
  docker(['ps', '--all']);
} else if (command === 'down') {
  docker(['down', '--remove-orphans']);
} else {
  throw new TypeError('Usage: node scripts/compose.mjs <doctor|deploy <local|registry>|up|test|status|down>');
}
