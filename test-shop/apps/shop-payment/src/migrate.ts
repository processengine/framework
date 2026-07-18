import { loadConfig } from './config.js';
import { createPaymentService } from './runtime.js';

const service = createPaymentService(loadConfig());
try { await service.migrate(); }
finally { await service.stop(); }

