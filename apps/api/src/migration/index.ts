// MUN-0040: migration import surface public API.
export { MigrationModule } from './migration.module.js';
export { MigrationService } from './migration.service.js';
export {
  mapHistoricalStatus,
  NOT_REVALIDATED,
  UnknownStatusMapRevisionError,
} from './migration.status.js';
export type { HistoricalStatusMapping } from './migration.status.js';
export {
  STATUS_MAP,
  STATUS_MAP_REVISION,
  STATUS_MAP_REVISIONS,
  STATUS_MAP_SCHEMA,
  SUPPORTED_STATUS_MAP_REVISIONS,
  StatusMapError,
  loadStatusMap,
  normalizeRawStatus,
  statusMapForRevision,
} from './status-map/status-map.js';
export type { HistoricalStatusMapArtefact, StatusMapEntry } from './status-map/status-map.js';
export { MIGRATION_ERROR_CODES } from './migration.errors.js';
export type { MigrationErrorCode } from './migration.errors.js';
