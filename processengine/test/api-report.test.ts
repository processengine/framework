import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const reportsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'api-reports');
const read = (file: string) => readFileSync(path.join(reportsDir, file), 'utf8');

// One API Extractor report per published TypeScript entrypoint declared in
// package.json exports. The reports capture full declarations, so signature
// changes — not just added/removed names — trip the drift gate (npm run api:check).
const REPORTS = [
  'conductor.api.md',
  'conductor-testing.api.md',
  'transport-kafka.api.md',
  'transport-kafka-worker.api.md',
  'storage-postgres.api.md',
  'storage-postgres-migrations.api.md',
];

describe('API reports cover every entrypoint', () => {
  it.each(REPORTS)('%s is an API Extractor report', (file) => {
    const report = read(file);
    expect(report).toContain('API Report File for');
    expect(report).toContain('```ts');
  });
});

describe('API reports are signature-level, not name-only', () => {
  it('pins full function signatures (parameter and return types)', () => {
    const report = read('conductor.api.md');
    // Exact parameter and return types are captured. A change such as
    // `value: unknown` -> `value: string` (same export name and kind) would alter
    // this line, so `api:check` would fail until the report is regenerated.
    expect(report).toContain('compileFlow(value: unknown, options?: CompileFlowOptions): CompiledProcessDefinition;');
    expect(report).not.toContain('compileFlow(value: string');
  });

  it('pins interface fields and their optionality', () => {
    const report = read('conductor.api.md');
    // Optional members are recorded with `?:`; flipping required <-> optional
    // changes the report.
    expect(report).toMatch(/readonly operations\?: OperationContractRegistry;/u);
  });
});

describe('the transition kernel is public only through /testing', () => {
  it('is absent from the conductor root report', () => {
    const root = read('conductor.api.md');
    expect(root).not.toMatch(/export function evolve\b/u);
    expect(root).not.toMatch(/export function success\b/u);
    expect(root).not.toMatch(/export function failure\b/u);
    expect(root).not.toMatch(/interface TransitionResult\b/u);
  });

  it('is present in the conductor/testing report with full signatures', () => {
    const testing = read('conductor-testing.api.md');
    expect(testing).toMatch(/export function evolve\(definition: CompiledProcessDefinition, previous: ProcessState \| undefined, event: ProcessEvent\): TransitionResult;/u);
    expect(testing).toContain('export function success(response: JsonValue): OperationCompletion;');
    expect(testing).toContain('export function failure(error: OperationError): OperationCompletion;');
  });
});
