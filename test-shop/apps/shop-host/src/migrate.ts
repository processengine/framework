import { migrateConductorStorage } from '@test-shop/host-adapter';
import { loadConfig } from './config.js';

const config = loadConfig();
await migrateConductorStorage({ databaseUrl: config.databaseUrl, databaseSchema: config.databaseSchema });

