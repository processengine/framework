import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frameworkPackages = path.resolve(shop, '../processengine/.packages');
const destination = path.join(shop, '.framework');
const expected = [
  'processengine-conductor-0.1.0.tgz',
  'processengine-storage-postgres-0.1.0.tgz',
  'processengine-transport-kafka-0.1.0.tgz',
];

const available = await readdir(frameworkPackages).catch(() => []);
for (const file of expected) {
  if (!available.includes(file)) throw new Error(`Missing packed framework package: ${file}`);
}
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const file of expected) await cp(path.join(frameworkPackages, file), path.join(destination, file));

// Local development deliberately repacks the same prerelease version. npm's
// lockfile pins file: tarballs by integrity, so refresh those three immutable
// byte digests before the following `npm ci`. Registry dependencies and their
// versions remain untouched.
const lockfilePath = path.join(shop, 'package-lock.json');
const lockfile = JSON.parse(await readFile(lockfilePath, 'utf8'));
const lockEntries = {
  'processengine-conductor-0.1.0.tgz': 'node_modules/@processengine/conductor',
  'processengine-storage-postgres-0.1.0.tgz': 'node_modules/@processengine/storage-postgres',
  'processengine-transport-kafka-0.1.0.tgz': 'node_modules/@processengine/transport-kafka',
};
for (const [file, packageKey] of Object.entries(lockEntries)) {
  const entry = lockfile.packages?.[packageKey];
  if (entry === undefined) throw new Error(`package-lock.json is missing ${packageKey}`);
  const archive = await readFile(path.join(destination, file));
  entry.resolved = `file:.framework/${file}`;
  entry.integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
}
await writeFile(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);
console.log(`Staged ${expected.length} public ProcessEngine packages and refreshed their lockfile digests`);
