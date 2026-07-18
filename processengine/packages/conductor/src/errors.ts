import type { JsonValue } from './types.js';

export class ProcessEngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: JsonValue = null,
  ) {
    super(message);
    this.name = 'ProcessEngineError';
  }
}

export class FlowDefinitionError extends ProcessEngineError {
  constructor(message: string, details: JsonValue = null) {
    super('FLOW_DEFINITION_INVALID', message, details);
    this.name = 'FlowDefinitionError';
  }
}

export class ProcessExecutionError extends ProcessEngineError {
  constructor(code: string, message: string, details: JsonValue = null) {
    super(code, message, details);
    this.name = 'ProcessExecutionError';
  }
}

export class ConductorError extends ProcessEngineError {
  constructor(code: string, message: string, details: JsonValue = null) {
    super(code, message, details);
    this.name = 'ConductorError';
  }
}

export class ProtocolError extends ProcessEngineError {
  constructor(message: string, details: JsonValue = null) {
    super('PROTOCOL_INVALID', message, details);
    this.name = 'ProtocolError';
  }
}
