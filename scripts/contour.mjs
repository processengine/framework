import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const framework = path.join(root, 'processengine');
const shop = path.join(root, 'test-shop');
const command = process.argv[2];

switch (command) {
  case 'bootstrap':
    await npm(['install', '--cache', cache('framework')], framework);
    await npm(['run', 'check'], framework);
    await npm(['run', 'check:packages'], framework);
    await npm(['install', '--cache', cache('shop')], shop);
    await npm(['run', 'check'], shop);
    break;
  case 'check':
    await npm(['run', 'check'], framework);
    await npm(['run', 'check:packages'], framework);
    await npm(['ci', '--cache', cache('shop')], shop);
    await npm(['run', 'check'], shop);
    break;
  case 'pack':
    await npm(['run', 'pack:all'], framework);
    break;
  default:
    throw new Error(`Unknown contour command: ${String(command)}`);
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
