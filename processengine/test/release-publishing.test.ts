import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertVersionsUnpublished,
  loadReleaseManifests,
  validateRelease,
} from '../scripts/release-preflight.mjs';

const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(frameworkRoot, '..');
const repositoryUrl = 'https://github.com/processengine/framework.git';

describe('release preflight', () => {
  it('accepts the current manifests only for their matching strict SemVer tag', async () => {
    const manifests = await loadReleaseManifests(frameworkRoot);

    expect(validateRelease('v0.1.0', manifests)).toEqual({
      version: '0.1.0',
      packages: [
        '@processengine/conductor',
        '@processengine/transport-kafka',
        '@processengine/storage-postgres',
      ],
    });
  });

  it('rejects non-release tags and version drift before contacting npm', async () => {
    const manifests = await loadReleaseManifests(frameworkRoot);

    expect(() => validateRelease('v0.1', manifests)).toThrow(/strict vX\.Y\.Z/u);
    expect(() => validateRelease('v0.1.0-beta.1', manifests)).toThrow(/strict vX\.Y\.Z/u);
    expect(() => validateRelease('v0.1.1', manifests)).toThrow(/does not match tag/u);
  });

  it('fails when npm already contains any target package version', async () => {
    const manifests = await loadReleaseManifests(frameworkRoot);
    const release = validateRelease('v0.1.0', manifests);
    const fetchExisting = async () => new Response('{}', { status: 200 });

    await expect(assertVersionsUnpublished(release, fetchExisting))
      .rejects.toThrow(/already exists/u);
  });
});

describe('trusted publication workflow contract', () => {
  it('pins the npm OIDC identity and contains no long-lived npm credential', async () => {
    const workflow = await readFile(
      path.join(repositoryRoot, '.github/workflows/publish-npm.yml'),
      'utf8',
    );

    expect(workflow).toMatch(
      /push:\s*\n\s*tags:\s*\n\s*- ['"]v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+['"]/u,
    );
    expect(workflow).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*id-token: write/u);
    expect(workflow).toContain('runs-on: ubuntu-latest');
    expect(workflow).toContain('node-version: 24');
    expect(workflow).toContain('package-manager-cache: false');
    expect(workflow).toContain('npm@11.18.0');
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.|\s+cache:/u);
  });

  it('gates and publishes all packages in dependency order, then smokes the registry', async () => {
    const workflow = await readFile(
      path.join(repositoryRoot, '.github/workflows/publish-npm.yml'),
      'utf8',
    );
    const conductor = workflow.indexOf('packages/conductor');
    const transport = workflow.indexOf('packages/transport-kafka');
    const storage = workflow.indexOf('packages/storage-postgres');

    expect(workflow).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(workflow).toContain('node scripts/release-preflight.mjs "$GITHUB_REF_NAME"');
    expect(workflow).toContain('npm run check');
    expect(workflow).toContain('npm run check:packages');
    expect(workflow.match(/npm publish --access public/gu)).toHaveLength(3);
    expect(conductor).toBeGreaterThan(-1);
    expect(conductor).toBeLessThan(transport);
    expect(transport).toBeLessThan(storage);
    expect(workflow).toContain('npm install --ignore-scripts');
    expect(workflow).toContain('node --input-type=module --eval');
  });

  it('uses exact repository metadata in every publishable package', async () => {
    const manifests = await loadReleaseManifests(frameworkRoot);

    for (const manifest of manifests) {
      expect(manifest.repository).toMatchObject({
        type: 'git',
        url: repositoryUrl,
      });
    }
  });

  it('keeps the package smoke independent of the current release version', async () => {
    const packageSmoke = await readFile(
      path.join(frameworkRoot, 'scripts/package-smoke.mjs'),
      'utf8',
    );

    expect(packageSmoke).not.toMatch(/processengine-[a-z-]+-0\.1\.0\.tgz/u);
    expect(packageSmoke).toContain('packageManifest.version');
  });
});
