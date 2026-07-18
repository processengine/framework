import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('external framework package boundary', () => {
  it('pins exactly the three published framework packages at the repository root', () => {
    const manifest = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({
      '@processengine/conductor': '0.1.0',
      '@processengine/storage-postgres': '0.1.0',
      '@processengine/transport-kafka': '0.1.0',
    });

    const lockfile = JSON.parse(readFileSync(`${root}/package-lock.json`, 'utf8')) as {
      packages: Record<string, { resolved?: string; integrity?: string }>;
    };
    for (const name of Object.keys(manifest.dependencies)) {
      const entry = lockfile.packages[`node_modules/${name}`];
      expect(entry?.resolved).toMatch(/^https:\/\/registry\.npmjs\.org\//u);
      expect(entry?.integrity).toMatch(/^sha512-/u);
    }
  });

  it('builds application images from the standalone test-shop consumer', () => {
    const dockerfile = readFileSync(`${root}/Dockerfile`, 'utf8');
    expect(dockerfile).toContain('COPY --chown=node:node . /app/test-shop');
    expect(dockerfile).toContain('RUN npm ci');
    expect(dockerfile).not.toContain('COPY processengine');
    expect(dockerfile).not.toContain('pack:all');
  });
});
