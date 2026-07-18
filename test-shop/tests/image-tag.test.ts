import { rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { contentTag } from '../scripts/images.mjs';

const docsProbe = fileURLToPath(new URL('../docs/.content-tag-probe', import.meta.url));
const runtimeProbe = fileURLToPath(new URL('../config/.content-tag-probe', import.meta.url));

afterEach(async () => {
  await Promise.all([
    rm(docsProbe, { force: true }),
    rm(runtimeProbe, { force: true }),
  ]);
});

describe('application image content tag', () => {
  it('ignores documentation while hashing every Docker runtime input', async () => {
    const baseline = await contentTag();
    await writeFile(docsProbe, 'documentation-only change\n');
    expect(await contentTag()).toBe(baseline);

    await writeFile(runtimeProbe, 'runtime build input\n');
    expect(await contentTag()).not.toBe(baseline);
  });
});
