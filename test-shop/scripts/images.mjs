import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const shop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set([
  'node_modules', 'dist',
]);
const buildFiles = [
  'Dockerfile',
  'Dockerfile.dockerignore',
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
];
const buildDirectories = ['apps', 'packages', 'config', 'flows'];

const validTag = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u;

export const imageComponents = [
  { component: 'shop-host', target: 'shop-host', repository: 'processengine/test-shop-shop-host' },
  { component: 'shop-warehouse', target: 'shop-warehouse', repository: 'processengine/test-shop-shop-warehouse' },
  { component: 'shop-payment', target: 'shop-payment', repository: 'processengine/test-shop-shop-payment' },
];

// Registry mode hashes the committed test-shop worktree; the resulting `sha-*`
// tag proves the published `0.1.0` consumer bytes. Local mode passes an explicit
// `contentTag` computed from the framework tarball bytes (see scripts/consumer.mjs)
// so a framework-code change necessarily changes the tag and therefore the image.
export async function contentTag(options = {}) {
  if (options.contentTag !== undefined) {
    if (!validTag.test(options.contentTag)) throw new TypeError(`Invalid content tag: ${options.contentTag}`);
    return options.contentTag;
  }
  const explicit = process.env.TEST_SHOP_IMAGE_TAG;
  if (explicit !== undefined) {
    if (!validTag.test(explicit)) throw new TypeError('TEST_SHOP_IMAGE_TAG is invalid');
    return explicit;
  }
  const contextDir = options.contextDir ?? shop;
  const hash = createHash('sha256');
  const files = await sourceFiles(contextDir);
  for (const file of files) {
    hash.update(path.relative(contextDir, file));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return `sha-${hash.digest('hex').slice(0, 16)}`;
}

export async function imageDefinitions(options = {}) {
  const tag = await contentTag(options);
  return imageComponents.map((item) => ({ ...item, tag, image: `${item.repository}:${item.tag}` }));
}

export async function buildImages(options = {}) {
  run('docker', ['version'], { capture: true });
  const contextDir = options.contextDir ?? shop;
  const contextDockerfile = path.join(contextDir, 'Dockerfile');
  const images = await imageDefinitions(options);
  for (const item of images) {
    run('docker', ['build', '--file', contextDockerfile, '--target', item.target, '--tag', item.image, contextDir]);
    const id = run('docker', ['image', 'inspect', '--format', '{{.Id}}', item.image], { capture: true });
    console.log(JSON.stringify({ ...item, id }));
  }
  return images;
}

async function sourceFiles(root) {
  const result = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(absolute);
    }
  }
  for (const file of buildFiles) {
    const absolute = path.join(root, file);
    if (!(await stat(absolute)).isFile()) throw new Error(`Docker build input is not a file: ${file}`);
    result.push(absolute);
  }
  for (const directory of buildDirectories) {
    const absolute = path.join(root, directory);
    if (!(await stat(absolute)).isDirectory()) throw new Error(`Missing Docker build input directory: ${directory}`);
    await visit(absolute);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd ?? shop,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return (result.stdout ?? '').trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2] ?? 'build';
  if (command === 'build') await buildImages();
  else if (command === 'tag') console.log(await contentTag());
  else if (command === 'inspect') {
    for (const item of await imageDefinitions()) {
      console.log(JSON.stringify({ ...item, id: run('docker', ['image', 'inspect', '--format', '{{.Id}}', item.image], { capture: true }) }));
    }
  } else throw new TypeError('Usage: node scripts/images.mjs <build|tag|inspect>');
}
