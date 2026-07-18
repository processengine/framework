import { createHash } from 'node:crypto';
import { FlowDefinitionError } from './errors.js';
import type { JsonObject, JsonValue } from './types.js';

export function cloneJson(value: unknown, path = '$'): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new FlowDefinitionError(`Invalid JSON number at ${path}`);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${path}[${index}]`));
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new FlowDefinitionError(`Value at ${path} is not JSON-safe`);
  }
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value)) output[key] = cloneJson(item, `${path}.${key}`);
  return output;
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
}

export function digestJson(value: JsonValue): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
