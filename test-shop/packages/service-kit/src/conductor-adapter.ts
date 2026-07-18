// This is the only service-side file coupled to ProcessEngine's operation
// protocol. Connector API changes should be absorbed here rather than leaking
// into domain handlers or the durable service ledger.
export {
  parseOperationCommand as assertOperationCommand,
  operationCompletionEnvelope,
  type MessageEnvelope,
  type OperationCommandPayload,
  type OperationError,
  type OperationCompletionPayload,
} from '@processengine/conductor';

export {
  createKafkaTransport,
  type KafkaTransport,
} from '@processengine/transport-kafka';
