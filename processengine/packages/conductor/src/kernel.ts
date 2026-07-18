import { ProcessExecutionError } from './errors.js';
import { cloneJson, isRecord } from './json.js';
import type {
  CompiledProcessDefinition,
  ConductorAction,
  JsonValue,
  OperationCompletion,
  OperationError,
  ProcessEvent,
  ProcessFault,
  ProcessState,
  StepInput,
  TransitionResult,
} from './types.js';

function cloneOperationError(value: unknown): OperationError {
  if (!isRecord(value)) throw new ProcessExecutionError('OPERATION_ERROR_INVALID', 'Operation error must be an object');
  const keys = Object.keys(value);
  if (keys.some((key) => !['code', 'message', 'details'].includes(key))
    || typeof value.code !== 'string' || value.code.length === 0
    || typeof value.message !== 'string' || value.message.length === 0
    || !Object.hasOwn(value, 'details')) {
    throw new ProcessExecutionError('OPERATION_ERROR_INVALID', 'Operation error must contain code, message and details');
  }
  return {
    code: value.code,
    message: value.message,
    details: cloneJson(value.details, '$.error.details'),
  };
}

export function normalizeCompletion(value: unknown): OperationCompletion {
  if (!isRecord(value)) throw new ProcessExecutionError('OPERATION_COMPLETION_INVALID', 'Completion must be an object');
  if (Object.keys(value).some((key) => !['status', 'response', 'error'].includes(key))
    || !Object.hasOwn(value, 'response') || !Object.hasOwn(value, 'error')) {
    throw new ProcessExecutionError('OPERATION_COMPLETION_INVALID', 'Completion must explicitly contain status, response and error');
  }
  if (value.status === 'SUCCESS') {
    if (value.error !== null) throw new ProcessExecutionError('OPERATION_COMPLETION_INVALID', 'SUCCESS requires error: null');
    return { status: 'SUCCESS', response: cloneJson(value.response, '$.completion.response'), error: null };
  }
  if (value.status === 'ERROR') {
    if (value.response !== null) throw new ProcessExecutionError('OPERATION_COMPLETION_INVALID', 'ERROR requires response: null');
    return { status: 'ERROR', response: null, error: cloneOperationError(value.error) };
  }
  throw new ProcessExecutionError('OPERATION_COMPLETION_INVALID', 'Completion status must be SUCCESS or ERROR');
}

function resolveInput(state: ProcessState, input: StepInput): JsonValue | OperationError {
  const completion = state.results[input.step];
  if (!completion) {
    throw new ProcessExecutionError('PROCESS_INPUT_MISSING', `Result of step ${input.step} is not available`, { step: input.step });
  }
  if (input.resultType === 'response') {
    if (completion.status !== 'SUCCESS') {
      throw new ProcessExecutionError('PROCESS_INPUT_TYPE_MISMATCH', `Step ${input.step} has no successful response`);
    }
    return cloneJson(completion.response);
  }
  if (completion.status !== 'ERROR') {
    throw new ProcessExecutionError('PROCESS_INPUT_TYPE_MISMATCH', `Step ${input.step} has no error result`);
  }
  return cloneJson(completion.error) as unknown as OperationError;
}

function asJson(value: JsonValue | OperationError): JsonValue {
  return cloneJson(value) as JsonValue;
}

function advance(definition: CompiledProcessDefinition, initial: ProcessState): TransitionResult {
  let state = initial;
  const visited = new Set<string>();
  for (;;) {
    if (visited.has(state.currentStep)) {
      throw new ProcessExecutionError('PROCESS_CONTROL_CYCLE', `Control cycle encountered at ${state.currentStep}`);
    }
    visited.add(state.currentStep);
    const step = definition.definition.steps[state.currentStep];
    if (!step) throw new ProcessExecutionError('PROCESS_POSITION_INVALID', `Missing current step ${state.currentStep}`);

    if (step.type === 'switch') {
      const input = resolveInput(state, step.input);
      if (!isRecord(input)) throw new ProcessExecutionError('SWITCH_INPUT_INVALID', `Switch ${state.currentStep} input must be an object`);
      const value = input[step.key];
      if (typeof value !== 'string') {
        throw new ProcessExecutionError('SWITCH_KEY_INVALID', `Switch ${state.currentStep} key ${step.key} must be a string`);
      }
      const next = step.routes[value];
      if (!next) {
        throw new ProcessExecutionError('SWITCH_ROUTE_UNKNOWN', `Switch ${state.currentStep} has no route for ${value}`, {
          step: state.currentStep,
          key: step.key,
          value,
        });
      }
      state = { ...state, currentStep: next };
      continue;
    }

    if (step.type === 'operation') {
      if (state.results[state.currentStep]) {
        throw new ProcessExecutionError('PROCESS_STEP_REPEATED', `Operation step ${state.currentStep} has already completed`);
      }
      const input = state.currentStep === definition.definition.start
        ? cloneJson(state.input)
        : step.input
          ? asJson(resolveInput(state, step.input))
          : (() => { throw new ProcessExecutionError('PROCESS_INPUT_MISSING', `Operation ${state.currentStep} has no input`); })();
      const requestId = `${state.instanceId}:${state.currentStep}`;
      state = {
        ...state,
        lifecycle: 'WAITING',
        pending: {
          executionId: requestId,
          requestId,
          stepId: state.currentStep,
          operation: step.operation,
        },
      };
      return {
        state,
        action: {
          type: 'DISPATCH_OPERATION',
          requestId,
          instanceId: state.instanceId,
          stepId: state.currentStep,
          operation: step.operation,
          input,
        },
      };
    }

    let response: JsonValue = null;
    let error: OperationError | null = null;
    if (step.input) {
      const terminal = resolveInput(state, step.input);
      if (step.input.resultType === 'response') response = asJson(terminal);
      else error = terminal as OperationError;
    }
    state = {
      ...state,
      lifecycle: 'COMPLETED',
      pending: null,
      outcome: step.outcome,
      response,
      error,
      fault: null,
    };
    return {
      state,
      action: {
        type: 'PROCESS_COMPLETED',
        instanceId: state.instanceId,
        outcome: step.outcome,
        response,
        error,
      },
    };
  }
}

function advanceOrFault(definition: CompiledProcessDefinition, state: ProcessState): TransitionResult {
  try {
    return advance(definition, state);
  } catch (error) {
    if (!(error instanceof ProcessExecutionError)) throw error;
    const fault: ProcessFault = {
      code: error.code,
      message: error.message,
      details: cloneJson(error.details),
    };
    const faulted: ProcessState = {
      ...state,
      lifecycle: 'FAULTED',
      pending: null,
      outcome: null,
      response: null,
      error: null,
      fault,
    };
    return {
      state: faulted,
      action: { type: 'PROCESS_FAULTED', instanceId: state.instanceId, fault },
    };
  }
}

function assertPinned(definition: CompiledProcessDefinition, state: ProcessState): void {
  if (state.flow.id !== definition.definition.id
    || state.flow.version !== definition.definition.version
    || state.flow.digest !== definition.digest) {
    throw new ProcessExecutionError('PROCESS_DEFINITION_MISMATCH', 'Process state is pinned to another definition');
  }
}

export function evolve(
  definition: CompiledProcessDefinition,
  previous: ProcessState | undefined,
  event: ProcessEvent,
): TransitionResult {
  if (event.type === 'START') {
    if (previous !== undefined) throw new ProcessExecutionError('PROCESS_ALREADY_STARTED', 'START requires no previous state');
    const state: ProcessState = {
      instanceId: event.instanceId,
      flow: {
        id: definition.definition.id,
        version: definition.definition.version,
        digest: definition.digest,
      },
      lifecycle: 'RUNNING',
      revision: 1,
      currentStep: definition.definition.start,
      input: cloneJson(event.input),
      results: {},
      pending: null,
      outcome: null,
      response: null,
      error: null,
      fault: null,
      createdAt: event.at,
      updatedAt: event.at,
    };
    return advanceOrFault(definition, state);
  }

  if (!previous) throw new ProcessExecutionError('PROCESS_NOT_STARTED', 'Operation completion requires process state');
  assertPinned(definition, previous);
  if (previous.lifecycle !== 'WAITING' || !previous.pending) {
    throw new ProcessExecutionError('PROCESS_NOT_WAITING', 'Process is not waiting for an operation');
  }
  if (previous.pending.requestId !== event.requestId) {
    throw new ProcessExecutionError('PROCESS_RESPONSE_MISMATCH', 'Completion requestId does not match pending operation');
  }
  const step = definition.definition.steps[previous.pending.stepId];
  if (step?.type !== 'operation' || previous.currentStep !== previous.pending.stepId) {
    throw new ProcessExecutionError('PROCESS_POSITION_INVALID', 'Pending operation does not match current step');
  }
  const completion = normalizeCompletion(event.completion);
  const results = { ...previous.results, [previous.pending.stepId]: completion };
  const next = completion.status === 'SUCCESS' ? step.next : step.onError;
  const state: ProcessState = {
    ...previous,
    lifecycle: 'RUNNING',
    revision: previous.revision + 1,
    currentStep: next,
    results,
    pending: null,
    updatedAt: event.at,
  };
  return advanceOrFault(definition, state);
}

export function success(response: JsonValue): OperationCompletion {
  return normalizeCompletion({ status: 'SUCCESS', response, error: null });
}

export function failure(error: OperationError): OperationCompletion {
  return normalizeCompletion({ status: 'ERROR', response: null, error });
}
