import { describe, expect, it } from 'vitest';
import { EVIDENCE_FILES, SNAPSHOT_EXCLUDES } from '../../scripts/review-bundle.mjs';

// The review bundle must never ship caches/artifacts/build output/credentials, and
// must always carry independent git evidence. This pins that include/exclude
// policy so a regression in scripts/review-bundle.mjs is caught.

describe('review bundle policy', () => {
  it('excludes caches, artifacts, build output, old archives and credentials', () => {
    const required = [
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
    ];
    for (const pattern of required) {
      expect(SNAPSHOT_EXCLUDES, `missing exclude: ${pattern}`).toContain(pattern);
    }
  });

  it('always includes the git bundle, the diff, the evidence files and a checksum manifest', () => {
    const required = [
      'repo.bundle',
      'changes.diff',
      'git-branch-head.txt',
      'git-merge-base.txt',
      'git-log.txt',
      'git-diff-stat.txt',
      'git-status.txt',
      'git-diff-check.txt',
      'source-snapshot.zip',
      'SHA256SUMS',
    ];
    for (const file of required) {
      expect(EVIDENCE_FILES, `missing evidence file: ${file}`).toContain(file);
    }
  });
});
