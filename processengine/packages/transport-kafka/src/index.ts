// Public API surface of @processengine/transport-kafka. Explicit named exports —
// deliberately not `export *`. See processengine/api-reports/*.api.md.

export {
  KafkaTransport,
  InvalidKafkaMessageError,
  KafkaPublishTimeoutError,
  KafkaPublishIdentityConflictError,
  KafkaTransportStoppedError,
  createKafkaTransport,
  kafkaConfigFromEnv,
} from './kafka-transport.js';
export type {
  InvalidMessageStrategy,
  InvalidKafkaMessage,
  KafkaTransportOptions,
  KafkaTopicDefinition,
  KafkaPublishDeliveryStatus,
} from './kafka-transport.js';

export {
  KafkaOperationWorker,
  createKafkaOperationWorker,
  operationSuccess,
  operationError,
} from './worker.js';
export type {
  OperationWorkerContext,
  OperationHandler,
  KafkaOperationWorkerOptions,
} from './worker.js';
