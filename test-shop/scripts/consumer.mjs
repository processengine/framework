// Two honest framework-consumption modes for the test-shop contour.
//
//   registry  Installs the exact published `@processengine/*` versions from the
//             committed manifests + lockfile. This is the external consumer /
//             release gate: it proves the bytes on npm.
//   local     Packs the three framework packages from the current worktree,
//             stages an isolated ephemeral consumer under `.work/local-consumer/`
//             that installs exactly those tarballs, and builds images whose
//             content tag is derived from the tarball bytes. This proves the
//             code in the tree right now.
//
// Local mode never rewrites tracked manifests/lockfiles: everything mutable lives
// under the ignored `.work/` directory and is regenerated deterministically.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const shop = path.resolve(here, '..');
export const repoRoot = path.resolve(shop, '..');
export const framework = path.join(repoRoot, 'processengine');
export const frameworkPackagesDir = path.join(framework, '.packages');
// Kept at the repository root (not under test-shop) so staging can copy the whole
// test-shop tree without cp reporting a copy-into-self.
export const workRoot = path.join(repoRoot, '.work');
export const localConsumerDir = path.join(workRoot, 'local-consumer');

export const MODES = ['local', 'registry'];

export const FRAMEWORK_PACKAGES = [
  { name: '@processengine/conductor', dir: 'packages/conductor' },
  { name: '@processengine/transport-kafka', dir: 'packages/transport-kafka' },
  { name: '@processengine/storage-postgres', dir: 'packages/storage-postgres' },
];

// Manifests inside test-shop that pin the framework packages by exact version.
const CONSUMER_MANIFESTS = [
  'package.json',
  'packages/host-adapter/package.json',
  'packages/service-kit/package.json',
];

const COPY_EXCLUDE = new Set([
  'node_modules', 'dist', '.artifacts', '.work', '.npm-cache', '.git', 'coverage', '.DS_Store',
]);

// The generated package-lock.json is deliberately NOT excluded: it is a Docker
// build input that fixes the installed bytes, so the image content tag must move
// when it moves. Only truly generated/non-input files (vendored tarballs — counted
// separately via their integrity — and the timestamped source manifest) are left out.
const SOURCE_DIGEST_EXCLUDE = new Set([
  'node_modules', 'dist', '.artifacts', '.work', '.npm-cache', '.git', 'coverage', '.DS_Store',
  'vendor', 'source-manifest.json',
]);

export function resolveMode(value) {
  const mode = value ?? process.env.TEST_SHOP_MODE;
  if (mode === undefined) {
    throw new TypeError(
      'Ambiguous consumption mode. Choose "local" (current worktree) or "registry" '
      + '(published 0.1.0): e.g. compose:deploy:local / compose:deploy:registry.',
    );
  }
  if (!MODES.includes(mode)) {
    throw new TypeError(`Unknown consumption mode "${mode}". Expected one of: ${MODES.join(', ')}.`);
  }
  return mode;
}

function run(program, args, cwd, { capture = true } = {}) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout ?? '';
}

export function gitState() {
  const commit = run('git', ['rev-parse', 'HEAD'], repoRoot).trim();
  const dirty = run('git', ['status', '--porcelain'], repoRoot).trim().length > 0;
  return { commit, dirty };
}

function integrityOf(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function tarballFileName(name, version) {
  return `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`;
}

// Pure, unit-testable: the local image content tag MUST depend on the framework
// tarball bytes, not merely the version string. Two tarball sets sharing the same
// version but differing in integrity produce different tags.
export function localContentTag(sourceDigest, tarballs) {
  const hash = createHash('sha256');
  hash.update('processengine-local-consumer\0');
  hash.update(`${sourceDigest}\0`);
  for (const tarball of [...tarballs].sort((left, right) => left.name.localeCompare(right.name))) {
    hash.update(`${tarball.name}\0${tarball.version}\0${tarball.integrity}\0`);
  }
  return `sha-local-${hash.digest('hex').slice(0, 16)}`;
}

export async function packFramework() {
  run('npm', ['run', 'pack:all'], framework, { capture: false });
  const tarballs = [];
  for (const pkg of FRAMEWORK_PACKAGES) {
    const manifest = JSON.parse(await readFile(path.join(framework, pkg.dir, 'package.json'), 'utf8'));
    const file = tarballFileName(pkg.name, manifest.version);
    const tarballPath = path.join(frameworkPackagesDir, file);
    const bytes = await readFile(tarballPath);
    tarballs.push({ name: pkg.name, version: manifest.version, file, path: tarballPath, integrity: integrityOf(bytes) });
  }
  return tarballs;
}

export async function hashTree(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (SOURCE_DIGEST_EXCLUDE.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  await visit(root);
  files.sort((left, right) => left.localeCompare(right));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${path.relative(root, file)}\0`);
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function copyTree(from, to) {
  await cp(from, to, {
    recursive: true,
    filter: (source) => !COPY_EXCLUDE.has(path.basename(source)),
  });
}

async function rewriteManifest(absolutePath, tarballByName, vendorDir) {
  const manifest = JSON.parse(await readFile(absolutePath, 'utf8'));
  const manifestDir = path.dirname(absolutePath);
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = manifest[field];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      const tarball = tarballByName.get(name);
      if (!tarball) continue;
      let relative = path.relative(manifestDir, path.join(vendorDir, tarball.file)).split(path.sep).join('/');
      if (!relative.startsWith('.')) relative = `./${relative}`;
      deps[name] = `file:${relative}`;
    }
  }
  await writeFile(absolutePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Deterministically (re)build `.work/local-consumer/` from the current worktree
// plus freshly packed framework tarballs. Returns the build descriptor.
export async function stageLocalConsumer({ install = false } = {}) {
  const tarballs = await packFramework();
  const tarballByName = new Map(tarballs.map((tarball) => [tarball.name, tarball]));

  await rm(localConsumerDir, { recursive: true, force: true });
  await mkdir(workRoot, { recursive: true });
  await copyTree(shop, localConsumerDir);

  const vendorDir = path.join(localConsumerDir, 'vendor');
  await mkdir(vendorDir, { recursive: true });
  for (const tarball of tarballs) await cp(tarball.path, path.join(vendorDir, tarball.file));

  // The staged Docker build context must ship the vendored tarballs; the base
  // .dockerignore whitelists only the committed inputs, so extend it here.
  const dockerignore = path.join(localConsumerDir, 'Dockerfile.dockerignore');
  const base = await readFile(dockerignore, 'utf8');
  if (!base.includes('!vendor/')) {
    await writeFile(dockerignore, `${base.trimEnd()}\n!vendor/\n!vendor/**\n`);
  }

  for (const relative of CONSUMER_MANIFESTS) {
    await rewriteManifest(path.join(localConsumerDir, relative), tarballByName, vendorDir);
  }

  // Drop the registry-pinned lockfile and regenerate one that resolves the
  // vendored tarballs, so both `npm ci` (image build) and `npm install`
  // (deterministic gate) install exactly the local framework.
  await rm(path.join(localConsumerDir, 'package-lock.json'), { force: true });
  const npmArgs = install ? ['install'] : ['install', '--package-lock-only', '--ignore-scripts'];
  run('npm', npmArgs, localConsumerDir, { capture: false });

  const sourceDigest = await hashTree(localConsumerDir);
  const contentTag = localContentTag(sourceDigest, tarballs);
  return { mode: 'local', contextDir: localConsumerDir, contentTag, tarballs, sourceDigest };
}

async function registryPackages() {
  const lockfile = JSON.parse(await readFile(path.join(shop, 'package-lock.json'), 'utf8'));
  return FRAMEWORK_PACKAGES.map((pkg) => {
    const entry = lockfile.packages?.[`node_modules/${pkg.name}`] ?? {};
    return { name: pkg.name, version: entry.version, resolved: entry.resolved, integrity: entry.integrity };
  });
}

// Resolve the build inputs for a mode. For registry mode nothing is staged: the
// committed worktree is the context and images use the registry content hash.
export async function prepareBuild(mode) {
  const git = gitState();
  if (mode === 'registry') {
    const packages = await registryPackages();
    return {
      mode, contextDir: shop, contentTag: undefined,
      manifest: { mode, git, packages, generatedAt: new Date().toISOString() },
    };
  }
  const staged = await stageLocalConsumer({ install: false });
  return {
    mode,
    contextDir: staged.contextDir,
    contentTag: staged.contentTag,
    manifest: {
      mode, git,
      packages: staged.tarballs.map(({ name, version, integrity, file }) => ({ name, version, integrity, tarball: file })),
      sourceDigest: staged.sourceDigest,
      generatedAt: new Date().toISOString(),
    },
  };
}

export async function writeSourceManifest(directory, manifest) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'source-manifest.json');
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}

// CLI: `node scripts/consumer.mjs <stage|manifest> <local|registry>`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2] ?? 'manifest';
  const mode = resolveMode(process.argv[3]);
  if (command === 'stage') {
    if (mode !== 'local') throw new TypeError('stage is only meaningful for local mode');
    const staged = await stageLocalConsumer({ install: false });
    const manifest = { mode, git: gitState(), sourceDigest: staged.sourceDigest, contentTag: staged.contentTag, packages: staged.tarballs.map(({ name, version, integrity, file }) => ({ name, version, integrity, tarball: file })), generatedAt: new Date().toISOString() };
    const file = await writeSourceManifest(localConsumerDir, manifest);
    console.log(JSON.stringify({ ...manifest, sourceManifest: file, contextDir: staged.contextDir }, null, 2));
  } else if (command === 'manifest') {
    const build = await prepareBuild(mode);
    console.log(JSON.stringify(build.manifest, null, 2));
  } else {
    throw new TypeError('Usage: node scripts/consumer.mjs <stage|manifest> <local|registry>');
  }
}
