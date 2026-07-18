import { mkdir, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, '.packages');
const packages = [
  './packages/conductor',
  './packages/transport-kafka',
  './packages/storage-postgres',
];

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

for (const packagePath of packages) {
  await run('npm', ['pack', packagePath, '--pack-destination', destination], root);
}

const files = (await readdir(destination)).filter((name) => name.endsWith('.tgz')).sort();
if (files.length !== packages.length) {
  throw new Error(`Expected ${packages.length} packages, found ${files.length}`);
}
console.log(files.join('\n'));

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, npm_config_cache: path.join(root, '.npm-cache') },
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}
