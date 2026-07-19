// Public API surface of @processengine/storage-postgres. Explicit named exports —
// deliberately not `export *`. See processengine/api-reports/*.api.md.

export {
  assertPostgresSchemaName,
  postgresMigrations,
  inspectPostgresMigrations,
  runPostgresMigrations,
} from './migrations.js';
export type {
  PostgresMigration,
  PostgresMigrationStatus,
  PostgresMigrationOptions,
  PostgresConnectionProvider,
} from './migrations.js';

export {
  PostgresStorage,
  createPostgresStorage,
  latestPostgresStorageMigration,
} from './storage.js';
export type {
  PostgresStorageOptions,
  PostgresStorageHealth,
} from './storage.js';
