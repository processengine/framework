import { FlowDefinitionError } from './errors.js';
import { cloneJson, deepFreeze, digestJson, isRecord } from './json.js';
import { assertProfileSchema, assertSwitchSchema, schemasCompatible, withCoreOperationErrors } from './schema.js';
import type {
  CompileFlowOptions,
  CompiledProcessDefinition,
  EndStep,
  JsonSchema,
  OperationContract,
  OperationStep,
  ProcessDefinition,
  ProcessStep,
  StepInput,
  SwitchStep,
} from './types.js';

const ID = /^[A-Za-z][A-Za-z0-9._-]*$/u;
const STEP_ID = /^[A-Za-z][A-Za-z0-9_-]*$/u;

function text(value: unknown, at: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || (pattern && !pattern.test(value))) {
    throw new FlowDefinitionError(`Expected a non-empty valid string at ${at}`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new FlowDefinitionError(`Unknown field at ${at}`, { fields: unknown });
}

function parseInput(value: unknown, at: string): StepInput {
  if (!isRecord(value)) throw new FlowDefinitionError(`${at} must be an object`);
  exactKeys(value, ['step', 'resultType'], at);
  const step = text(value.step, `${at}.step`, STEP_ID);
  if (value.resultType !== 'response' && value.resultType !== 'error') {
    throw new FlowDefinitionError(`${at}.resultType must be response or error`);
  }
  return { step, resultType: value.resultType };
}

function parseStep(stepId: string, value: unknown): ProcessStep {
  if (!isRecord(value)) throw new FlowDefinitionError(`steps.${stepId} must be an object`);
  if (value.type === 'operation') {
    exactKeys(value, ['type', 'operation', 'input', 'next', 'onError'], `steps.${stepId}`);
    const step: OperationStep = {
      type: 'operation',
      operation: text(value.operation, `steps.${stepId}.operation`, ID),
      next: text(value.next, `steps.${stepId}.next`, STEP_ID),
      onError: text(value.onError, `steps.${stepId}.onError`, STEP_ID),
      ...(value.input === undefined ? {} : { input: parseInput(value.input, `steps.${stepId}.input`) }),
    };
    return step;
  }
  if (value.type === 'switch') {
    exactKeys(value, ['type', 'input', 'key', 'routes'], `steps.${stepId}`);
    if (!isRecord(value.routes) || Object.keys(value.routes).length === 0) {
      throw new FlowDefinitionError(`steps.${stepId}.routes must be a non-empty object`);
    }
    const routes: Record<string, string> = {};
    for (const [route, target] of Object.entries(value.routes)) {
      if (route.length === 0) throw new FlowDefinitionError(`steps.${stepId}.routes contains an empty value`);
      routes[route] = text(target, `steps.${stepId}.routes.${route}`, STEP_ID);
    }
    const step: SwitchStep = {
      type: 'switch',
      input: parseInput(value.input, `steps.${stepId}.input`),
      key: text(value.key, `steps.${stepId}.key`),
      routes,
    };
    return step;
  }
  if (value.type === 'end') {
    exactKeys(value, ['type', 'outcome', 'input'], `steps.${stepId}`);
    const step: EndStep = {
      type: 'end',
      outcome: text(value.outcome, `steps.${stepId}.outcome`),
      ...(value.input === undefined ? {} : { input: parseInput(value.input, `steps.${stepId}.input`) }),
    };
    return step;
  }
  throw new FlowDefinitionError(`Unknown step type at steps.${stepId}`);
}

interface Edge {
  readonly from: string;
  readonly to: string;
  readonly fact?: string;
}

function edgesFrom(stepId: string, step: ProcessStep): Edge[] {
  if (step.type === 'operation') {
    return [
      { from: stepId, to: step.next, fact: `${stepId}:response` },
      { from: stepId, to: step.onError, fact: `${stepId}:error` },
    ];
  }
  if (step.type === 'switch') return Object.values(step.routes).map((to) => ({ from: stepId, to }));
  return [];
}

function stepInput(step: ProcessStep): StepInput | undefined {
  return step.input;
}

function contractFor(
  operation: string,
  options: CompileFlowOptions,
  required: boolean,
): OperationContract | undefined {
  const contract = options.operations?.getContract(operation);
  if (required && options.operations && !contract) {
    throw new FlowDefinitionError(`Operation ${operation} has no registered contract`);
  }
  return contract;
}

function resultSchema(
  definition: ProcessDefinition,
  input: StepInput,
  options: CompileFlowOptions,
): JsonSchema | undefined {
  const producer = definition.steps[input.step];
  if (producer?.type !== 'operation') return undefined;
  const contract = contractFor(producer.operation, options, false);
  if (input.resultType === 'response') return contract?.responseSchema;
  return contract?.errorSchema ? withCoreOperationErrors(contract.errorSchema) : undefined;
}

function intersect(sets: readonly ReadonlySet<string>[]): Set<string> {
  if (sets.length === 0) return new Set();
  const [first, ...rest] = sets;
  return new Set([...first!].filter((value) => rest.every((set) => set.has(value))));
}

function validateDefinition(definition: ProcessDefinition, options: CompileFlowOptions): void {
  const stepIds = Object.keys(definition.steps);
  const ids = new Set(stepIds);
  const start = definition.steps[definition.start];
  if (!start) throw new FlowDefinitionError('start references a missing step', { start: definition.start });
  if (start.type !== 'operation') throw new FlowDefinitionError('start must reference an operation step');

  const edges = stepIds.flatMap((stepId) => edgesFrom(stepId, definition.steps[stepId]!));
  for (const edge of edges) {
    if (!ids.has(edge.to)) throw new FlowDefinitionError(`Step ${edge.from} references missing step ${edge.to}`);
  }

  for (const [stepId, step] of Object.entries(definition.steps)) {
    if (step.type === 'operation') {
      if (stepId === definition.start && step.input !== undefined) {
        throw new FlowDefinitionError('The start operation must not declare input');
      }
      if (stepId !== definition.start && step.input === undefined) {
        throw new FlowDefinitionError(`Operation ${stepId} must declare input`);
      }
      contractFor(step.operation, options, true);
    }
  }

  const adjacency = new Map<string, string[]>();
  const incoming = new Map<string, Edge[]>();
  for (const id of stepIds) {
    adjacency.set(id, []);
    incoming.set(id, []);
  }
  for (const edge of edges) {
    adjacency.get(edge.from)!.push(edge.to);
    incoming.get(edge.to)!.push(edge);
  }

  const color = new Map<string, 0 | 1 | 2>();
  const order: string[] = [];
  const visit = (stepId: string, path: readonly string[]): void => {
    if (color.get(stepId) === 1) {
      const index = path.indexOf(stepId);
      throw new FlowDefinitionError('Flow control graph must be acyclic', { cycle: [...path.slice(index), stepId] });
    }
    if (color.get(stepId) === 2) return;
    color.set(stepId, 1);
    for (const target of adjacency.get(stepId)!) visit(target, [...path, stepId]);
    color.set(stepId, 2);
    order.push(stepId);
  };
  visit(definition.start, []);
  const unreachable = stepIds.filter((id) => color.get(id) !== 2);
  if (unreachable.length > 0) throw new FlowDefinitionError('Flow contains unreachable steps', { steps: unreachable });
  order.reverse();

  const canReachEnd = new Set<string>();
  for (const stepId of [...order].reverse()) {
    const step = definition.steps[stepId]!;
    if (step.type === 'end' || adjacency.get(stepId)!.every((target) => canReachEnd.has(target))) canReachEnd.add(stepId);
  }
  const dead = order.filter((id) => !canReachEnd.has(id));
  if (dead.length > 0) throw new FlowDefinitionError('Every reachable control path must end at end', { steps: dead });

  const available = new Map<string, Set<string>>();
  for (const stepId of order) {
    const predecessorFacts = incoming.get(stepId)!.map((edge) => {
      const facts = new Set(available.get(edge.from) ?? []);
      if (edge.fact) facts.add(edge.fact);
      return facts;
    });
    const facts = stepId === definition.start ? new Set<string>() : intersect(predecessorFacts);
    available.set(stepId, facts);
    const input = stepInput(definition.steps[stepId]!);
    if (input) {
      const producer = definition.steps[input.step];
      if (producer?.type !== 'operation') {
        throw new FlowDefinitionError(`steps.${stepId}.input.step must reference an operation`, { producer: input.step });
      }
      if (!facts.has(`${input.step}:${input.resultType}`)) {
        throw new FlowDefinitionError(`steps.${stepId}.input is not available on every control path`, {
          step: input.step,
          resultType: input.resultType,
        });
      }
    }
  }

  if (options.processInputSchema) {
    assertProfileSchema(options.processInputSchema, 'processInputSchema');
  }

  if (options.operations) {
    // Every operation contract schema the compiler reasons about must lie inside
    // the declared profile; unsupported keywords are rejected, never ignored.
    const validated = new Set<string>();
    for (const step of Object.values(definition.steps)) {
      if (step.type !== 'operation' || validated.has(step.operation)) continue;
      validated.add(step.operation);
      const contract = contractFor(step.operation, options, true)!;
      if (contract.inputSchema) assertProfileSchema(contract.inputSchema, `operation ${step.operation} inputSchema`);
      if (contract.responseSchema) assertProfileSchema(contract.responseSchema, `operation ${step.operation} responseSchema`);
      if (contract.errorSchema) assertProfileSchema(contract.errorSchema, `operation ${step.operation} errorSchema`);
    }

    const startContract = contractFor(start.operation, options, true)!;
    if (options.processInputSchema && startContract.inputSchema
      && !schemasCompatible(options.processInputSchema, startContract.inputSchema)) {
      throw new FlowDefinitionError('Process input schema is incompatible with the start operation input schema');
    }
    for (const [stepId, step] of Object.entries(definition.steps)) {
      const input = stepInput(step);
      if (!input) continue;
      const producerSchema = resultSchema(definition, input, options);
      if (step.type === 'operation') {
        const consumerSchema = contractFor(step.operation, options, true)!.inputSchema;
        if (producerSchema && consumerSchema && !schemasCompatible(producerSchema, consumerSchema)) {
          throw new FlowDefinitionError(`steps.${stepId}.input schema is incompatible with operation ${step.operation}`);
        }
      } else if (step.type === 'switch' && producerSchema) {
        assertSwitchSchema(producerSchema, step.key, step.routes, `steps.${stepId}`);
      }
    }
  }
}

export function compileFlow(value: unknown, options: CompileFlowOptions = {}): CompiledProcessDefinition {
  if (!isRecord(value)) throw new FlowDefinitionError('Flow definition must be an object');
  exactKeys(value, ['id', 'version', 'start', 'steps'], '$');
  if (!isRecord(value.steps) || Object.keys(value.steps).length === 0) {
    throw new FlowDefinitionError('steps must be a non-empty object');
  }
  const steps: Record<string, ProcessStep> = {};
  for (const [stepId, step] of Object.entries(value.steps)) {
    text(stepId, 'step id', STEP_ID);
    steps[stepId] = parseStep(stepId, step);
  }
  const definition: ProcessDefinition = {
    id: text(value.id, 'id', ID),
    version: text(value.version, 'version'),
    start: text(value.start, 'start', STEP_ID),
    steps,
  };
  validateDefinition(definition, options);
  const owned = cloneJson(definition) as unknown as ProcessDefinition;
  return Object.freeze({ definition: deepFreeze(owned), digest: digestJson(owned as unknown as never) });
}
