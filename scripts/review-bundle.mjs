// Build a self-verifying review bundle for the current branch.
//
// The output ../processengine-review-bundle-<UTC>.zip contains:
//   repo.bundle          a git bundle carrying origin/main AND the branch HEAD
//   changes.diff         net diff of the branch vs origin/main (origin/main..HEAD)
//   patches/*.patch      git format-patch series (git am-applicable)
//   source-snapshot.zip  the working tree without caches/artifacts/build output
//   git-*.txt            branch/HEAD/merge-base, decorated log, diff --stat,
//                        status, diff --check evidence
//   BUNDLE_INFO.txt      how to verify and restore
//   SHA256SUMS           sha256 of every file above
//
// It refuses to run on a dirty worktree (the git bundle would not match the tree),
// excludes .npm-cache, .work, .artifacts, .packages, node_modules, dist, .git,
// .npmrc, .env and any stray .zip, and never includes a previously created bundle.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parent = path.resolve(repoRoot, '..');

// Paths excluded from source-snapshot.zip, at both top level and nested.
export const SNAPSHOT_EXCLUDES = [
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

// Files the bundle must always contain (git evidence + integrity).
export const EVIDENCE_FILES = [
  'repo.bundle',
  'changes.diff',
  'git-branch-head.txt',
  'git-merge-base.txt',
  'git-log.txt',
  'git-diff-stat.txt',
  'git-status.txt',
  'git-diff-check.txt',
  'source-snapshot.zip',
  'BUNDLE_INFO.txt',
  'SHA256SUMS',
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

export async function buildReviewBundle() {
  // A dirty worktree would not be represented by the git bundle: refuse.
  const dirty = git(['status', '--porcelain']).trim();
  if (dirty) {
    throw new Error(`Refusing to build a review bundle from a dirty worktree:\n${dirty}\nCommit or stash first.`);
  }

  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z');
  const name = `processengine-review-bundle-${stamp}`;
  const staging = path.join(parent, name);
  const outZip = path.join(parent, `${name}.zip`);

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const head = git(['rev-parse', 'HEAD']).trim();
  const hasOriginMain = gitOk(['rev-parse', '--verify', 'origin/main']);
  const base = hasOriginMain ? 'origin/main' : git(['rev-list', '--max-parents=0', 'HEAD']).trim().split('\n')[0];
  const baseSha = git(['rev-parse', base]).trim();
  const mergeBase = git(['merge-base', base, 'HEAD']).trim();

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(path.join(staging, 'patches'), { recursive: true });

  // git bundle carrying BOTH origin/main and the branch, then verify no prereqs.
  const bundlePath = path.join(staging, 'repo.bundle');
  const bundleRefs = hasOriginMain ? [branch, 'origin/main'] : [branch];
  git(['bundle', 'create', bundlePath, ...bundleRefs]);
  git(['bundle', 'verify', bundlePath]);

  // Net diff and an am-applicable patch series (format-patch skips merges).
  writeFileSync(path.join(staging, 'changes.diff'), git(['diff', `${base}..HEAD`]));
  git(['format-patch', `${base}..HEAD`, '-o', path.join(staging, 'patches'), '--quiet']);

  // Git evidence.
  writeFileSync(path.join(staging, 'git-branch-head.txt'), `branch: ${branch}\nHEAD:   ${head}\nbase:   ${base} (${baseSha})\n`);
  writeFileSync(path.join(staging, 'git-merge-base.txt'), `${mergeBase}\n`);
  writeFileSync(path.join(staging, 'git-log.txt'), git(['log', '--oneline', '--decorate', `${base}..HEAD`]));
  writeFileSync(path.join(staging, 'git-diff-stat.txt'), git(['diff', '--stat', `${base}...HEAD`]));
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
    'Verify:',
    '  sha256sum -c SHA256SUMS',
    '  git bundle verify repo.bundle',
    '',
    'Restore and inspect the exact diff:',
    '  git clone repo.bundle review-clone && cd review-clone',
    `  git log --oneline --decorate origin/main..${branch}`,
    `  git diff origin/main..${branch}`,
    '  # or apply the patch series onto origin/main:',
    '  git am ../patches/*.patch',
    '',
    `Excluded from source-snapshot.zip: ${SNAPSHOT_EXCLUDES.join(' ')}`,
    '',
  ].join('\n'));

  // Checksums over every file except SHA256SUMS itself.
  const sums = listFiles(staging)
    .filter((file) => file !== 'SHA256SUMS')
    .map((file) => `${sha256(readFileSync(path.join(staging, file)))}  ${file}`);
  writeFileSync(path.join(staging, 'SHA256SUMS'), `${sums.join('\n')}\n`);

  // Zip only the staging directory (never a previously created ../*.zip), then clean up.
  rmSync(outZip, { force: true });
  execFileSync('zip', ['-r', '-q', '-X', outZip, name], { cwd: parent });
  rmSync(staging, { recursive: true, force: true });

  return { outZip, branch, head, base, mergeBase, files: sums.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await buildReviewBundle();
  const size = (statSync(result.outZip).size / (1024 * 1024)).toFixed(1);
  console.log(`Review bundle: ${result.outZip} (${size} MB)`);
  console.log(`  branch ${result.branch} @ ${result.head.slice(0, 12)} vs ${result.base} (merge-base ${result.mergeBase.slice(0, 12)}); ${result.files} files`);
}
