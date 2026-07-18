import { FlowDefinitionError } from './errors.js';
import { CORE_OPERATION_ERROR_CODES } from './core-errors.js';
import { cloneJson, isRecord } from './json.js';
import type { JsonSchema, JsonValue } from './types.js';

function schemaTypes(schema: JsonSchema): Set<string> | undefined {
  const type = schema.type;
  if (typeof type === 'string') return new Set([type]);
  if (Array.isArray(type) && type.every((item) => typeof item === 'string')) return new Set(type);
  return undefined;
}

function schemaEnum(schema: JsonSchema): readonly JsonValue[] | undefined {
  return Array.isArray(schema.enum) ? schema.enum : undefined;
}

function schemaProperties(schema: JsonSchema): Record<string, JsonSchema> {
  if (!isRecord(schema.properties)) return {};
  const properties: Record<string, JsonSchema> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    if (isRecord(value)) properties[key] = value as JsonSchema;
  }
  return properties;
}

function requiredProperties(schema: JsonSchema): Set<string> {
  return new Set(Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : []);
}

export function schemasCompatible(producer: JsonSchema, consumer: JsonSchema): boolean {
  const producerTypes = schemaTypes(producer);
  const consumerTypes = schemaTypes(consumer);
  if (consumerTypes) {
    if (!producerTypes) return false;
    for (const type of producerTypes) if (!consumerTypes.has(type)) return false;
  }

  const producerEnum = schemaEnum(producer);
  const consumerEnum = schemaEnum(consumer);
  if (consumerEnum) {
    if (!producerEnum) return false;
    const accepted = new Set(consumerEnum.map((value) => JSON.stringify(value)));
    if (producerEnum.some((value) => !accepted.has(JSON.stringify(value)))) return false;
  }

  if (consumerTypes?.has('object') || requiredProperties(consumer).size > 0) {
    const producerRequired = requiredProperties(producer);
    const consumerRequired = requiredProperties(consumer);
    const producerProperties = schemaProperties(producer);
    const consumerProperties = schemaProperties(consumer);
    for (const key of consumerRequired) {
      if (!producerRequired.has(key)) return false;
      const expected = consumerProperties[key];
      const actual = producerProperties[key];
      if (expected && (!actual || !schemasCompatible(actual, expected))) return false;
    }
  }

  if (consumerTypes?.has('array') && isRecord(consumer.items)) {
    if (!isRecord(producer.items) || !schemasCompatible(producer.items as JsonSchema, consumer.items as JsonSchema)) return false;
  }

  return true;
}

export function withCoreOperationErrors(schema: JsonSchema): JsonSchema {
  const cloned = cloneJson(schema) as JsonSchema;
  if (!isRecord(cloned.properties)) return cloned;
  const code = cloned.properties.code;
  if (!isRecord(code) || !Array.isArray(code.enum) || code.enum.some((value) => typeof value !== 'string')) return cloned;
  code.enum = [...new Set([...code.enum, ...CORE_OPERATION_ERROR_CODES])];
  return cloned;
}

export function assertSwitchSchema(
  schema: JsonSchema,
  key: string,
  routes: Readonly<Record<string, string>>,
  at: string,
): void {
  const types = schemaTypes(schema);
  if (!types?.has('object')) throw new FlowDefinitionError(`${at} input schema must be an object`);
  if (!requiredProperties(schema).has(key)) {
    throw new FlowDefinitionError(`${at}.key must be required by the producer schema`, { key });
  }
  const property = schemaProperties(schema)[key];
  if (!property || !schemaTypes(property)?.has('string')) {
    throw new FlowDefinitionError(`${at}.key must reference a string property`, { key });
  }
  const values = schemaEnum(property);
  if (!values || values.length === 0 || values.some((value) => typeof value !== 'string')) {
    throw new FlowDefinitionError(`${at}.key schema must declare a non-empty string enum`, { key });
  }
  const expected = new Set(values as readonly string[]);
  const actual = new Set(Object.keys(routes));
  const missing = [...expected].filter((value) => !actual.has(value));
  const unknown = [...actual].filter((value) => !expected.has(value));
  if (missing.length > 0 || unknown.length > 0) {
    throw new FlowDefinitionError(`${at}.routes must exactly cover the producer enum`, { missing, unknown });
  }
}
