import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageLocalConsumer, localConsumerDir } from '../test-shop/scripts/consumer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const framework = path.join(root, 'processengine');
const shop = path.join(root, 'test-shop');
const command = process.argv[2];

switch (command) {
  case 'bootstrap':
    await frameworkGate();
    await npm(['install', '--cache', cache('shop')], shop);
    await npm(['run', 'check'], shop);
    break;
  case 'check':
  case 'check:registry': {
    banner('registry', 'exact published @processengine/* from the committed manifest + lockfile');
    const baseline = trackedStatus();
    await frameworkGate();
    await npm(['ci', '--cache', cache('shop')], shop);
    await npm(['run', 'check'], shop);
    assertNoNewDirt(baseline);
    break;
  }
  case 'check:local': {
    banner('local', 'framework tarballs built from the current worktree, staged under .work/local-consumer');
    const baseline = trackedStatus();
    await frameworkGate();
    await stageLocalConsumer({ install: true });
    await npm(['run', 'check'], localConsumerDir);
    assertNoNewDirt(baseline);
    break;
  }
  case 'pack':
    await npm(['run', 'pack:all'], framework);
    break;
  default:
    throw new Error(`Unknown contour command: ${String(command)}`);
}

async function frameworkGate() {
  await npm(['install', '--cache', cache('framework')], framework);
  await npm(['run', 'check'], framework);
  await npm(['run', 'api:check'], framework);
  await npm(['run', 'check:packages'], framework);
}

function banner(mode, source) {
  console.log(`\n=== test-shop deterministic gate: mode=${mode} ===\n    source: ${source}\n`);
}

// Tracked-file porcelain status, ignoring untracked files (`.work/`, caches and
// generated tarballs are gitignored anyway). The gate must not introduce *new*
// tracked-file changes; pre-existing user edits are allowed.
function trackedStatus() {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' });
}

function assertNoNewDirt(baseline) {
  const current = trackedStatus();
  const before = new Set(baseline.split('\n').filter(Boolean));
  const added = current.split('\n').filter(Boolean).filter((line) => !before.has(line));
  if (added.length > 0) {
    throw new Error(`The gate rewrote tracked files (not allowed):\n${added.join('\n')}`);
  }
}

function cache(name) {
  return path.join(root, '.npm-cache', name);
}

function npm(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`npm ${args.join(' ')} exited with ${code}`)));
  });
}
