export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

export type StepId = string;
export type OperationId = string;

export interface StepInput {
  readonly step: StepId;
  readonly resultType: 'response' | 'error';
}

export interface OperationStep {
  readonly type: 'operation';
  readonly operation: OperationId;
  readonly input?: StepInput;
  readonly next: StepId;
  readonly onError: StepId;
}

export interface SwitchStep {
  readonly type: 'switch';
  readonly input: StepInput;
  readonly key: string;
  readonly routes: Readonly<Record<string, StepId>>;
}

export interface EndStep {
  readonly type: 'end';
  readonly outcome: string;
  readonly input?: StepInput;
}

export type ProcessStep = OperationStep | SwitchStep | EndStep;

export interface ProcessDefinition {
  readonly id: string;
  readonly version: string;
  readonly start: StepId;
  readonly steps: Readonly<Record<StepId, ProcessStep>>;
}

export interface CompiledProcessDefinition {
  readonly definition: ProcessDefinition;
  readonly digest: string;
}

export interface OperationError {
  readonly code: string;
  readonly message: string;
  readonly details: JsonValue;
}

export type OperationCompletion =
  | {
      readonly status: 'SUCCESS';
      readonly response: JsonValue;
      readonly error: null;
    }
  | {
      readonly status: 'ERROR';
      readonly response: null;
      readonly error: OperationError;
    };

export interface PendingOperation {
  readonly executionId: string;
  readonly requestId: string;
  readonly stepId: StepId;
  readonly operation: OperationId;
}

export interface ProcessFault {
  readonly code: string;
  readonly message: string;
  readonly details: JsonValue;
}

export interface ProcessState {
  readonly instanceId: string;
  readonly flow: {
    readonly id: string;
    readonly version: string;
    readonly digest: string;
  };
  readonly lifecycle: 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAULTED';
  readonly revision: number;
  readonly currentStep: StepId;
  readonly input: JsonValue;
  readonly results: Readonly<Record<StepId, OperationCompletion>>;
  readonly pending: PendingOperation | null;
  readonly outcome: string | null;
  readonly response: JsonValue;
  readonly error: OperationError | null;
  readonly fault: ProcessFault | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProcessEvent =
  | {
      readonly type: 'START';
      readonly instanceId: string;
      readonly input: JsonValue;
      readonly at: string;
    }
  | {
      readonly type: 'OPERATION_COMPLETED';
      readonly requestId: string;
      readonly completion: OperationCompletion;
      readonly at: string;
    };

export type ConductorAction =
  | {
      readonly type: 'DISPATCH_OPERATION';
      readonly requestId: string;
      readonly instanceId: string;
      readonly stepId: StepId;
      readonly operation: OperationId;
      readonly input: JsonValue;
    }
  | {
      readonly type: 'PROCESS_COMPLETED';
      readonly instanceId: string;
      readonly outcome: string;
      readonly response: JsonValue;
      readonly error: OperationError | null;
    }
  | {
      readonly type: 'PROCESS_FAULTED';
      readonly instanceId: string;
      readonly fault: ProcessFault;
    };

export interface TransitionResult {
  readonly state: ProcessState;
  readonly action: ConductorAction;
}

export interface JsonSchema extends JsonObject {}

export interface OperationContract {
  readonly operation: OperationId;
  readonly inputSchema?: JsonSchema;
  readonly responseSchema?: JsonSchema;
  readonly errorSchema?: JsonSchema;
}

export interface OperationContractRegistry {
  getContract(operation: OperationId): OperationContract | undefined;
}

export interface CompileFlowOptions {
  readonly operations?: OperationContractRegistry;
  readonly processInputSchema?: JsonSchema;
}
