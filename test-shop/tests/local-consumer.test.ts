import { describe, expect, it } from 'vitest';
import { localContentTag } from '../scripts/consumer.mjs';

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
