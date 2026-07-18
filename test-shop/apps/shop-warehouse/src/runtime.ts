import { createOperationService } from '@test-shop/service-kit';
import type { WarehouseConfig } from './config.js';
import { migrateWarehouse, warehouseHandlers } from './warehouse.js';

export function createWarehouseService(config: WarehouseConfig) {
  return createOperationService({
    serviceName: 'shop-warehouse',
    source: 'test-shop.shop-warehouse',
    databaseUrl: config.databaseUrl,
    databaseSchema: 'warehouse_service',
    kafka: {
      brokers: config.brokers,
      clientId: config.clientId,
      commandTopic: config.commandTopic,
      consumerGroup: config.consumerGroup,
    },
    handlers: warehouseHandlers(config.demoFaults),
    migrateDomain: migrateWarehouse,
    outboxPollMs: config.outboxPollMs,
  });
}

