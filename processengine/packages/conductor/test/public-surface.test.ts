import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

// The public entrypoint is a curated contract. These tests fix the surface: the
// documented runtime values must be present, and internal machinery must NOT be
// reachable through the package root (it stays importable only via deep source
// paths inside the package, never through package exports).

const PUBLIC_VALUES = [
  'Conductor', 'createConductor',
  'compileFlow', 'StaticArtifactRegistry', 'StaticOperationCatalog',
  'ProcessEngineError', 'FlowDefinitionError', 'ProcessExecutionError', 'ConductorError', 'ProtocolError',
  'CORE_OPERATION_ERRORS', 'CORE_OPERATION_ERROR_CODES',
  'OPERATION_COMMAND', 'OPERATION_COMPLETION',
  'operationCommandEnvelope', 'operationCompletionEnvelope', 'responseEnvelope',
  'parseOperationCommand', 'assertOperationCommand', 'parseOperationCompletion', 'completionPayload',
] as const;

// Internal runtime helpers that must never be part of the public root export.
const INTERNAL_VALUES = [
  'evolve', 'success', 'failure', 'normalizeCompletion',
  'schemasCompatible', 'assertProfileSchema', 'assertSwitchSchema', 'withCoreOperationErrors',
  'cloneJson', 'canonicalJson', 'digestJson', 'deepFreeze', 'isRecord',
  'MemoryProcessStorage', 'MemoryMessageTransport', 'createMemoryStorage',
] as const;

describe('curated public API surface', () => {
  it('exports every documented runtime value from the package root', () => {
    for (const name of PUBLIC_VALUES) {
      expect(api, `missing public export: ${name}`).toHaveProperty(name);
      expect((api as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  it('does not leak internal helpers through the package root', () => {
    for (const name of INTERNAL_VALUES) {
      expect(Object.prototype.hasOwnProperty.call(api, name), `internal helper leaked: ${name}`).toBe(false);
    }
  });

  it('does not re-export via an uncontrolled star (no accidental symbols)', () => {
    // Only the curated named runtime values are present (types are erased).
    const runtimeExports = Object.keys(api).sort();
    expect(runtimeExports).toEqual([...PUBLIC_VALUES].sort());
  });
});
