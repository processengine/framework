import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryUrl = 'https://github.com/processengine/framework.git';

const PACKAGES = [
  { dir: 'packages/conductor', name: '@processengine/conductor', platform: /Node\.js/u },
  { dir: 'packages/transport-kafka', name: '@processengine/transport-kafka', platform: /Kafka/u },
  { dir: 'packages/storage-postgres', name: '@processengine/storage-postgres', platform: /PostgreSQL/u },
];

function manifestOf(dir: string) {
  return JSON.parse(readFileSync(path.join(frameworkRoot, dir, 'package.json'), 'utf8'));
}

function packedFiles(dir: string): string[] {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: path.join(frameworkRoot, dir),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const report = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
  return report[0]?.files.map((file) => file.path) ?? [];
}

describe.each(PACKAGES)('published package metadata — $name', (pkg) => {
  const manifest = manifestOf(pkg.dir);

  it('has an honest description that names its platform and role', () => {
    expect(typeof manifest.description).toBe('string');
    expect(manifest.description.length).toBeGreaterThan(10);
    expect(manifest.description).toMatch(pkg.platform);
    expect(manifest.description).not.toMatch(/technology-(neutral|agnostic)/iu);
  });

  it('carries repository, homepage, bugs and keywords', () => {
    expect(manifest.repository).toMatchObject({ type: 'git', url: repositoryUrl, directory: `processengine/${pkg.dir}` });
    expect(manifest.homepage).toBe('https://github.com/processengine/framework#readme');
    expect(manifest.bugs?.url).toBe('https://github.com/processengine/framework/issues');
    expect(Array.isArray(manifest.keywords)).toBe(true);
    expect(manifest.keywords).toContain('processengine');
    expect(manifest.license).toBe('Apache-2.0');
  });

  it('packs the README and a LICENSE and no source/test/config files', () => {
    const files = packedFiles(pkg.dir);
    expect(files).toContain('package.json');
    expect(files).toContain('README.md');
    expect(files.some((file) => /^LICENSE/iu.test(file))).toBe(true);

    for (const file of files) {
      expect(file, `stray file in tarball: ${file}`).not.toMatch(/^src\//u);
      expect(file, `stray file in tarball: ${file}`).not.toMatch(/(^|\/)test\//u);
      expect(file, `stray file in tarball: ${file}`).not.toMatch(/tsconfig.*\.json$/u);
      expect(file, `stray file in tarball: ${file}`).not.toMatch(/\.test\./u);
      expect(file, `stray file in tarball: ${file}`).not.toMatch(/\.tgz$/u);
      expect(file, `stray file in tarball: ${file}`).not.toMatch(/(^|\/)node_modules\//u);
    }

    // dist ships only once built; assert it when present (the framework gate
    // builds before packing).
    if (existsSync(path.join(frameworkRoot, pkg.dir, 'dist/index.js'))) {
      expect(files).toContain('dist/index.js');
    }
  });
});
