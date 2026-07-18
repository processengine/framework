import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryUrl = 'https://github.com/processengine/framework.git';
const packageDefinitions = [
  {
    name: '@processengine/conductor',
    directory: 'packages/conductor',
  },
  {
    name: '@processengine/transport-kafka',
    directory: 'packages/transport-kafka',
  },
  {
    name: '@processengine/storage-postgres',
    directory: 'packages/storage-postgres',
  },
];

export async function loadReleaseManifests(frameworkRoot) {
  return Promise.all(packageDefinitions.map(async (definition) => {
    const manifestPath = path.join(frameworkRoot, definition.directory, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    return { ...definition, ...manifest };
  }));
}

export function validateRelease(tag, manifests) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(tag);
  if (!match) {
    throw new Error(`Release tag ${JSON.stringify(tag)} is not a strict vX.Y.Z tag`);
  }

  const version = tag.slice(1);
  if (manifests.length !== packageDefinitions.length) {
    throw new Error(`Expected ${packageDefinitions.length} package manifests, got ${manifests.length}`);
  }

  for (const [index, definition] of packageDefinitions.entries()) {
    const manifest = manifests[index];
    if (!manifest || manifest.name !== definition.name) {
      throw new Error(`Release package ${index + 1} must be ${definition.name}`);
    }
    if (manifest.version !== version) {
      throw new Error(`${manifest.name} version ${manifest.version} does not match tag ${tag}`);
    }
    if (manifest.repository?.type !== 'git' || manifest.repository.url !== repositoryUrl) {
      throw new Error(`${manifest.name} repository URL must be ${repositoryUrl}`);
    }
    const expectedDirectory = `processengine/${definition.directory}`;
    if (manifest.repository.directory !== expectedDirectory) {
      throw new Error(`${manifest.name} repository directory must be ${expectedDirectory}`);
    }
    if (manifest.publishConfig?.access !== 'public') {
      throw new Error(`${manifest.name} publishConfig.access must be public`);
    }
  }

  return {
    version,
    packages: packageDefinitions.map(({ name }) => name),
  };
}

export async function assertVersionsUnpublished(release, fetchImpl = fetch) {
  for (const packageName of release.packages) {
    const packageVersion = `${packageName}@${release.version}`;
    const endpoint = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${release.version}`;
    const response = await fetchImpl(endpoint, {
      headers: { accept: 'application/json' },
    });
    if (response.status === 200) {
      throw new Error(`${packageVersion} already exists in npm`);
    }
    if (response.status !== 404) {
      throw new Error(`npm registry returned ${response.status} while checking ${packageVersion}`);
    }
  }
}

async function main() {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
  if (!tag) {
    throw new Error('Pass the release tag as the first argument or GITHUB_REF_NAME');
  }
  const frameworkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifests = await loadReleaseManifests(frameworkRoot);
  const release = validateRelease(tag, manifests);
  await assertVersionsUnpublished(release);
  console.log(`Release preflight passed for ${release.packages.length} packages at ${release.version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
