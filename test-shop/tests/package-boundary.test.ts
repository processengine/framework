import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('external framework package boundary', () => {
  it('pins exactly the three public framework tarballs at the repository root', () => {
    const manifest = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({
      '@processengine/conductor': 'file:.framework/processengine-conductor-0.1.0.tgz',
      '@processengine/storage-postgres': 'file:.framework/processengine-storage-postgres-0.1.0.tgz',
      '@processengine/transport-kafka': 'file:.framework/processengine-transport-kafka-0.1.0.tgz',
    });
  });

  it('builds application images from the standalone test-shop consumer', () => {
    const dockerfile = readFileSync(`${root}/Dockerfile`, 'utf8');
    expect(dockerfile).toContain('COPY --chown=node:node . /app/test-shop');
    expect(dockerfile).toContain('RUN npm ci');
    expect(dockerfile).not.toContain('COPY processengine');
    expect(dockerfile).not.toContain('pack:all');
  });
});
