// Public API surface of @processengine/conductor.
//
// This is an explicit, curated contract — deliberately NOT `export *`. Internal
// machinery (kernel state transitions, low-level JSON utilities, and the
// schema-compatibility implementation) is intentionally not re-exported here.
// Testing and conformance helpers live in the '@processengine/conductor/testing'
// subpath. Removing or renaming anything below is a breaking change; see
// docs/SEMVER_POLICY.md.

// Composition / runtime API for the host application.
export { Conductor, createConductor } from './conductor.js';

// Flow3 compiler and the artifact / operation registries.
export { compileFlow } from './compiler.js';
export { StaticArtifactRegistry, StaticOperationCatalog } from './registry.js';

// Completion constructors and the pure state-transition primitive. These have
// been public at the root since 0.1.0; they are kept public (rather than removed)
// to avoid a breaking change for existing consumers.
export { evolve, success, failure } from './kernel.js';

// Documented errors and the core operation-error catalogue.
export {
  ProcessEngineError,
  FlowDefinitionError,
  ProcessExecutionError,
  ConductorError,
  ProtocolError,
} from './errors.js';
export { CORE_OPERATION_ERRORS, CORE_OPERATION_ERROR_CODES } from './core-errors.js';

// Wire protocol for official connectors.
export {
  OPERATION_COMMAND,
  OPERATION_COMPLETION,
  operationCommandEnvelope,
  operationCompletionEnvelope,
  responseEnvelope,
  parseOperationCommand,
  assertOperationCommand,
  parseOperationCompletion,
  completionPayload,
} from './protocol.js';
export type { MessageEnvelope, OperationCommandPayload, OperationCompletionPayload } from './protocol.js';

// SPI interfaces required by third-party storage / transport implementations and
// by the host composition root.
export type {
  ArtifactRegistry,
  ProcessArtifactRegistry,
  OperationPolicy,
  OperationBinding,
  OperationCatalog,
  MessageHandler,
  MessageTransport,
  ProcessTransport,
  ProcessRecord,
  StoredOperationStatus,
  StoredOperation,
  OutboxStatus,
  OutboxRecord,
  DurableDispatch,
  CreateProcessResult,
  CommitOperationResult,
  ProcessStorage,
  ConductorStorage,
  Clock,
  ConductorOptions,
  StartProcessRequest,
  StartProcessResult,
} from './spi.js';

// Canonical process / completion / error / schema types.
export type {
  JsonPrimitive,
  JsonValue,
  JsonObject,
  StepId,
  OperationId,
  StepInput,
  OperationStep,
  SwitchStep,
  EndStep,
  ProcessStep,
  ProcessDefinition,
  CompiledProcessDefinition,
  OperationError,
  OperationCompletion,
  PendingOperation,
  ProcessFault,
  ProcessState,
  TransitionResult,
  JsonSchema,
  OperationContract,
  OperationContractRegistry,
  CompileFlowOptions,
} from './types.js';
