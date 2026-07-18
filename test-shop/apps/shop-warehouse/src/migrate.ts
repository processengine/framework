import { loadConfig } from './config.js';
import { createWarehouseService } from './runtime.js';

const service = createWarehouseService(loadConfig());
try { await service.migrate(); }
finally { await service.stop(); }

