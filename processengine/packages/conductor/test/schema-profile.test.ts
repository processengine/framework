import { describe, expect, it } from 'vitest';
import { compileFlow, FlowDefinitionError, StaticOperationCatalog } from '../src/index.js';
import type { JsonSchema } from '../src/index.js';
// Schema-compatibility helpers are internal; tests reach them via source path.
import { assertProfileSchema, assertSwitchSchema, schemasCompatible } from '../src/schema.js';

const policy = { id: 'p', version: '1', completionTimeoutMs: 1000, dispatch: { maxAttempts: 1, retryDelayMs: 0 } };

function flowWithStartInput() {
  return {
    id: 't', version: '1', start: 'call',
    steps: {
      call: { type: 'operation', operation: 'op.a', next: 'done', onError: 'fail' },
      done: { type: 'end', outcome: 'DONE' },
      fail: { type: 'end', outcome: 'FAILED' },
    },
  };
}

function catalogWithInput(inputSchema: JsonSchema) {
  return new StaticOperationCatalog([
    { operation: 'op.a', destination: 'd', completionSource: 's', policy, inputSchema },
  ]);
}

describe('operation contract schema profile — keyword rejection', () => {
  it('accepts the supported profile keywords', () => {
    expect(() => assertProfileSchema({
      type: 'object',
      additionalProperties: false,
      required: ['id', 'tags'],
      properties: {
        id: { type: 'string', enum: ['a', 'b'] },
        tags: { type: 'array', items: { type: ['string', 'null'] } },
        nested: { type: 'object', properties: { n: { type: 'integer' } } },
      },
      title: 'Order',
      description: 'An order',
    }, 'x')).not.toThrow();
  });

  for (const [name, schema] of [
    ['maxLength', { type: 'string', maxLength: 5 }],
    ['minLength', { type: 'string', minLength: 1 }],
    ['pattern', { type: 'string', pattern: '^a' }],
    ['format', { type: 'string', format: 'email' }],
    ['const', { const: 'x' }],
    ['oneOf', { oneOf: [{ type: 'string' }] }],
    ['anyOf', { anyOf: [{ type: 'string' }] }],
    ['allOf', { allOf: [{ type: 'string' }] }],
    ['$ref', { $ref: '#/$defs/x' }],
    ['minimum', { type: 'number', minimum: 0 }],
    ['additionalProperties object-form', { type: 'object', additionalProperties: { type: 'string' } }],
    ['tuple items', { type: 'array', items: [{ type: 'string' }] }],
  ] as const) {
    it(`rejects unsupported keyword: ${name}`, () => {
      expect(() => assertProfileSchema(schema as JsonSchema, 'contract'))
        .toThrowError(FlowDefinitionError);
    });
  }

  it('names the offending keyword and path in the error', () => {
    expect(() => assertProfileSchema({ type: 'object', properties: { a: { type: 'string', maxLength: 3 } } }, 'contract'))
      .toThrowError(/contract\.properties\.a uses unsupported schema keyword "maxLength"/u);
  });
});

describe('operation contract schema profile — compiler integration', () => {
  it('rejects a flow whose operation contract uses maxLength instead of silently ignoring it', () => {
    const operations = catalogWithInput({ type: 'object', properties: { x: { type: 'string', maxLength: 5 } } });
    expect(() => compileFlow(flowWithStartInput(), { operations }))
      .toThrowError(/unsupported schema keyword "maxLength"/u);
  });

  it('compiles a flow whose contract stays inside the profile', () => {
    const operations = catalogWithInput({ type: 'object', properties: { x: { type: 'string' } } });
    expect(() => compileFlow(flowWithStartInput(), { operations })).not.toThrow();
  });
});

describe('schema compatibility — complete for the profile', () => {
  it('accepts a producer whose type/enum are subsets of the consumer', () => {
    expect(schemasCompatible({ type: 'string', enum: ['a'] }, { type: 'string', enum: ['a', 'b'] })).toBe(true);
    expect(schemasCompatible({ type: 'string', enum: ['a', 'c'] }, { type: 'string', enum: ['a', 'b'] })).toBe(false);
  });

  it('requires the producer to guarantee every consumer-required property', () => {
    const consumer: JsonSchema = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
    expect(schemasCompatible({ type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, consumer)).toBe(true);
    expect(schemasCompatible({ type: 'object', properties: { id: { type: 'string' } } }, consumer)).toBe(false);
  });

  it('detects additionalProperties incompatibility against a closed consumer', () => {
    const closed: JsonSchema = { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } };
    // open producer may emit unknown properties → incompatible with a closed consumer
    expect(schemasCompatible({ type: 'object', properties: { a: { type: 'string' } } }, closed)).toBe(false);
    // closed producer declaring an extra property → incompatible
    expect(schemasCompatible(
      { type: 'object', additionalProperties: false, properties: { a: { type: 'string' }, b: { type: 'string' } } },
      closed,
    )).toBe(false);
    // closed producer within the consumer's known set → compatible
    expect(schemasCompatible({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }, closed)).toBe(true);
  });

  it('checks array item compatibility recursively', () => {
    expect(schemasCompatible({ type: 'array', items: { type: 'string', enum: ['a'] } }, { type: 'array', items: { type: 'string', enum: ['a', 'b'] } })).toBe(true);
    expect(schemasCompatible({ type: 'array', items: { type: 'number' } }, { type: 'array', items: { type: 'string' } })).toBe(false);
  });
});

describe('switch enum coverage is still fully checked', () => {
  const producer: JsonSchema = {
    type: 'object', required: ['status'],
    properties: { status: { type: 'string', enum: ['ok', 'fail'] } },
  };
  it('accepts routes that exactly cover the producer enum', () => {
    expect(() => assertSwitchSchema(producer, 'status', { ok: 'a', fail: 'b' }, 'steps.s')).not.toThrow();
  });
  it('rejects missing or unknown routes', () => {
    expect(() => assertSwitchSchema(producer, 'status', { ok: 'a' }, 'steps.s')).toThrowError(/exactly cover/u);
    expect(() => assertSwitchSchema(producer, 'status', { ok: 'a', fail: 'b', other: 'c' }, 'steps.s')).toThrowError(/exactly cover/u);
  });
});
