import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { TASK_STATUSES, type TaskStatus } from '@muneral/types';

export const TASK_ACTIVITY_SNAPSHOT_SCHEMA = 'TaskActivitySnapshotCanonical/v1' as const;
export const TASK_ACTIVITY_SNAPSHOT_DOMAIN = 'Muneral.TaskActivitySnapshotCanonical/v1';
export const TASK_ACTIVITY_SNAPSHOT_MAX_ROWS = 10_000;
export const TASK_ACTIVITY_SNAPSHOT_MAX_CANONICAL_BYTES = 16 * 1024 * 1024;
export const TASK_ACTIVITY_SNAPSHOT_MAX_ACTIVITY_BYTES = 64 * 1024;
export const TASK_ACTIVITY_SNAPSHOT_MAX_PAGE_BYTES = 1024 * 1024;
export const TASK_ACTIVITY_SNAPSHOT_MAX_PAGE_SET_BYTES = 64 * 1024 * 1024;
export const TASK_ACTIVITY_SNAPSHOT_MAX_PAYLOAD_DEPTH = 64;
export const TASK_ACTIVITY_SNAPSHOT_MAX_PAYLOAD_NODES = 16_384;
export const TASK_ACTIVITY_SNAPSHOT_MAX_PAGE_SIZE = 500;

export type SnapshotCodecErrorCode =
  | 'SNAPSHOT_CONTENT_UNSUPPORTED'
  | 'SNAPSHOT_LIMIT_EXCEEDED'
  | 'SNAPSHOT_INVALID_INPUT'
  | 'SNAPSHOT_INVALID_PAGE';

export class TaskActivitySnapshotCodecError extends Error {
  constructor(
    public readonly code: SnapshotCodecErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'TaskActivitySnapshotCodecError';
  }
}

/**
 * Adapter-neutral lossless representation. A database adapter must construct
 * this tree without first converting numeric tokens to JavaScript numbers.
 * It is not a reader, persistence API, or claim that the source was bounded.
 */
export type LosslessActivityJson =
  | { readonly type: 'null' }
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'number'; readonly token: string }
  | { readonly type: 'array'; readonly items: readonly LosslessActivityJson[] }
  | {
      readonly type: 'object';
      readonly entries: readonly { readonly key: string; readonly value: LosslessActivityJson }[];
    };

export interface SnapshotActivityInput {
  readonly id: string;
  readonly task_id: string | null;
  readonly workspace_id: string;
  readonly actor_type: 'human' | 'agent';
  readonly actor_id: string;
  readonly action: string;
  readonly payload: LosslessActivityJson | null;
  readonly created_at: string;
}

export interface SnapshotTaskInput {
  readonly id: string;
  readonly project_id: string;
  readonly status: TaskStatus;
  readonly revision: number;
  readonly updated_at: string;
}

export interface TaskActivitySnapshotInput {
  readonly snapshot_id: string;
  readonly task_id: string;
  readonly workspace_id: string;
  readonly owner: { readonly actor_type: 'human' | 'agent'; readonly actor_id: string };
  readonly captured_at: string;
  readonly page_size: number;
  readonly task_at_snapshot: SnapshotTaskInput;
  /** Rows must already be in created_at DESC, id DESC order from the source cut. */
  readonly activities: readonly SnapshotActivityInput[];
}

export type TaggedPayload =
  | readonly ['null']
  | readonly ['boolean', boolean]
  | readonly ['string', string]
  | readonly ['number', string]
  | readonly ['array', readonly TaggedPayload[]]
  | readonly ['object', readonly (readonly [string, TaggedPayload])[]];

export interface SnapshotActivity {
  readonly id: string;
  readonly task_id: string | null;
  readonly workspace_id: string;
  readonly actor_type: 'human' | 'agent';
  readonly actor_id: string;
  readonly action: string;
  readonly payload: TaggedPayload;
  readonly created_at: string;
}

export interface SnapshotRow {
  readonly position: number;
  readonly activity: SnapshotActivity;
}

export interface TaskActivitySnapshotCanonical {
  readonly schema: typeof TASK_ACTIVITY_SNAPSHOT_SCHEMA;
  readonly snapshot_id: string;
  readonly task_id: string;
  readonly workspace_id: string;
  readonly owner: { readonly actor_type: 'human' | 'agent'; readonly actor_id: string };
  readonly captured_at: string;
  readonly expires_at: string;
  readonly consistency: 'materialized_repeatable_read';
  readonly order: readonly ['created_at:desc', 'id:desc'];
  readonly page_size: number;
  readonly total: number;
  readonly task_at_snapshot: SnapshotTaskInput;
  readonly rows: readonly SnapshotRow[];
}

export interface BuiltTaskActivitySnapshot {
  readonly document: TaskActivitySnapshotCanonical;
  /** Exact UTF-8 JCS text (no BOM or trailing newline). */
  readonly canonical_bytes: string;
  readonly snapshot_digest: string;
}

export interface TaskActivitySnapshotPage extends Omit<TaskActivitySnapshotCanonical, 'rows'> {
  readonly page: number;
  readonly total_pages: number;
  readonly has_more: boolean;
  readonly snapshot_digest: string;
  readonly rows: readonly SnapshotRow[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
const JSON_NUMBER_RE = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;

export function normalizeExactDecimalToken(token: string): string {
  if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > TASK_ACTIVITY_SNAPSHOT_MAX_ACTIVITY_BYTES) {
    unsupported('numeric token is not a bounded string');
  }
  const match = JSON_NUMBER_RE.exec(token);
  if (!match) unsupported('numeric token is not valid finite JSON number syntax');

  const [, sign, integer, fraction = '', exponentText = '0'] = match;
  const digits = `${integer}${fraction}`.replace(/^0+/, '');
  if (digits.length === 0) return '0e0';

  const withoutTrailingZeros = digits.replace(/0+$/, '');
  const removedZeros = digits.length - withoutTrailingZeros.length;
  let exponent: bigint;
  try {
    exponent = BigInt(exponentText) - BigInt(fraction.length) + BigInt(removedZeros);
  } catch {
    unsupported('numeric exponent cannot be represented as an exact integer');
  }
  const coefficient = `${sign}${withoutTrailingZeros}`;
  return `${coefficient}e${exponent.toString()}`;
}

export function tagLosslessActivityPayload(input: LosslessActivityJson | null): TaggedPayload {
  const budget = { nodes: 0, sourceTextBytes: 0 };
  const tagged = tagValue(input, 0, budget, '$payload');
  const bytes = Buffer.byteLength(canonicalize(tagged), 'utf8');
  if (bytes > TASK_ACTIVITY_SNAPSHOT_MAX_ACTIVITY_BYTES) {
    tooLarge('tagged payload exceeds the codec byte budget');
  }
  return deepFreeze(tagged);
}

export function buildTaskActivitySnapshot(input: TaskActivitySnapshotInput): BuiltTaskActivitySnapshot {
  const source = exactRecord(input, [
    'snapshot_id', 'task_id', 'workspace_id', 'owner', 'captured_at', 'page_size',
    'task_at_snapshot', 'activities',
  ], 'snapshot input');
  const snapshotId = uuid(source.snapshot_id, 'snapshot_id');
  const taskId = uuid(source.task_id, 'task_id');
  const workspaceId = uuid(source.workspace_id, 'workspace_id');
  const ownerSource = exactRecord(source.owner, ['actor_type', 'actor_id'], 'owner');
  const owner = Object.freeze({
    actor_type: actorType(ownerSource.actor_type, 'owner.actor_type'),
    actor_id: uuid(ownerSource.actor_id, 'owner.actor_id'),
  });
  const capturedAt = timestamp(source.captured_at, 'captured_at');
  const expiresAt = addSeconds(capturedAt, 900);
  const pageSize = integer(source.page_size, 1, TASK_ACTIVITY_SNAPSHOT_MAX_PAGE_SIZE, 'page_size');
  const task = snapshotTask(source.task_at_snapshot);
  if (task.id !== taskId) invalid('task_at_snapshot.id must equal task_id');

  const activities = exactArray(
    source.activities, 'activities', 'SNAPSHOT_INVALID_INPUT', TASK_ACTIVITY_SNAPSHOT_MAX_ROWS, 'SNAPSHOT_LIMIT_EXCEEDED',
  );
  if (activities.length > TASK_ACTIVITY_SNAPSHOT_MAX_ROWS) tooLarge('snapshot exceeds the row limit');
  const rows: SnapshotRow[] = [];
  const ids = new Set<string>();
  let previous: SnapshotActivity | undefined;
  let rowArrayBytes = 2;
  for (let index = 0; index < activities.length; index++) {
    const activity = snapshotActivity(activities[index]);
    if (activity.task_id !== taskId || activity.workspace_id !== workspaceId) {
      unsupported(`activity ${index + 1} does not match the snapshot task/workspace`);
    }
    if (ids.has(activity.id)) unsupported(`duplicate activity id at row ${index + 1}`);
    if (previous && compareActivityOrder(previous, activity) > 0) {
      unsupported(`activities are not ordered by created_at DESC, id DESC at row ${index + 1}`);
    }
    ids.add(activity.id);
    const row = Object.freeze({ position: index + 1, activity });
    const rowBytes = Buffer.byteLength(canonicalize(row), 'utf8');
    if (rowBytes > TASK_ACTIVITY_SNAPSHOT_MAX_ACTIVITY_BYTES) {
      tooLarge(`encoded activity row ${index + 1} exceeds the row byte limit`);
    }
    rowArrayBytes += rowBytes + (rows.length > 0 ? 1 : 0);
    if (rowArrayBytes > TASK_ACTIVITY_SNAPSHOT_MAX_CANONICAL_BYTES) {
      tooLarge('canonical rows exceed the snapshot byte limit');
    }
    rows.push(row);
    previous = activity;
  }

  const document: TaskActivitySnapshotCanonical = deepFreeze({
    schema: TASK_ACTIVITY_SNAPSHOT_SCHEMA,
    snapshot_id: snapshotId,
    task_id: taskId,
    workspace_id: workspaceId,
    owner,
    captured_at: capturedAt,
    expires_at: expiresAt,
    consistency: 'materialized_repeatable_read',
    order: ['created_at:desc', 'id:desc'] as const,
    page_size: pageSize,
    total: rows.length,
    task_at_snapshot: task,
    rows,
  });
  const metadataBytes = Buffer.byteLength(canonicalize({ ...document, rows: [] }), 'utf8') - 2;
  if (metadataBytes + rowArrayBytes > TASK_ACTIVITY_SNAPSHOT_MAX_CANONICAL_BYTES) {
    tooLarge('canonical document exceeds the snapshot byte limit');
  }
  const canonicalBytes = canonicalize(document);
  if (Buffer.byteLength(canonicalBytes, 'utf8') > TASK_ACTIVITY_SNAPSHOT_MAX_CANONICAL_BYTES) {
    tooLarge('canonical document exceeds the snapshot byte limit');
  }
  return Object.freeze({
    document,
    canonical_bytes: canonicalBytes,
    snapshot_digest: digest(canonicalBytes),
  });
}

export function createTaskActivitySnapshotPages(snapshot: BuiltTaskActivitySnapshot): readonly TaskActivitySnapshotPage[] {
  const { document, snapshot_digest: snapshotDigest } = snapshot;
  const totalPages = Math.max(1, Math.ceil(document.total / document.page_size));
  const pages: TaskActivitySnapshotPage[] = [];
  let pageSetBytes = 0;
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
    const start = (pageNumber - 1) * document.page_size;
    const rows = document.rows.slice(start, start + document.page_size);
    const page = deepFreeze({
      schema: document.schema,
      snapshot_id: document.snapshot_id,
      task_id: document.task_id,
      workspace_id: document.workspace_id,
      owner: document.owner,
      captured_at: document.captured_at,
      expires_at: document.expires_at,
      consistency: document.consistency,
      order: document.order,
      page_size: document.page_size,
      total: document.total,
      task_at_snapshot: document.task_at_snapshot,
      page: pageNumber,
      total_pages: totalPages,
      has_more: pageNumber < totalPages,
      snapshot_digest: snapshotDigest,
      rows,
    });
    const metadataBytes = Buffer.byteLength(canonicalize({ ...page, rows: [] }), 'utf8') - 2;
    const rowBytes = encodedArrayBytes(rows, TASK_ACTIVITY_SNAPSHOT_MAX_PAGE_BYTES - metadataBytes);
    if (metadataBytes + rowBytes > TASK_ACTIVITY_SNAPSHOT_MAX_PAGE_BYTES) {
      tooLarge(`encoded page ${pageNumber} exceeds the page byte limit`);
    }
    const pageBytes = metadataBytes + rowBytes;
    if (pageBytes > TASK_ACTIVITY_SNAPSHOT_MAX_PAGE_BYTES) {
      tooLarge(`encoded page ${pageNumber} exceeds the page byte limit`);
    }
    pageSetBytes = addPageSetBytes(pageSetBytes, pageBytes);
    pages.push(page);
  }
  return deepFreeze(pages);
}

/** Validate a full ordered page collection and independently reconstruct D. */
export function validateAndReconstructTaskActivitySnapshot(pagesInput: unknown): BuiltTaskActivitySnapshot {
  const pageValues = exactArray(pagesInput, 'pages', 'SNAPSHOT_INVALID_PAGE', TASK_ACTIVITY_SNAPSHOT_MAX_ROWS);
  if (pageValues.length < 1 || pageValues.length > TASK_ACTIVITY_SNAPSHOT_MAX_ROWS) {
    invalidPage('pages must contain between one and 10,000 entries');
  }
  const firstHeader = pageCollectionHeader(pageValues[0]);
  const expectedPages = Math.max(1, Math.ceil(firstHeader.total / firstHeader.pageSize));
  if (pageValues.length !== expectedPages || firstHeader.totalPages !== expectedPages) {
    invalidPage('page count does not match total and page_size');
  }

  const pages: TaskActivitySnapshotPage[] = [];
  let pageSetBytes = 0;
  for (let index = 0; index < pageValues.length; index++) {
    const page = validatePage(pageValues[index], index + 1, (bytes) => {
      pageSetBytes = addPageSetBytes(pageSetBytes, bytes);
    });
    pages.push(page);
  }
  const first = pages[0];
  if (pages.length !== expectedPages || pages.length !== first.total_pages) {
    invalidPage('page count does not match total and page_size');
  }

  const rows: SnapshotRow[] = [];
  const ids = new Set<string>();
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    if (page.page !== pageIndex + 1 || page.total_pages !== expectedPages) {
      invalidPage('pages must be complete and in ordinal order');
    }
    if (page.has_more !== (page.page < expectedPages)) invalidPage('has_more does not match page position');
    if (page.snapshot_digest !== first.snapshot_digest) invalidPage('snapshot digest differs between pages');
    if (metadataBytes(page) !== metadataBytes(first)) invalidPage('invariant snapshot metadata differs between pages');

    const startPosition = pageIndex * first.page_size + 1;
    const expectedRowCount = first.total === 0
      ? 0
      : Math.min(first.page_size, first.total - pageIndex * first.page_size);
    if (page.rows.length !== expectedRowCount) invalidPage(`page ${page.page} has an incomplete row interval`);
    for (let rowIndex = 0; rowIndex < page.rows.length; rowIndex++) {
      const row = page.rows[rowIndex];
      if (row.position !== startPosition + rowIndex) invalidPage(`page ${page.page} has a non-contiguous position`);
      if (ids.has(row.activity.id)) invalidPage('activity ids must be unique across pages');
      ids.add(row.activity.id);
      rows.push(row);
    }
  }

  const input: TaskActivitySnapshotInput = {
    snapshot_id: first.snapshot_id,
    task_id: first.task_id,
    workspace_id: first.workspace_id,
    owner: first.owner,
    captured_at: first.captured_at,
    page_size: first.page_size,
    task_at_snapshot: first.task_at_snapshot,
    activities: rows.map(({ activity }) => ({
      ...activity,
      payload: untagPayload(activity.payload),
    })),
  };
  const rebuilt = buildTaskActivitySnapshot(input);
  if (rebuilt.snapshot_digest !== first.snapshot_digest) invalidPage('reconstructed canonical digest does not match');
  return rebuilt;
}

function pageCollectionHeader(value: unknown): { total: number; pageSize: number; totalPages: number } {
  const page = exactRecord(value, [
    'schema', 'snapshot_id', 'task_id', 'workspace_id', 'owner', 'captured_at', 'expires_at',
    'consistency', 'order', 'page_size', 'total', 'task_at_snapshot', 'page', 'total_pages',
    'has_more', 'snapshot_digest', 'rows',
  ], 'page 1', 'SNAPSHOT_INVALID_PAGE');
  const pageSize = integer(page.page_size, 1, TASK_ACTIVITY_SNAPSHOT_MAX_PAGE_SIZE, 'page_size');
  const total = integer(page.total, 0, TASK_ACTIVITY_SNAPSHOT_MAX_ROWS, 'total');
  const totalPages = integer(page.total_pages, 1, TASK_ACTIVITY_SNAPSHOT_MAX_ROWS, 'total_pages');
  return { total, pageSize, totalPages };
}

function validatePage(
  value: unknown,
  expectedPage: number,
  chargePageSet: (bytes: number) => void,
): TaskActivitySnapshotPage {
  const page = exactRecord(value, [
    'schema', 'snapshot_id', 'task_id', 'workspace_id', 'owner', 'captured_at', 'expires_at',
    'consistency', 'order', 'page_size', 'total', 'task_at_snapshot', 'page', 'total_pages',
    'has_more', 'snapshot_digest', 'rows',
  ], `page ${expectedPage}`, 'SNAPSHOT_INVALID_PAGE');
  if (page.schema !== TASK_ACTIVITY_SNAPSHOT_SCHEMA || page.consistency !== 'materialized_repeatable_read') {
    invalidPage(`page ${expectedPage} has an unknown schema or consistency value`);
  }
  const snapshotId = uuid(page.snapshot_id, 'snapshot_id');
  const taskId = uuid(page.task_id, 'task_id');
  const workspaceId = uuid(page.workspace_id, 'workspace_id');
  const ownerSource = exactRecord(page.owner, ['actor_type', 'actor_id'], 'owner', 'SNAPSHOT_INVALID_PAGE');
  const owner = Object.freeze({
    actor_type: actorType(ownerSource.actor_type, 'owner.actor_type'),
    actor_id: uuid(ownerSource.actor_id, 'owner.actor_id'),
  });
  const capturedAt = timestamp(page.captured_at, 'captured_at');
  const expiresAt = timestamp(page.expires_at, 'expires_at');
  if (expiresAt !== addSeconds(capturedAt, 900)) invalidPage('expires_at is not captured_at plus 900 seconds');
  const order = exactArray(page.order, 'order', 'SNAPSHOT_INVALID_PAGE', 2);
  if (order.length !== 2 || order[0] !== 'created_at:desc' || order[1] !== 'id:desc') {
    invalidPage('order must be created_at DESC then id DESC');
  }
  const pageSize = integer(page.page_size, 1, TASK_ACTIVITY_SNAPSHOT_MAX_PAGE_SIZE, 'page_size');
  const total = integer(page.total, 0, TASK_ACTIVITY_SNAPSHOT_MAX_ROWS, 'total');
  const pageNumber = integer(page.page, 1, TASK_ACTIVITY_SNAPSHOT_MAX_ROWS, 'page');
  const totalPages = integer(page.total_pages, 1, TASK_ACTIVITY_SNAPSHOT_MAX_ROWS, 'total_pages');
  const hasMore = boolean(page.has_more, 'has_more');
  const snapshotDigest = digestString(page.snapshot_digest);
  const task = snapshotTask(page.task_at_snapshot);
  if (task.id !== taskId) invalidPage('task_at_snapshot.id must equal task_id');
  const rowValues = exactArray(page.rows, 'rows', 'SNAPSHOT_INVALID_PAGE', pageSize);
  const rows: SnapshotRow[] = [];
  let rowArrayBytes = 2;
  for (let index = 0; index < rowValues.length; index++) {
    const row = snapshotRow(rowValues[index], index);
    const rowBytes = Buffer.byteLength(canonicalize(row), 'utf8');
    if (rowBytes > TASK_ACTIVITY_SNAPSHOT_MAX_ACTIVITY_BYTES) {
      tooLarge(`page ${expectedPage} contains an oversized activity row`);
    }
    rowArrayBytes += rowBytes + (rows.length > 0 ? 1 : 0);
    if (rowArrayBytes > TASK_ACTIVITY_SNAPSHOT_MAX_PAGE_BYTES) {
      tooLarge(`page ${expectedPage} rows exceed the page byte limit`);
    }
    chargePageSet(rowBytes + (rows.length > 0 ? 1 : 0));
    rows.push(row);
  }
  const normalized: TaskActivitySnapshotPage = {
    schema: TASK_ACTIVITY_SNAPSHOT_SCHEMA,
    snapshot_id: snapshotId,
    task_id: taskId,
    workspace_id: workspaceId,
    owner,
    captured_at: capturedAt,
    expires_at: expiresAt,
    consistency: 'materialized_repeatable_read',
    order: ['created_at:desc', 'id:desc'],
    page_size: pageSize,
    total,
    task_at_snapshot: task,
    page: pageNumber,
    total_pages: totalPages,
    has_more: hasMore,
    snapshot_digest: snapshotDigest,
    rows,
  };
  for (const row of rows) {
    if (Buffer.byteLength(canonicalize(row), 'utf8') > TASK_ACTIVITY_SNAPSHOT_MAX_ACTIVITY_BYTES) {
      tooLarge(`page ${expectedPage} contains an oversized activity row`);
    }
  }
  const metadataBytes = Buffer.byteLength(canonicalize({ ...normalized, rows: [] }), 'utf8') - 2;
  const rowBytes = encodedArrayBytes(rows, TASK_ACTIVITY_SNAPSHOT_MAX_PAGE_BYTES - metadataBytes);
  const pageBytes = metadataBytes + rowBytes;
  if (pageBytes > TASK_ACTIVITY_SNAPSHOT_MAX_PAGE_BYTES) {
    tooLarge(`page ${expectedPage} exceeds the page byte limit`);
  }
  chargePageSet(metadataBytes + 2);
  return deepFreeze(normalized);
}

function snapshotActivity(value: unknown): SnapshotActivity {
  const source = exactRecord(value, [
    'id', 'task_id', 'workspace_id', 'actor_type', 'actor_id', 'action', 'payload', 'created_at',
  ], 'activity');
  const payload = source.payload === null ? null : source.payload as LosslessActivityJson;
  return Object.freeze({
    id: uuid(source.id, 'activity.id'),
    task_id: source.task_id === null ? null : uuid(source.task_id, 'activity.task_id'),
    workspace_id: uuid(source.workspace_id, 'activity.workspace_id'),
    actor_type: actorType(source.actor_type, 'activity.actor_type'),
    actor_id: uuid(source.actor_id, 'activity.actor_id'),
    action: boundedActivityText(source.action, 'activity.action'),
    payload: tagLosslessActivityPayload(payload),
    created_at: timestamp(source.created_at, 'activity.created_at'),
  });
}

function snapshotTask(value: unknown): SnapshotTaskInput {
  const source = exactRecord(value, ['id', 'project_id', 'status', 'revision', 'updated_at'], 'task_at_snapshot');
  if (typeof source.status !== 'string' || !TASK_STATUSES.includes(source.status as TaskStatus)) {
    unsupported('task_at_snapshot.status is not a known task status');
  }
  return Object.freeze({
    id: uuid(source.id, 'task_at_snapshot.id'),
    project_id: uuid(source.project_id, 'task_at_snapshot.project_id'),
    status: source.status as TaskStatus,
    revision: integer(source.revision, -2_147_483_648, 2_147_483_647, 'task_at_snapshot.revision'),
    updated_at: timestamp(source.updated_at, 'task_at_snapshot.updated_at'),
  });
}

function snapshotRow(value: unknown, index: number): SnapshotRow {
  const row = exactRecord(value, ['position', 'activity'], `row ${index + 1}`, 'SNAPSHOT_INVALID_PAGE');
  const activity = snapshotActivityFromTagged(row.activity);
  return deepFreeze({
    position: integer(row.position, 1, TASK_ACTIVITY_SNAPSHOT_MAX_ROWS, `row ${index + 1}.position`),
    activity,
  });
}

function snapshotActivityFromTagged(value: unknown): SnapshotActivity {
  const source = exactRecord(value, [
    'id', 'task_id', 'workspace_id', 'actor_type', 'actor_id', 'action', 'payload', 'created_at',
  ], 'activity', 'SNAPSHOT_INVALID_PAGE');
  return Object.freeze({
    id: uuid(source.id, 'activity.id'),
    task_id: source.task_id === null ? null : uuid(source.task_id, 'activity.task_id'),
    workspace_id: uuid(source.workspace_id, 'activity.workspace_id'),
    actor_type: actorType(source.actor_type, 'activity.actor_type'),
    actor_id: uuid(source.actor_id, 'activity.actor_id'),
    action: boundedActivityText(source.action, 'activity.action'),
    payload: validateTaggedPayload(source.payload, 0, { nodes: 0, sourceTextBytes: 0 }),
    created_at: timestamp(source.created_at, 'activity.created_at'),
  });
}

function validateTaggedPayload(value: unknown, depth: number, budget: { nodes: number; sourceTextBytes: number }): TaggedPayload {
  const tuple = exactArray(value, 'tagged payload', 'SNAPSHOT_INVALID_PAGE', 2);
  if (typeof tuple[0] !== 'string') invalidPage('activity payload is not a tagged value');
  budget.nodes++;
  if (budget.nodes > TASK_ACTIVITY_SNAPSHOT_MAX_PAYLOAD_NODES) tooLarge('payload exceeds the node limit');
  if (depth > TASK_ACTIVITY_SNAPSHOT_MAX_PAYLOAD_DEPTH) tooLarge('payload exceeds the depth limit');
  switch (tuple[0]) {
    case 'null':
      if (tuple.length !== 1) invalidPage('null tag has extra values');
      return Object.freeze(['null'] as const);
    case 'boolean':
      if (tuple.length !== 2 || typeof tuple[1] !== 'boolean') invalidPage('boolean tag is malformed');
      return Object.freeze(['boolean', tuple[1]] as const);
    case 'string':
      if (tuple.length !== 2) invalidPage('string tag is malformed');
      return Object.freeze(['string', payloadString(tuple[1], 'payload string', budget)] as const);
    case 'number':
      if (tuple.length !== 2 || typeof tuple[1] !== 'string' || normalizeExactDecimalToken(tuple[1]) !== tuple[1]) {
        invalidPage('number tag is not in normalized decimal form');
      }
      chargePayloadText(tuple[1], budget, 'payload number');
      return Object.freeze(['number', tuple[1]] as const);
    case 'array': {
      if (tuple.length !== 2) invalidPage('array tag is malformed');
      const items = exactArray(
        tuple[1], 'array tag items', 'SNAPSHOT_INVALID_PAGE', TASK_ACTIVITY_SNAPSHOT_MAX_PAYLOAD_NODES, 'SNAPSHOT_LIMIT_EXCEEDED',
      );
      return Object.freeze(['array', Object.freeze(items.map((entry) => validateTaggedPayload(entry, depth + 1, budget)))] as const);
    }
    case 'object': {
      if (tuple.length !== 2) invalidPage('object tag is malformed');
      const objectEntries = exactArray(
        tuple[1], 'object tag entries', 'SNAPSHOT_INVALID_PAGE', TASK_ACTIVITY_SNAPSHOT_MAX_PAYLOAD_NODES, 'SNAPSHOT_LIMIT_EXCEEDED',
      );
      const entries: (readonly [string, TaggedPayload])[] = [];
      let previousKey: string | undefined;
      for (const entry of objectEntries) {
        const pair = exactArray(entry, 'object tag pair', 'SNAPSHOT_INVALID_PAGE', 2);
        if (pair.length !== 2) invalidPage('object tag entry is malformed');
        const key = payloadString(pair[0], 'payload object key', budget);
        if (previousKey !== undefined && compareUtf16(previousKey, key) >= 0) {
          invalidPage('object keys must be unique and in UTF-16 order');
        }
        entries.push(Object.freeze([key, validateTaggedPayload(pair[1], depth + 1, budget)]));
        previousKey = key;
      }
      return Object.freeze(['object', Object.freeze(entries)] as const);
    }
    default:
      invalidPage('activity payload has an unknown tag');
  }
}

function tagValue(
  value: unknown,
  depth: number,
  budget: { nodes: number; sourceTextBytes: number },
  path: string,
): TaggedPayload {
  budget.nodes++;
  if (budget.nodes > TASK_ACTIVITY_SNAPSHOT_MAX_PAYLOAD_NODES) tooLarge(`${path} exceeds the payload node limit`);
  if (depth > TASK_ACTIVITY_SNAPSHOT_MAX_PAYLOAD_DEPTH) tooLarge(`${path} exceeds the payload depth limit`);
  if (value === null) return Object.freeze(['null'] as const);

  const source = plainRecord(value, path, 'SNAPSHOT_CONTENT_UNSUPPORTED');
  switch (source.type) {
    case 'null': {
      exactRecord(value, ['type'], path, 'SNAPSHOT_CONTENT_UNSUPPORTED');
      return Object.freeze(['null'] as const);
    }
    case 'boolean': {
      const node = exactRecord(value, ['type', 'value'], path, 'SNAPSHOT_CONTENT_UNSUPPORTED');
      if (typeof node.value !== 'boolean') unsupported(`${path}.value must be boolean`);
      return Object.freeze(['boolean', node.value] as const);
    }
    case 'string': {
      const node = exactRecord(value, ['type', 'value'], path, 'SNAPSHOT_CONTENT_UNSUPPORTED');
      return Object.freeze(['string', payloadString(node.value, path, budget)] as const);
    }
    case 'number': {
      const node = exactRecord(value, ['type', 'token'], path, 'SNAPSHOT_CONTENT_UNSUPPORTED');
      if (typeof node.token !== 'string') unsupported(`${path}.token must be exact source text`);
      chargePayloadText(node.token, budget, path);
      return Object.freeze(['number', normalizeExactDecimalToken(node.token)] as const);
    }
    case 'array': {
      const node = exactRecord(value, ['type', 'items'], path, 'SNAPSHOT_CONTENT_UNSUPPORTED');
      const items = exactArray(
        node.items, `${path}.items`, 'SNAPSHOT_CONTENT_UNSUPPORTED', TASK_ACTIVITY_SNAPSHOT_MAX_PAYLOAD_NODES, 'SNAPSHOT_LIMIT_EXCEEDED',
      );
      if (items.length > TASK_ACTIVITY_SNAPSHOT_MAX_PAYLOAD_NODES) tooLarge(`${path} array is too large`);
      return Object.freeze(['array', Object.freeze(items.map((item, index) =>
        tagValue(item, depth + 1, budget, `${path}[${index}]`)))] as const);
    }
    case 'object': {
      const node = exactRecord(value, ['type', 'entries'], path, 'SNAPSHOT_CONTENT_UNSUPPORTED');
      const inputEntries = exactArray(
        node.entries, `${path}.entries`, 'SNAPSHOT_CONTENT_UNSUPPORTED', TASK_ACTIVITY_SNAPSHOT_MAX_PAYLOAD_NODES, 'SNAPSHOT_LIMIT_EXCEEDED',
      );
      if (inputEntries.length > TASK_ACTIVITY_SNAPSHOT_MAX_PAYLOAD_NODES) tooLarge(`${path} object is too large`);
      const entries = inputEntries.map((entry, index) => {
        const pair = exactRecord(entry, ['key', 'value'], `${path}.entries[${index}]`, 'SNAPSHOT_CONTENT_UNSUPPORTED');
        return [payloadString(pair.key, `${path} object key`, budget), pair.value] as const;
      });
      entries.sort(([left], [right]) => compareUtf16(left, right));
      for (let index = 1; index < entries.length; index++) {
        if (entries[index - 1][0] === entries[index][0]) unsupported(`${path} has a duplicate object key`);
      }
      return Object.freeze(['object', Object.freeze(entries.map(([key, item]) =>
        Object.freeze([key, tagValue(item, depth + 1, budget, `${path}.${key}`)] as const)))] as const);
    }
    default:
      unsupported(`${path} has an unknown lossless JSON node type`);
  }
}

function untagPayload(value: TaggedPayload): LosslessActivityJson | null {
  switch (value[0]) {
    case 'null': return null;
    case 'boolean': return { type: 'boolean', value: value[1] };
    case 'string': return { type: 'string', value: value[1] };
    case 'number': return { type: 'number', token: value[1] };
    case 'array': return { type: 'array', items: value[1].map((entry) => untagPayload(entry) as LosslessActivityJson) };
    case 'object': return {
      type: 'object',
      entries: value[1].map(([key, entry]) => ({ key, value: untagPayload(entry) as LosslessActivityJson })),
    };
  }
}

function compareActivityOrder(left: SnapshotActivity, right: SnapshotActivity): number {
  if (left.created_at !== right.created_at) return left.created_at > right.created_at ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id > right.id ? -1 : 1;
}

function metadataBytes(page: TaskActivitySnapshotPage): string {
  return canonicalize({
    schema: page.schema,
    snapshot_id: page.snapshot_id,
    task_id: page.task_id,
    workspace_id: page.workspace_id,
    owner: page.owner,
    captured_at: page.captured_at,
    expires_at: page.expires_at,
    consistency: page.consistency,
    order: page.order,
    page_size: page.page_size,
    total: page.total,
    task_at_snapshot: page.task_at_snapshot,
  });
}

function encodedArrayBytes(values: readonly unknown[], maximumBytes = Number.POSITIVE_INFINITY): number {
  let total = 2;
  for (let index = 0; index < values.length; index++) {
    total += Buffer.byteLength(canonicalize(values[index]), 'utf8') + (index > 0 ? 1 : 0);
    if (total > maximumBytes) tooLarge('encoded page rows exceed the page byte limit');
  }
  return total;
}

function addPageSetBytes(current: number, increment: number): number {
  if (increment < 0 || increment > TASK_ACTIVITY_SNAPSHOT_MAX_PAGE_SET_BYTES - current) {
    tooLarge('page collection exceeds the aggregate 64 MiB encoded-byte limit');
  }
  return current + increment;
}

function digest(canonicalBytes: string): string {
  return `sha256:${createHash('sha256')
    .update(TASK_ACTIVITY_SNAPSHOT_DOMAIN, 'ascii')
    .update(Buffer.from([0]))
    .update(canonicalBytes, 'utf8')
    .digest('hex')}`;
}

function digestString(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) invalidPage('snapshot_digest must be lowercase sha256');
  return value;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string') unicodeString(value, 'canonical string');
    return JSON.stringify(value)!;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) unsupported('canonical numeric values must be safe integers other than negative zero');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  if (typeof value !== 'object') unsupported(`unsupported canonical value type ${typeof value}`);
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort(compareUtf16);
  return `{${keys.map((key) => `${JSON.stringify(unicodeString(key, 'canonical key'))}:${canonicalize(object[key])}`).join(',')}}`;
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  path: string,
  code: SnapshotCodecErrorCode = 'SNAPSHOT_INVALID_INPUT',
): Record<string, unknown> {
  const object = plainRecord(value, path, code);
  const keys = Object.keys(object);
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) {
    fail(code, `${path} has missing or unexpected fields`);
  }
  return object;
}

function plainRecord(
  value: unknown,
  path: string,
  code: SnapshotCodecErrorCode,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
    fail(code, `${path} must be a plain data object`);
  }
  const object = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) fail(code, `${path} has a non-plain prototype`);
  if (Object.getOwnPropertySymbols(object).length > 0) fail(code, `${path} has symbol keys`);
  const descriptors = Object.getOwnPropertyDescriptors(object);
  const keys = Object.keys(descriptors);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !('value' in descriptor)) fail(code, `${path}.${key} must be an enumerable data property`);
  }
  return object;
}

function exactArray(
  value: unknown,
  path: string,
  code: SnapshotCodecErrorCode = 'SNAPSHOT_INVALID_INPUT',
  maximumLength = TASK_ACTIVITY_SNAPSHOT_MAX_PAYLOAD_NODES,
  maximumErrorCode: SnapshotCodecErrorCode = code,
): readonly unknown[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(code, `${path} must be an ordinary array`);
  }
  if (value.length > maximumLength) fail(maximumErrorCode, `${path} exceeds its maximum length of ${maximumLength}`);
  if (Object.getOwnPropertySymbols(value).length > 0) fail(code, `${path} has symbol keys`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length !== value.length + 1 || !Object.prototype.hasOwnProperty.call(descriptors, 'length')) {
    fail(code, `${path} must be dense and have no extra properties`);
  }
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      fail(code, `${path}[${index}] must be an enumerable data element`);
    }
  }
  return value;
}

function payloadString(
  value: unknown,
  path: string,
  budget: { sourceTextBytes: number },
): string {
  if (typeof value !== 'string') unsupported(`${path} must be a string`);
  chargePayloadText(value, budget, path);
  return unicodeString(value, path);
}

function chargePayloadText(text: string, budget: { sourceTextBytes: number }, path: string): void {
  budget.sourceTextBytes += Buffer.byteLength(text, 'utf8');
  if (budget.sourceTextBytes > TASK_ACTIVITY_SNAPSHOT_MAX_ACTIVITY_BYTES) {
    tooLarge(`${path} payload text exceeds the codec byte budget`);
  }
}

function boundedActivityText(value: unknown, path: string): string {
  if (typeof value !== 'string') unsupported(`${path} must be a string`);
  if (Buffer.byteLength(value, 'utf8') > TASK_ACTIVITY_SNAPSHOT_MAX_ACTIVITY_BYTES) {
    tooLarge(`${path} exceeds the activity row byte budget`);
  }
  return unicodeString(value, path);
}

function uuid(value: unknown, path: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) unsupported(`${path} must be lowercase canonical UUID text`);
  return value;
}

function actorType(value: unknown, path: string): 'human' | 'agent' {
  if (value !== 'human' && value !== 'agent') unsupported(`${path} must be human or agent`);
  return value;
}

function unicodeString(value: unknown, path: string): string {
  if (typeof value !== 'string') unsupported(`${path} must be a string`);
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        unsupported(`${path} contains a lone UTF-16 surrogate`);
      }
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      unsupported(`${path} contains a lone UTF-16 surrogate`);
    }
  }
  return value;
}

function timestamp(value: unknown, path: string): string {
  if (typeof value !== 'string') unsupported(`${path} must be exact timestamp text`);
  const match = TIMESTAMP_RE.exec(value);
  if (!match) unsupported(`${path} must be UTC with exactly six fractional digits`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59) {
    unsupported(`${path} is not a real Gregorian UTC timestamp`);
  }
  return value;
}

function addSeconds(value: string, seconds: number): string {
  const match = TIMESTAMP_RE.exec(value);
  if (!match) unsupported('captured_at is not a supported timestamp');
  let year = Number(match[1]);
  let month = Number(match[2]);
  let day = Number(match[3]);
  let hour = Number(match[4]);
  let minute = Number(match[5]);
  let second = Number(match[6]);
  const fraction = match[7];
  let remaining = seconds;
  while (remaining > 0) {
    const untilMinute = 60 - second;
    if (remaining < untilMinute) {
      second += remaining;
      remaining = 0;
      continue;
    }
    remaining -= untilMinute;
    second = 0;
    if (minute < 59) minute++;
    else {
      minute = 0;
      if (hour < 23) hour++;
      else {
        hour = 0;
        if (day < daysInMonth(year, month)) day++;
        else {
          day = 1;
          if (month < 12) month++;
          else {
            month = 1;
            if (year === 9999) unsupported('expires_at would exceed supported Gregorian years');
            year++;
          }
        }
      }
    }
  }
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${fraction}Z`;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function integer(value: unknown, minimum: number, maximum: number, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) {
    invalid(`${path} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalidPage(`${path} must be boolean`);
  return value;
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function fail(code: SnapshotCodecErrorCode, message: string): never {
  throw new TaskActivitySnapshotCodecError(code, message);
}

function unsupported(message: string): never { return fail('SNAPSHOT_CONTENT_UNSUPPORTED', message); }
function tooLarge(message: string): never { return fail('SNAPSHOT_LIMIT_EXCEEDED', message); }
function invalid(message: string): never { return fail('SNAPSHOT_INVALID_INPUT', message); }
function invalidPage(message: string): never { return fail('SNAPSHOT_INVALID_PAGE', message); }
