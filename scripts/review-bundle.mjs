// Build a self-verifying review bundle for the current branch.
//
// The output ../processengine-review-bundle-<UTC>.zip contains:
//   repo.bundle          a self-contained git bundle of the branch (full history)
//   changes.diff         net diff of the branch vs its base (origin/main)
//   patches/*.patch      git format-patch series (git am-applicable)
//   source-snapshot.zip  the working tree without caches/artifacts/build output
//   git-log*.txt, git-status.txt, git-diff-check.txt, BUNDLE_INFO.txt
//   SHA256SUMS           sha256 of every file above
//
// It deliberately excludes .npm-cache, .work, .artifacts, .packages, node_modules,
// dist, .git, .npmrc, .env and any stray .zip so nothing heavy or secret ships.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parent = path.resolve(repoRoot, '..');

const SNAPSHOT_EXCLUDES = [
  'node_modules/*', '*/node_modules/*',
  'dist/*', '*/dist/*',
  '.git/*', '*/.git/*',
  '.npmrc', '*/.npmrc',
  '.env', '*/.env',
  '.npm-cache/*', '*/.npm-cache/*',
  '.work/*', '*/.work/*',
  '.artifacts/*', '*/.artifacts/*',
  '.packages/*', '*/.packages/*',
  '*.zip',
  '.DS_Store', '*/.DS_Store',
];

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

function gitOk(args) {
  try { git(args); return true; } catch { return false; }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs, base));
    else if (entry.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

const now = new Date();
const stamp = now.toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z');
const name = `processengine-review-bundle-${stamp}`;
const staging = path.join(parent, name);
const outZip = path.join(parent, `${name}.zip`);

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
const head = git(['rev-parse', 'HEAD']).trim();
const base = gitOk(['rev-parse', '--verify', 'origin/main'])
  ? 'origin/main'
  : git(['rev-list', '--max-parents=0', 'HEAD']).trim().split('\n')[0];
const baseSha = git(['rev-parse', base]).trim();
const mergeBase = git(['merge-base', base, 'HEAD']).trim();

rmSync(staging, { recursive: true, force: true });
mkdirSync(path.join(staging, 'patches'), { recursive: true });

// Self-contained git bundle of the whole branch, then verify it needs no prereqs.
const bundlePath = path.join(staging, 'repo.bundle');
git(['bundle', 'create', bundlePath, branch]);
git(['bundle', 'verify', bundlePath]);

// Net diff and an am-applicable patch series (merges are skipped by format-patch).
writeFileSync(path.join(staging, 'changes.diff'), git(['diff', `${base}..HEAD`]));
git(['format-patch', `${base}..HEAD`, '-o', path.join(staging, 'patches'), '--quiet']);

// Evidence.
writeFileSync(path.join(staging, 'git-log.txt'), git(['log', '--stat', `${base}..HEAD`]));
writeFileSync(path.join(staging, 'git-log-oneline.txt'), git(['log', '--oneline', `${base}..HEAD`]));
writeFileSync(path.join(staging, 'git-status.txt'), git(['status', '--short', '--branch']));
let diffCheck;
try { diffCheck = git(['diff', '--check']) || '(clean)\n'; }
catch (error) { diffCheck = `${error.stdout ?? ''}${error.stderr ?? ''}` || `${error}\n`; }
writeFileSync(path.join(staging, 'git-diff-check.txt'), diffCheck);

// Working-tree snapshot without the excluded noise.
const snapshot = path.join(staging, 'source-snapshot.zip');
execFileSync('zip', ['-r', '-q', '-X', snapshot, '.', '-x', ...SNAPSHOT_EXCLUDES], { cwd: repoRoot });

writeFileSync(path.join(staging, 'BUNDLE_INFO.txt'), [
  `Generated:   ${now.toISOString()}`,
  `Branch:      ${branch}`,
  `HEAD:        ${head}`,
  `Base ref:    ${base} (${baseSha})`,
  `Merge base:  ${mergeBase}`,
  '',
  'Contents:',
  '  repo.bundle          self-contained git bundle of the branch (full history)',
  '  changes.diff         git diff base..HEAD',
  '  patches/*.patch      git format-patch base..HEAD (apply with: git am patches/*.patch)',
  '  source-snapshot.zip  working tree without caches/artifacts/build output',
  '  git-*.txt            log, status and diff --check evidence',
  '  SHA256SUMS           sha256 of every file in this bundle',
  '',
  'Verify:',
  '  sha256sum -c SHA256SUMS',
  '  git bundle verify repo.bundle',
  `  git clone -b ${branch} repo.bundle review-clone`,
  '',
  `Excluded from source-snapshot.zip: ${SNAPSHOT_EXCLUDES.join(' ')}`,
  '',
].join('\n'));

// Checksums over every file except SHA256SUMS itself.
const sums = listFiles(staging)
  .filter((file) => file !== 'SHA256SUMS')
  .map((file) => `${sha256(readFileSync(path.join(staging, file)))}  ${file}`);
writeFileSync(path.join(staging, 'SHA256SUMS'), `${sums.join('\n')}\n`);

// Zip the staging directory, then clean it up.
rmSync(outZip, { force: true });
execFileSync('zip', ['-r', '-q', '-X', outZip, name], { cwd: parent });
rmSync(staging, { recursive: true, force: true });

const size = (statSync(outZip).size / (1024 * 1024)).toFixed(1);
console.log(`Review bundle: ${outZip} (${size} MB)`);
console.log(`  branch ${branch} @ ${head.slice(0, 12)} vs ${base}; ${sums.length} files, SHA256SUMS included`);
