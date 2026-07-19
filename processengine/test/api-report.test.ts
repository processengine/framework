import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PACKAGES = [
  { name: '@processengine/conductor', dir: 'packages/conductor', file: 'processengine-conductor.api.md' },
  { name: '@processengine/transport-kafka', dir: 'packages/transport-kafka', file: 'processengine-transport-kafka.api.md' },
  { name: '@processengine/storage-postgres', dir: 'packages/storage-postgres', file: 'processengine-storage-postgres.api.md' },
];

// The API report must snapshot EVERY public entrypoint declared in package.json
// exports, not only the root. Otherwise a change to a subpath (testing / worker /
// migrations) would not move the report and the drift gate would miss it.
function tsEntrypoints(dir: string): string[] {
  const manifest = JSON.parse(readFileSync(path.join(frameworkRoot, dir, 'package.json'), 'utf8')) as {
    name: string;
    exports: Record<string, unknown>;
  };
  const paths: string[] = [];
  for (const [subpath, value] of Object.entries(manifest.exports)) {
    const target = typeof value === 'string' ? value : (value as { import?: string }).import;
    if (typeof target !== 'string' || !/^\.\/dist\/.+\.js$/u.test(target)) continue;
    paths.push(subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`);
  }
  return paths;
}

describe.each(PACKAGES)('API report coverage — $name', (pkg) => {
  const report = readFileSync(path.join(frameworkRoot, 'api-reports', pkg.file), 'utf8');

  it('has a section for every TS entrypoint in package.json exports', () => {
    const entrypoints = tsEntrypoints(pkg.dir);
    expect(entrypoints.length).toBeGreaterThanOrEqual(2); // root + at least one subpath
    for (const importPath of entrypoints) {
      expect(report, `missing report section for ${importPath}`).toContain(`## \`${importPath}\``);
    }
  });
});

describe('subpath surfaces are snapshotted', () => {
  it('includes the specific documented subpaths', () => {
    const conductor = readFileSync(path.join(frameworkRoot, 'api-reports/processengine-conductor.api.md'), 'utf8');
    const kafka = readFileSync(path.join(frameworkRoot, 'api-reports/processengine-transport-kafka.api.md'), 'utf8');
    const postgres = readFileSync(path.join(frameworkRoot, 'api-reports/processengine-storage-postgres.api.md'), 'utf8');
    expect(conductor).toContain('## `@processengine/conductor/testing`');
    expect(kafka).toContain('## `@processengine/transport-kafka/worker`');
    expect(postgres).toContain('## `@processengine/storage-postgres/migrations`');
  });
});
