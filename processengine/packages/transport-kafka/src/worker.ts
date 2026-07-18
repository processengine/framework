import {
  completionPayload,
  operationCompletionEnvelope,
  parseOperationCommand,
  type JsonValue,
  type MessageTransport,
  type OperationCompletion,
  type OperationError,
} from '@processengine/conductor';

export interface OperationWorkerContext {
  readonly requestId: string;
  readonly instanceId: string;
  readonly stepId: string;
  readonly operation: string;
}

/**
 * Commands are delivered at least once. Implementations must use the stable
 * context.requestId as an idempotency key before performing a domain side effect.
 */
export type OperationHandler = (
  input: JsonValue,
  context: OperationWorkerContext,
) => Promise<OperationCompletion> | OperationCompletion;

export interface KafkaOperationWorkerOptions {
  readonly source: string;
  readonly destination: string;
  readonly consumerGroup: string;
  readonly transport: MessageTransport;
  readonly handlers: Readonly<Record<string, OperationHandler>>;
  readonly now?: () => Date;
  readonly onError?: (error: unknown, context?: OperationWorkerContext) => void | Promise<void>;
}

/**
 * Kafka adapter for domain operations. It preserves requestId and may publish a
 * completion more than once after redelivery; it does not provide exactly-once
 * domain side effects.
 */
export class KafkaOperationWorker {
  private unsubscribe: (() => Promise<void>) | undefined;

  constructor(private readonly options: KafkaOperationWorkerOptions) {
    if (!options.source || !options.destination || !options.consumerGroup) {
      throw new TypeError('Operation worker source, destination and consumerGroup are required');
    }
  }

  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.unsubscribe = await this.options.transport.subscribe({
      destination: this.options.destination,
      consumerGroup: this.options.consumerGroup,
      handler: async (message) => {
        const command = parseOperationCommand(message);
        const context: OperationWorkerContext = {
          requestId: command.requestId,
          instanceId: command.instanceId,
          stepId: command.stepId,
          operation: command.operation,
        };
        const handler = this.options.handlers[command.operation];
        if (!handler) throw new Error(`Operation ${command.operation} is not registered by ${this.options.source}`);
        try {
          const completion = validateCompletion(await handler(command.input, context));
          await this.options.transport.publish(operationCompletionEnvelope({
            source: this.options.source,
            destination: command.replyTo,
            instanceId: command.instanceId,
            occurredAt: (this.options.now ?? (() => new Date()))().toISOString(),
            completion: completionPayload(command.requestId, completion),
          }));
        } catch (error) {
          await this.options.onError?.(error, context);
          throw error;
        }
      },
    });
  }

  async stop(): Promise<void> {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    await unsubscribe?.();
  }
}

export function createKafkaOperationWorker(options: KafkaOperationWorkerOptions): KafkaOperationWorker {
  return new KafkaOperationWorker(options);
}

export function operationSuccess(response: JsonValue): OperationCompletion {
  return { status: 'SUCCESS', response, error: null };
}

export function operationError(error: OperationError): OperationCompletion {
  return { status: 'ERROR', response: null, error };
}

function validateCompletion(completion: OperationCompletion): OperationCompletion {
  if (completion.status === 'SUCCESS' && completion.error === null && Object.hasOwn(completion, 'response')) return completion;
  if (completion.status === 'ERROR' && completion.response === null
    && typeof completion.error?.code === 'string' && completion.error.code.length > 0
    && typeof completion.error.message === 'string' && Object.hasOwn(completion.error, 'details')) return completion;
  throw new TypeError('Operation handler returned an invalid completion');
}
