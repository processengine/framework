import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await run('npm', ['run', 'pack:all'], root);
const directory = await mkdtemp(path.join(tmpdir(), 'processengine-consumer-'));
const packages = [
  ['@processengine/conductor', 'packages/conductor'],
  ['@processengine/transport-kafka', 'packages/transport-kafka'],
  ['@processengine/storage-postgres', 'packages/storage-postgres'],
];

try {
  const dependencies = Object.fromEntries(await Promise.all(packages.map(async ([name, packagePath]) => {
    const packageManifest = JSON.parse(await readFile(path.join(root, packagePath, 'package.json'), 'utf8'));
    const tarball = `${name.replace(/^@/u, '').replace('/', '-')}-${packageManifest.version}.tgz`;
    return [name, `file:${path.join(root, '.packages', tarball)}`];
  })));
  const manifest = {
    name: 'processengine-package-smoke',
    private: true,
    type: 'module',
    dependencies,
  };
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(directory, 'smoke.mjs'), [
    "import { compileFlow } from '@processengine/conductor';",
    "import { createMemoryStorage, createMemoryTransport } from '@processengine/conductor/testing';",
    "import { createKafkaTransport } from '@processengine/transport-kafka';",
    "import { postgresMigrations } from '@processengine/storage-postgres';",
    "const flow = compileFlow({id:'smoke',version:'1',start:'call',steps:{call:{type:'operation',operation:'smoke.call',next:'done',onError:'failed'},done:{type:'end',outcome:'DONE'},failed:{type:'end',outcome:'FAILED'}}});",
    "if (!flow.digest || !createMemoryStorage || !createMemoryTransport || !createKafkaTransport || !postgresMigrations()[0]?.statements.some((sql) => sql.includes('CREATE TABLE'))) throw new Error('public API smoke failed');",
  ].join('\n'));
  await run('npm', ['install', '--ignore-scripts', '--cache', path.join(tmpdir(), 'processengine-npm-cache')], directory);
  await run('node', ['smoke.mjs'], directory);
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}
