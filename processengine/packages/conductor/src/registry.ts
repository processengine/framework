import { compileFlow } from './compiler.js';
import { ConductorError } from './errors.js';
import { cloneJson, deepFreeze } from './json.js';
import type {
  CompileFlowOptions,
  CompiledProcessDefinition,
  JsonSchema,
  OperationContract,
} from './types.js';
import type { ArtifactRegistry, OperationBinding, OperationCatalog, OperationPolicy } from './spi.js';

export class StaticArtifactRegistry implements ArtifactRegistry {
  private readonly definitions = new Map<string, CompiledProcessDefinition>();

  constructor(definitions: readonly (CompiledProcessDefinition | unknown)[], options: CompileFlowOptions = {}) {
    for (const candidate of definitions) {
      const compiled = verifiedCompilation(candidate, options);
      const key = `${compiled.definition.id}@${compiled.definition.version}`;
      if (this.definitions.has(key)) throw new ConductorError('FLOW_DUPLICATE', `Duplicate flow ${key}`);
      this.definitions.set(key, compiled);
    }
  }

  get(id: string, version: string): CompiledProcessDefinition | undefined {
    return this.definitions.get(`${id}@${version}`);
  }
}

export class StaticOperationCatalog implements OperationCatalog {
  private readonly bindings = new Map<string, OperationBinding>();

  constructor(bindings: readonly OperationBinding[]) {
    for (const candidate of bindings) {
      validateBinding(candidate);
      if (this.bindings.has(candidate.operation)) {
        throw new ConductorError('OPERATION_DUPLICATE', `Duplicate operation binding ${candidate.operation}`);
      }
      this.bindings.set(candidate.operation, freezeBinding(candidate));
    }
  }

  get(operation: string): OperationBinding | undefined {
    return this.bindings.get(operation);
  }

  getContract(operation: string): OperationContract | undefined {
    return this.bindings.get(operation);
  }
}

function verifiedCompilation(value: unknown, options: CompileFlowOptions): CompiledProcessDefinition {
  if (value !== null && typeof value === 'object' && 'definition' in value && 'digest' in value) {
    const candidate = value as { readonly definition: unknown; readonly digest: unknown };
    const compiled = compileFlow(candidate.definition, options);
    if (candidate.digest !== compiled.digest) {
      throw new ConductorError(
        'FLOW_DIGEST_MISMATCH',
        `Compiled artifact ${compiled.definition.id}@${compiled.definition.version} has an invalid digest`,
      );
    }
    return compiled;
  }
  return compileFlow(value, options);
}

function validateBinding(binding: OperationBinding): void {
  if (!binding.operation || !binding.destination || !binding.completionSource) {
    throw new ConductorError(
      'OPERATION_BINDING_INVALID',
      'Operation binding requires operation, destination and completionSource',
    );
  }
  validatePolicy(binding.policy);
}

function validatePolicy(policy: OperationPolicy): void {
  if (!policy.id || !policy.version || !Number.isSafeInteger(policy.completionTimeoutMs) || policy.completionTimeoutMs <= 0) {
    throw new ConductorError('OPERATION_POLICY_INVALID', 'Operation policy identity or timeout is invalid');
  }
  if (!Number.isSafeInteger(policy.dispatch.maxAttempts) || policy.dispatch.maxAttempts <= 0
    || !Number.isSafeInteger(policy.dispatch.retryDelayMs) || policy.dispatch.retryDelayMs < 0) {
    throw new ConductorError('OPERATION_POLICY_INVALID', 'Operation dispatch policy is invalid');
  }
}

function cloneSchema(schema: JsonSchema | undefined): JsonSchema | undefined {
  return schema ? cloneJson(schema) as JsonSchema : undefined;
}

function freezeBinding(binding: OperationBinding): OperationBinding {
  return deepFreeze({
    operation: binding.operation,
    destination: binding.destination,
    completionSource: binding.completionSource,
    policy: {
      id: binding.policy.id,
      version: binding.policy.version,
      completionTimeoutMs: binding.policy.completionTimeoutMs,
      dispatch: { ...binding.policy.dispatch },
    },
    ...(binding.inputSchema ? { inputSchema: cloneSchema(binding.inputSchema)! } : {}),
    ...(binding.responseSchema ? { responseSchema: cloneSchema(binding.responseSchema)! } : {}),
    ...(binding.errorSchema ? { errorSchema: cloneSchema(binding.errorSchema)! } : {}),
  });
}
