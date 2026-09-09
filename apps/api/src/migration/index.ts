// MUN-0040: migration import surface public API.
export { MigrationModule } from './migration.module';
export { MigrationService } from './migration.service';
export {
  mapHistoricalStatus,
  NOT_REVALIDATED,
  UnknownStatusMapRevisionError,
} from './migration.status';
export type { HistoricalStatusMapping } from './migration.status';
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
} from './status-map/status-map';
export type { HistoricalStatusMapArtefact, StatusMapEntry } from './status-map/status-map';
export { MIGRATION_ERROR_CODES } from './migration.errors';
export type { MigrationErrorCode } from './migration.errors';
