import { describe, expect, it } from 'vitest';
import { kindClusterName, kindLoadPlan } from '../scripts/kind.mjs';

const images = [
  { image: 'processengine/test-shop-shop-host:sha-local-abc' },
  { image: 'processengine/test-shop-shop-warehouse:sha-local-abc' },
  { image: 'processengine/test-shop-shop-payment:sha-local-abc' },
];

describe('kind image load plan', () => {
  it('derives the cluster name from a kind context', () => {
    expect(kindClusterName('kind-ci')).toBe('ci');
    expect(kindClusterName('kind-nightly')).toBe('nightly');
    expect(kindClusterName('docker-desktop')).toBeUndefined();
  });

  it('does not touch kind on docker-desktop', () => {
    expect(kindLoadPlan('docker-desktop', images)).toEqual([]);
  });

  it('loads exactly the three built images into the right kind cluster', () => {
    const plan = kindLoadPlan('kind-ci', images);
    expect(plan).toHaveLength(3);
    expect(plan.map((step) => step.args)).toEqual([
      ['load', 'docker-image', images[0].image, '--name', 'ci'],
      ['load', 'docker-image', images[1].image, '--name', 'ci'],
      ['load', 'docker-image', images[2].image, '--name', 'ci'],
    ]);
    expect(plan.every((step) => step.program === 'kind')).toBe(true);
  });
});
