import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  StaticArtifactRegistry,
  StaticOperationCatalog,
  compileFlow,
  type OperationBinding,
} from '@processengine/conductor';
import { describe, expect, it } from 'vitest';

type FlowFixture = {
  id: string;
  version: string;
  steps: Record<string, { type: string; operation?: string; input?: { step?: string } }>;
};
const flows = ['v1', 'v2'].map((name) => JSON.parse(readFileSync(
  fileURLToPath(new URL(`../flows/shop.checkout.${name}.json`, import.meta.url)),
  'utf8',
)) as FlowFixture);
const flow = flows[0]!;
const flowV2 = JSON.parse(readFileSync(fileURLToPath(new URL('../flows/shop.checkout.v2.json', import.meta.url)), 'utf8')) as typeof flow;
const bindings = JSON.parse(readFileSync(
  fileURLToPath(new URL('../config/operations.json', import.meta.url)),
  'utf8',
)) as OperationBinding[];

describe('checkout artifact', () => {
  it('compiles every configured immutable artifact and addresses each exact version', () => {
    const operations = new StaticOperationCatalog(bindings);
    const compiled = flows.map((definition) => compileFlow(definition, { operations }));
    const registry = new StaticArtifactRegistry(compiled, { operations });

    expect(compiled.map((artifact) => artifact.definition.id)).toEqual(['shop.checkout', 'shop.checkout']);
    expect(compiled.map((artifact) => artifact.definition.version)).toEqual(['1.0.0', '2.0.0']);
    for (const artifact of compiled) {
      expect(artifact.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(registry.get('shop.checkout', artifact.definition.version)?.digest).toBe(artifact.digest);
    }
    expect(new Set(compiled.map((artifact) => artifact.digest)).size).toBe(2);
    expect(registry.get('shop.checkout', '9.9.9')).toBeUndefined();
  });

  it('uses only catalogued operations and explicitly carries prior results into compensation', () => {
    const catalogued = new Set(bindings.map((binding) => binding.operation));
    const used = Object.values(flow.steps)
      .filter((step) => step.type === 'operation')
      .map((step) => step.operation);

    expect(new Set(used)).toEqual(catalogued);
    expect(flow.steps['cancel-after-confirm-failure']?.input?.step).toBe('authorize-payment');
    expect(flow.steps['release-after-confirm-failure']?.input?.step).toBe('reserve-stock');
    expect(new Set(Object.values(flow.steps).map((step) => step.type))).toEqual(new Set(['operation', 'switch', 'end']));
  });

  it('pins every completion to the expected domain service identity', () => {
    expect(bindings).toHaveLength(5);
    for (const binding of bindings) {
      const expected = binding.operation.startsWith('warehouse.')
        ? 'test-shop.shop-warehouse'
        : 'test-shop.shop-payment';
      expect(binding.completionSource).toBe(expected);
    }
  });

  it('ships v1 and v2 as distinct explicit immutable artifacts', () => {
    const operations = new StaticOperationCatalog(bindings);
    const v1 = compileFlow(flow, { operations });
    const v2 = compileFlow(flowV2, { operations });
    const registry = new StaticArtifactRegistry([v1, v2], { operations });

    expect(flow.version).toBe('1.0.0');
    expect(flowV2.version).toBe('2.0.0');
    expect((flowV2.steps.approved as { outcome?: string }).outcome).toBe('APPROVED_V2');
    expect(v2.digest).not.toBe(v1.digest);
    expect(registry.get('shop.checkout', '1.0.0')?.digest).toBe(v1.digest);
    expect(registry.get('shop.checkout', '2.0.0')?.digest).toBe(v2.digest);
  });
});
