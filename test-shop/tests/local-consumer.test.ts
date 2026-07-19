import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { hashTree, localContentTag } from '../scripts/consumer.mjs';

// Slice 1 invariant: the local-mode image content tag must be derived from the
// framework tarball *bytes*, not merely the version string. Otherwise a local
// build could silently ship the published 0.1.0 while claiming to be local.

const sourceDigest = 'a'.repeat(64);
const conductorA = { name: '@processengine/conductor', version: '0.1.0', integrity: 'sha512-AAAA' };
const conductorB = { name: '@processengine/conductor', version: '0.1.0', integrity: 'sha512-BBBB' };
const transport = { name: '@processengine/transport-kafka', version: '0.1.0', integrity: 'sha512-TTTT' };
const storage = { name: '@processengine/storage-postgres', version: '0.1.0', integrity: 'sha512-SSSS' };

describe('local content tag', () => {
  it('is deterministic and order-independent for the same tarball set', () => {
    const first = localContentTag(sourceDigest, [conductorA, transport, storage]);
    const second = localContentTag(sourceDigest, [storage, conductorA, transport]);
    expect(first).toBe(second);
    expect(first).toMatch(/^sha-local-[0-9a-f]{16}$/u);
  });

  it('changes when a framework tarball changes even though the version is identical', () => {
    const before = localContentTag(sourceDigest, [conductorA, transport, storage]);
    const after = localContentTag(sourceDigest, [conductorB, transport, storage]);
    expect(conductorA.version).toBe(conductorB.version);
    expect(after).not.toBe(before);
  });

  it('changes when the consumer source changes', () => {
    const before = localContentTag(sourceDigest, [conductorA, transport, storage]);
    const after = localContentTag('b'.repeat(64), [conductorA, transport, storage]);
    expect(after).not.toBe(before);
  });
});

describe('source digest (hashTree) — staged build inputs', () => {
  const roots: string[] = [];
  async function stagedDir(lockfile: string) {
    const root = await mkdtemp(path.join(tmpdir(), 'pe-hashtree-'));
    roots.push(root);
    await mkdir(path.join(root, 'vendor'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), '{"name":"c"}\n');
    await writeFile(path.join(root, 'package-lock.json'), lockfile);
    await writeFile(path.join(root, 'vendor', 'x.tgz'), 'tarball-bytes');
    return root;
  }
  afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

  it('changes when the staged package-lock.json bytes change', async () => {
    const before = await hashTree(await stagedDir('{"lockfileVersion":3,"a":1}\n'));
    const after = await hashTree(await stagedDir('{"lockfileVersion":3,"a":2}\n'));
    expect(after).not.toBe(before);
  });

  it('ignores the generated source manifest and vendored tarballs', async () => {
    const root = await stagedDir('{"lockfileVersion":3}\n');
    const before = await hashTree(root);
    await writeFile(path.join(root, 'source-manifest.json'), '{"generatedAt":"now"}\n');
    await writeFile(path.join(root, 'vendor', 'x.tgz'), 'different-tarball-bytes');
    expect(await hashTree(root)).toBe(before);
  });
});
