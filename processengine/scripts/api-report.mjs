// Deterministic, signature-level public-API snapshot for every published package.
//
// Uses @microsoft/api-extractor (dev-only) to build an API report from each built
// .d.ts entrypoint, so the report captures full declarations — parameter and
// return types, interface fields and their optionality, generics and unions — not
// just a list of names. Any of those changing trips the drift gate, even when the
// export name and kind are unchanged.
//
// It covers every TypeScript entrypoint declared in package.json `exports`:
//   conductor, conductor/testing,
//   transport-kafka, transport-kafka/worker,
//   storage-postgres, storage-postgres/migrations.
// The conductor JSON Schema export is a shipped artifact, not a TS API, and is
// covered by the package smoke / package-content checks instead.
//
// `--check` compares without writing and fails on any drift. Requires a prior
// build (the framework gate builds before running this).

import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Extractor, ExtractorConfig } = require('@microsoft/api-extractor');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(root, 'api-reports');
const tempDir = path.join(tmpdir(), 'processengine-api-extractor');

const ENTRYPOINTS = [
  { dir: 'packages/conductor', entry: 'index', report: 'conductor.api.md' },
  { dir: 'packages/conductor', entry: 'testing', report: 'conductor-testing.api.md' },
  { dir: 'packages/transport-kafka', entry: 'index', report: 'transport-kafka.api.md' },
  { dir: 'packages/transport-kafka', entry: 'worker', report: 'transport-kafka-worker.api.md' },
  { dir: 'packages/storage-postgres', entry: 'index', report: 'storage-postgres.api.md' },
  { dir: 'packages/storage-postgres', entry: 'migrations', report: 'storage-postgres-migrations.api.md' },
];

const check = process.argv.includes('--check');
mkdirSync(reportsDir, { recursive: true });
rmSync(tempDir, { recursive: true, force: true });
mkdirSync(tempDir, { recursive: true });

let failed = false;
for (const item of ENTRYPOINTS) {
  const projectFolder = path.join(root, item.dir);
  const mainEntryPointFilePath = path.join(projectFolder, 'dist', `${item.entry}.d.ts`);
  if (!existsSync(mainEntryPointFilePath)) {
    throw new Error(`Missing ${path.relative(root, mainEntryPointFilePath)} — run "npm run build" first.`);
  }

  const config = ExtractorConfig.prepare({
    configObjectFullPath: path.join(projectFolder, `api-extractor.${item.entry}.json`),
    packageJsonFullPath: path.join(projectFolder, 'package.json'),
    configObject: {
      projectFolder,
      mainEntryPointFilePath,
      compiler: { tsconfigFilePath: path.join(projectFolder, 'tsconfig.json') },
      apiReport: {
        enabled: true,
        reportFolder: reportsDir,
        reportTempFolder: tempDir,
        reportFileName: item.report,
      },
      docModel: { enabled: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      messages: {
        // Release tags (@public/@internal) are not used in this project; the
        // curated exports themselves define the surface. Report forgotten exports
        // and TSDoc issues without failing the deterministic snapshot.
        extractorMessageReporting: {
          default: { logLevel: 'warning' },
          'ae-missing-release-tag': { logLevel: 'none' },
          'ae-forgotten-export': { logLevel: 'none' },
          'ae-undocumented': { logLevel: 'none' },
        },
        tsdocMessageReporting: { default: { logLevel: 'none' } },
        compilerMessageReporting: { default: { logLevel: 'warning' } },
      },
    },
  });

  const result = Extractor.invoke(config, { localBuild: !check, showVerboseMessages: false });
  if (result.errorCount > 0) {
    failed = true;
    console.error(`API extractor reported ${result.errorCount} error(s) for ${item.report}`);
  }
  if (check && result.apiReportChanged) {
    failed = true;
    console.error(`API drift for ${item.report}: run "npm run api:report" and review the change.`);
  } else if (check) {
    console.log(`API report up to date: ${item.report}`);
  } else {
    console.log(`Wrote api-reports/${item.report}`);
  }
}

rmSync(tempDir, { recursive: true, force: true });
if (failed) process.exit(1);
