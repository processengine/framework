import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(root, 'node_modules', '.bin', 'tsc');

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

  // 1) Runtime import smoke: the published JS actually loads and works.
  await writeFile(path.join(directory, 'smoke.mjs'), [
    "import { compileFlow } from '@processengine/conductor';",
    "import { createMemoryStorage, createMemoryTransport } from '@processengine/conductor/testing';",
    "import { createKafkaTransport } from '@processengine/transport-kafka';",
    "import { postgresMigrations } from '@processengine/storage-postgres';",
    "const flow = compileFlow({id:'smoke',version:'1',start:'call',steps:{call:{type:'operation',operation:'smoke.call',next:'done',onError:'failed'},done:{type:'end',outcome:'DONE'},failed:{type:'end',outcome:'FAILED'}}});",
    "if (!flow.digest || !createMemoryStorage || !createMemoryTransport || !createKafkaTransport || !postgresMigrations()[0]?.statements.some((sql) => sql.includes('CREATE TABLE'))) throw new Error('public API smoke failed');",
  ].join('\n'));

  // 2) External TypeScript consumer: every documented root/subpath entrypoint must
  //    compile against the installed tarballs' types under NodeNext resolution.
  await writeFile(path.join(directory, 'consumer.ts'), [
    "import { compileFlow, Conductor, createConductor, StaticArtifactRegistry, StaticOperationCatalog, parseOperationCommand, completionPayload, operationCompletionEnvelope } from '@processengine/conductor';",
    "import type { ProcessState, StartProcessResult, JsonValue, MessageEnvelope, ProcessStorage, MessageTransport, OperationCompletion } from '@processengine/conductor';",
    "import { evolve, success, failure, createMemoryStorage, createMemoryTransport, createMemoryConductor, ManualClock } from '@processengine/conductor/testing';",
    "import type { TransitionResult, MessageTransportConformanceOptions } from '@processengine/conductor/testing';",
    "import { createKafkaTransport, KafkaTransport } from '@processengine/transport-kafka';",
    "import { createKafkaOperationWorker, operationSuccess } from '@processengine/transport-kafka/worker';",
    "import type { OperationWorkerContext } from '@processengine/transport-kafka/worker';",
    "import { createPostgresStorage, PostgresStorage } from '@processengine/storage-postgres';",
    "import { postgresMigrations, runPostgresMigrations } from '@processengine/storage-postgres/migrations';",
    "type _Types = [ProcessState, StartProcessResult, JsonValue, MessageEnvelope, ProcessStorage, MessageTransport, OperationCompletion, TransitionResult, MessageTransportConformanceOptions, OperationWorkerContext];",
    "void ([compileFlow, Conductor, createConductor, StaticArtifactRegistry, StaticOperationCatalog, parseOperationCommand, completionPayload, operationCompletionEnvelope, evolve, success, failure, createMemoryStorage, createMemoryTransport, createMemoryConductor, ManualClock, createKafkaTransport, KafkaTransport, createKafkaOperationWorker, operationSuccess, createPostgresStorage, PostgresStorage, postgresMigrations, runPostgresMigrations] as const);",
    "export type { _Types };",
  ].join('\n'));

  // 3) Negative: a deep/internal path is NOT a package export; NodeNext resolution
  //    must refuse it. If this file compiled, the exports map would be leaking.
  await writeFile(path.join(directory, 'negative.ts'), [
    "// @ts-expect-error internal kernel path is not exported by the package",
    "import { evolve } from '@processengine/conductor/dist/kernel.js';",
    "void evolve;",
  ].join('\n'));

  await writeTsconfig(path.join(directory, 'tsconfig.positive.json'), ['consumer.ts']);
  await writeTsconfig(path.join(directory, 'tsconfig.negative.json'), ['negative.ts']);

  await run('npm', ['install', '--ignore-scripts', '--cache', path.join(tmpdir(), 'processengine-npm-cache')], directory);
  await run('node', ['smoke.mjs'], directory);
  await run(tsc, ['--project', 'tsconfig.positive.json'], directory);
  // The negative file uses @ts-expect-error, so a CLEAN compile proves the deep
  // import was rejected exactly as intended (the suppressed error fired).
  await run(tsc, ['--project', 'tsconfig.negative.json'], directory);
  console.log('package smoke: runtime import, external TypeScript consumer, and internal-import rejection all passed');
} finally {
  await rm(directory, { recursive: true, force: true });
}

function tsconfigContent(files) {
  return JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      verbatimModuleSyntax: true,
    },
    files,
  }, null, 2);
}

async function writeTsconfig(file, files) {
  await writeFile(file, tsconfigContent(files));
}

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)));
  });
}
