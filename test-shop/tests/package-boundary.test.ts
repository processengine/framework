import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const FRAMEWORK_PACKAGES = [
  '@processengine/conductor',
  '@processengine/storage-postgres',
  '@processengine/transport-kafka',
];

const manifest = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as {
  dependencies: Record<string, string>;
};

// The same test-shop tree is consumed in two honest modes. The committed tree
// pins the published registry release; the ephemeral `.work/local-consumer`
// staging rewrites those pins to the freshly packed framework tarballs. This
// suite asserts whichever boundary is actually present, so it stays meaningful
// in both the registry gate and the local gate.
const isLocalStaging = FRAMEWORK_PACKAGES.every((name) => manifest.dependencies[name]?.startsWith('file:'));

describe('external framework package boundary', () => {
  it('depends on exactly the three framework packages at the repository root', () => {
    expect(Object.keys(manifest.dependencies).sort()).toEqual([...FRAMEWORK_PACKAGES].sort());
  });

  if (isLocalStaging) {
    it('pins the locally packed framework tarballs (local mode)', () => {
      for (const name of FRAMEWORK_PACKAGES) {
        expect(manifest.dependencies[name]).toMatch(/^file:.*vendor\/.*\.tgz$/u);
      }
      const lockfile = JSON.parse(readFileSync(`${root}/package-lock.json`, 'utf8')) as {
        packages: Record<string, { resolved?: string; link?: boolean }>;
      };
      for (const name of FRAMEWORK_PACKAGES) {
        const entry = lockfile.packages[`node_modules/${name}`];
        expect(entry?.resolved ?? '').not.toMatch(/^https:\/\/registry\.npmjs\.org\//u);
      }
    });
  } else {
    it('pins the published registry release with integrity (registry mode)', () => {
      for (const name of FRAMEWORK_PACKAGES) {
        expect(manifest.dependencies[name]).toBe('0.1.0');
      }
      const lockfile = JSON.parse(readFileSync(`${root}/package-lock.json`, 'utf8')) as {
        packages: Record<string, { resolved?: string; integrity?: string }>;
      };
      for (const name of FRAMEWORK_PACKAGES) {
        const entry = lockfile.packages[`node_modules/${name}`];
        expect(entry?.resolved).toMatch(/^https:\/\/registry\.npmjs\.org\//u);
        expect(entry?.integrity).toMatch(/^sha512-/u);
      }
    });
  }

  it('builds application images from the standalone test-shop consumer', () => {
    const dockerfile = readFileSync(`${root}/Dockerfile`, 'utf8');
    expect(dockerfile).toContain('COPY --chown=node:node . /app/test-shop');
    expect(dockerfile).toContain('RUN npm ci');
    expect(dockerfile).not.toContain('COPY processengine');
    expect(dockerfile).not.toContain('pack:all');
  });
});
