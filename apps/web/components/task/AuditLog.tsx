'use client';

import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Bot, User, Clock, Copy } from 'lucide-react';
import { TASK_STATUSES, type TaskPriority, type TaskStatus } from '@muneral/types';
import { useActivity } from '@/lib/api/tasks';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

interface AuditLogProps {
  taskId: string;
}

type ActivityFilterMode = 'all' | 'status_changes';
type ActorFilterMode = 'all' | 'humans' | 'agents';

interface ActivityFilterState {
  taskId: string;
  mode: ActivityFilterMode;
  actorMode: ActorFilterMode;
  showExactUtcTime: boolean;
  reverseLoadedOrder: boolean;
}

interface VisibleEventIdCopyFeedback {
  scopeKey: string;
  generation: number;
  status: 'pending' | 'copied' | 'failed';
}

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
  archived: 'Archived',
};

const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

function isTaskStatus(value: unknown): value is TaskStatus {
  return TASK_STATUSES.some((status) => status === value);
}

function isStatusTransitionPayload(
  value: unknown,
): value is { from: unknown; to: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'from') &&
    Object.prototype.hasOwnProperty.call(value, 'to')
  );
}

function formatStatusTransition(payload: unknown): string | undefined {
  if (!isStatusTransitionPayload(payload)) return undefined;
  if (!isTaskStatus(payload.from) || !isTaskStatus(payload.to)) return undefined;

  return `${TASK_STATUS_LABELS[payload.from]} → ${TASK_STATUS_LABELS[payload.to]}`;
}

function formatTaskCreated(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return undefined;
  }

  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) return undefined;

  const keys = Object.keys(payload);
  if (keys.length !== 2 || keys.some((key) => key !== 'title' && key !== 'status')) {
    return undefined;
  }

  const title = Object.getOwnPropertyDescriptor(payload, 'title');
  const status = Object.getOwnPropertyDescriptor(payload, 'status');
  if (
    title === undefined || !('value' in title) || typeof title.value !== 'string' ||
    title.value.length === 0 ||
    status === undefined || !('value' in status) || !isTaskStatus(status.value)
  ) {
    return undefined;
  }

  return `Created “${title.value}” · Status: ${TASK_STATUS_LABELS[status.value]}`;
}

function isTaskPriority(value: unknown): value is TaskPriority {
  return value === 'critical' || value === 'high' || value === 'medium' || value === 'low';
}

function formatTaskUpdate(payload: unknown): string[] | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return undefined;
  }

  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) return undefined;

  const keys = Object.keys(payload);
  if (keys.length === 0 || keys.some((key) => key !== 'priority' && key !== 'dueDate')) {
    return undefined;
  }

  const details: string[] = [];
  const priority = Object.getOwnPropertyDescriptor(payload, 'priority');
  if (priority !== undefined) {
    if (!('value' in priority) || !isTaskPriority(priority.value)) return undefined;
    details.push(`Priority set to ${TASK_PRIORITY_LABELS[priority.value]}`);
  }

  const dueDate = Object.getOwnPropertyDescriptor(payload, 'dueDate');
  if (dueDate !== undefined) {
    if (!('value' in dueDate) || typeof dueDate.value !== 'string') return undefined;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dueDate.value)) {
      const date = new Date(`${dueDate.value}T00:00:00.000Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dueDate.value) {
        return undefined;
      }
      details.push(`Due date set to ${date.toLocaleDateString(undefined, { timeZone: 'UTC' })}`);
    } else {
      const timestamp = Date.parse(dueDate.value);
      if (!Number.isFinite(timestamp)) return undefined;
      details.push(`Due date set to ${new Date(timestamp).toLocaleDateString()}`);
    }
  }

  return details.length > 0 ? details : undefined;
}

function getCommentBody(payload: unknown): string | undefined {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return undefined;
  }

  const body = Object.getOwnPropertyDescriptor(payload, 'body');
  return body && 'value' in body && typeof body.value === 'string'
    ? body.value
    : undefined;
}

interface EvidenceActivityDetails {
  uri: string;
  sha256: string;
  contentType: string;
}

const EVIDENCE_URI_PATTERN = /^[a-z][a-z0-9+.-]*:[^\s\u0000-\u001f\u007f]+$/i;
const EVIDENCE_URI_USERINFO_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i;
const EVIDENCE_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EVIDENCE_CONTENT_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:; ?[a-z0-9!#$&^_.+\-]+=[a-z0-9!#$&^_.+"-]+)*$/;

function getEvidenceActivityDetails(payload: unknown): EvidenceActivityDetails | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return undefined;
  }

  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) return undefined;

  const keys = Object.keys(payload);
  const expectedKeys = ['content_type', 'evidence_id', 'sha256', 'uri'];
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(payload, key))
  ) {
    return undefined;
  }

  const evidenceId = Object.getOwnPropertyDescriptor(payload, 'evidence_id');
  const uri = Object.getOwnPropertyDescriptor(payload, 'uri');
  const sha256 = Object.getOwnPropertyDescriptor(payload, 'sha256');
  const contentType = Object.getOwnPropertyDescriptor(payload, 'content_type');
  if (
    evidenceId === undefined || !('value' in evidenceId) ||
    typeof evidenceId.value !== 'string' || evidenceId.value.length === 0 ||
    uri === undefined || !('value' in uri) || typeof uri.value !== 'string' ||
    uri.value.length > 2048 || !EVIDENCE_URI_PATTERN.test(uri.value) ||
    EVIDENCE_URI_USERINFO_PATTERN.test(uri.value) ||
    sha256 === undefined || !('value' in sha256) ||
    typeof sha256.value !== 'string' || !EVIDENCE_SHA256_PATTERN.test(sha256.value) ||
    contentType === undefined || !('value' in contentType) ||
    typeof contentType.value !== 'string' || contentType.value.length > 128 ||
    !EVIDENCE_CONTENT_TYPE_PATTERN.test(contentType.value)
  ) {
    return undefined;
  }

  return {
    uri: uri.value,
    sha256: sha256.value,
    contentType: contentType.value,
  };
}

function EvidenceActivityDetailsView({ details }: { details: EvidenceActivityDetails }) {
  return (
    <details className="mt-1 min-w-0">
      <summary tabIndex={0} className="cursor-pointer text-xs text-muted-foreground">
        Evidence details
      </summary>
      <dl className="mt-1 grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
        <dt className="text-muted-foreground">URI</dt>
        <dd dir="auto" className="min-w-0 break-all">{details.uri}</dd>
        <dt className="text-muted-foreground">SHA-256</dt>
        <dd className="min-w-0 break-all">{details.sha256}</dd>
        <dt className="text-muted-foreground">Content type</dt>
        <dd className="min-w-0 break-words">{details.contentType}</dd>
      </dl>
    </details>
  );
}

function CommentBody({ body }: { body: string }) {
  const content = (
    <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
      {body}
    </p>
  );

  if (body.length > 1_000) {
    return (
      <details className="mt-1 min-w-0">
        <summary tabIndex={0} className="cursor-pointer text-xs text-muted-foreground">
          Read full comment
        </summary>
        <div className="mt-1">
          {content}
        </div>
      </details>
    );
  }

  return <div className="mt-1 min-w-0">{content}</div>;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) {
    const timeUntil = -diffMs;
    if (timeUntil < 60_000) return 'just now';
    const minutesUntil = Math.ceil(timeUntil / 60_000);
    if (minutesUntil < 60) return `in ${minutesUntil}m`;
    const hoursUntil = Math.ceil(minutesUntil / 60);
    if (hoursUntil < 24) return `in ${hoursUntil}h`;
    return date.toLocaleDateString();
  }
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString();
}

function formatExactUtcTime(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return undefined;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone, sign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText ?? '0');
  const offsetMinute = Number(offsetMinuteText ?? '0');

  if (
    month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59 || (zone !== 'Z' && sign === '-' && offsetHour === 0 && offsetMinute === 0)
  ) return undefined;

  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  calendarDate.setUTCHours(hour, minute, second, 0);
  if (
    calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1
    || calendarDate.getUTCDate() !== day || calendarDate.getUTCHours() !== hour
  ) return undefined;

  const offsetSign = sign === '-' ? -1 : 1;
  const offsetMs = (offsetHour * 60 + offsetMinute) * 60_000 * offsetSign;
  const utc = new Date(calendarDate.getTime() - offsetMs);
  const normalizedFraction = fraction.replace(/0+$/, '').padEnd(3, '0');
  const utcDateTime = utc.toISOString().replace(/\.\d{3}Z$/, '');
  return `${utcDateTime}.${normalizedFraction || '000'}Z`;
}

function CopyActivityActorId({ actorId }: { actorId: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [isCopying, setIsCopying] = useState(false);

  const copyActorId = async () => {
    setCopyState('idle');
    setIsCopying(true);
    try {
      await navigator.clipboard.writeText(actorId);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    } finally {
      setIsCopying(false);
    }
  };

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0"
        aria-label="Copy recorded actor ID"
        onClick={copyActorId}
        disabled={isCopying}
      >
        <Copy className="h-3 w-3" />
      </Button>
      {copyState === 'copied' && (
        <span role="status" className="text-xs text-green-700">Actor ID copied.</span>
      )}
      {copyState === 'failed' && (
        <span role="alert" className="text-xs text-destructive">
          Could not copy actor ID. Try copying it manually.
        </span>
      )}
    </div>
  );
}

export function AuditLog({ taskId }: AuditLogProps) {
  const activityFilterId = useId();
  const [pageState, setPageState] = useState({ taskId, page: 1 });
  if (pageState.taskId !== taskId) setPageState({ taskId, page: 1 });
  const page = pageState.taskId === taskId ? pageState.page : 1;
  const [filterState, setFilterState] = useState<ActivityFilterState>({
    taskId,
    mode: 'all' as ActivityFilterMode,
    actorMode: 'all' as ActorFilterMode,
    showExactUtcTime: false,
    reverseLoadedOrder: false,
  });
  if (filterState.taskId !== taskId) {
    setFilterState({
      taskId,
      mode: 'all',
      actorMode: 'all',
      showExactUtcTime: false,
      reverseLoadedOrder: false,
    });
  }
  const filterMode = filterState.taskId === taskId ? filterState.mode : 'all';
  const actorFilterMode = filterState.taskId === taskId ? filterState.actorMode : 'all';
  const showExactUtcTime = filterState.taskId === taskId && filterState.showExactUtcTime;
  const reverseLoadedOrder = filterState.taskId === taskId && filterState.reverseLoadedOrder;
  const { data, isLoading, isError, isFetching, refetch } = useActivity(taskId, page);
  const total = data !== undefined && Number.isSafeInteger(data.total) && data.total >= 0
    ? data.total
    : undefined;
  const limit = data !== undefined && Number.isSafeInteger(data.limit) && data.limit > 0
    ? data.limit
    : undefined;
  const responsePageMatches = data !== undefined && Number.isSafeInteger(data.page) && data.page === page;
  const responsePageIsUsable = data?.page === undefined || responsePageMatches;
  const pageCount = total !== undefined && limit !== undefined
    ? Math.max(1, Math.ceil(total / limit))
    : undefined;
  const pageOutOfRange = responsePageMatches && pageCount !== undefined && page > pageCount;
  if (pageOutOfRange) setPageState({ taskId, page: 1 });
  const currentPageEntries = responsePageIsUsable && !pageOutOfRange
    ? (data?.data ?? []).filter((entry) => !entry.taskId || entry.taskId === taskId)
    : [];
  const actionFilteredEntries = filterMode === 'status_changes'
    ? currentPageEntries.filter((entry) => entry.action === 'task:status_changed')
    : currentPageEntries;
  const filteredEntries = actorFilterMode === 'humans'
    ? actionFilteredEntries.filter((entry) => entry.actorType === 'human')
    : actorFilterMode === 'agents'
      ? actionFilteredEntries.filter((entry) => entry.actorType === 'agent')
      : actionFilteredEntries;
  const entries = reverseLoadedOrder ? [...filteredEntries].reverse() : filteredEntries;
  const canShowVisibleCount = data !== undefined && responsePageMatches &&
    responsePageIsUsable && !pageOutOfRange && !isLoading && !isError && !isFetching;
  const visibleEventIds = entries.map((entry) => entry.id);
  const visibleEventIdsText = visibleEventIds.join('\n');
  const visibleEventIdCopyScopeKey = [
    taskId,
    String(page),
    filterMode,
    actorFilterMode,
    String(reverseLoadedOrder),
    JSON.stringify(visibleEventIds),
    data === undefined ? 'data:none' : `data:${String(data.page)}:${String(data.total)}:${String(data.limit)}`,
    String(isLoading),
    String(isError),
    String(isFetching),
    String(responsePageMatches),
    String(responsePageIsUsable),
    String(pageOutOfRange),
  ].join('\u0001');
  const [visibleEventIdCopyFeedback, setVisibleEventIdCopyFeedback] =
    useState<VisibleEventIdCopyFeedback | undefined>();
  const [visibleEventIdCopyEpoch, setVisibleEventIdCopyEpoch] = useState({
    key: visibleEventIdCopyScopeKey,
    generation: 0,
  });
  if (visibleEventIdCopyEpoch.key !== visibleEventIdCopyScopeKey) {
    setVisibleEventIdCopyEpoch({
      key: visibleEventIdCopyScopeKey,
      generation: visibleEventIdCopyEpoch.generation + 1,
    });
  }
  const visibleEventIdCopyGeneration =
    visibleEventIdCopyEpoch.key === visibleEventIdCopyScopeKey
      ? visibleEventIdCopyEpoch.generation
      : visibleEventIdCopyEpoch.generation + 1;
  const visibleEventIdCopyScopeKeyRef = useRef(visibleEventIdCopyScopeKey);
  const visibleEventIdCopyGenerationRef = useRef(visibleEventIdCopyGeneration);
  const visibleEventIdCopyRequestRef = useRef<number | null>(null);
  const visibleEventIdCopyRequestIdRef = useRef(0);
  useLayoutEffect(() => {
    visibleEventIdCopyScopeKeyRef.current = visibleEventIdCopyScopeKey;
    visibleEventIdCopyGenerationRef.current = visibleEventIdCopyGeneration;
    visibleEventIdCopyRequestRef.current = null;
  }, [visibleEventIdCopyScopeKey, visibleEventIdCopyGeneration]);
  const visibleEventIdCopyStatus =
    visibleEventIdCopyFeedback?.scopeKey === visibleEventIdCopyScopeKey &&
    visibleEventIdCopyFeedback.generation === visibleEventIdCopyGeneration
      ? visibleEventIdCopyFeedback.status
      : 'idle';
  const canCopyVisibleEventIds = canShowVisibleCount && entries.length > 0;

  const copyVisibleEventIds = async () => {
    if (!canCopyVisibleEventIds || visibleEventIdCopyRequestRef.current !== null) return;

    const requestId = ++visibleEventIdCopyRequestIdRef.current;
    const generation = visibleEventIdCopyGeneration;
    const scopeKey = visibleEventIdCopyScopeKey;
    visibleEventIdCopyRequestRef.current = requestId;
    setVisibleEventIdCopyFeedback({ scopeKey, generation, status: 'pending' });

    // Scope/generation alone decide whether feedback may land. requestRef only
    // serializes in-flight clicks and is cleared on view change so a newer copy
    // can start; it must not veto a still-current clipboard settlement.
    const isCurrentRequest = () =>
      visibleEventIdCopyScopeKeyRef.current === scopeKey &&
      visibleEventIdCopyGenerationRef.current === generation;

    try {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== 'function') {
        throw new Error('Clipboard unavailable');
      }
      await clipboard.writeText(visibleEventIdsText);
      if (isCurrentRequest()) {
        setVisibleEventIdCopyFeedback({ scopeKey, generation, status: 'copied' });
      }
    } catch {
      if (isCurrentRequest()) {
        setVisibleEventIdCopyFeedback({ scopeKey, generation, status: 'failed' });
      }
    } finally {
      if (visibleEventIdCopyRequestRef.current === requestId) {
        visibleEventIdCopyRequestRef.current = null;
      }
    }
  };

  const setPage = (nextPage: number) => setPageState({ taskId, page: nextPage });
  const updateFilterState = (updates: Partial<Omit<ActivityFilterState, 'taskId'>>) => {
    setFilterState((current) => ({
      taskId,
      mode: current.taskId === taskId ? current.mode : 'all',
      actorMode: current.taskId === taskId ? current.actorMode : 'all',
      showExactUtcTime: current.taskId === taskId ? current.showExactUtcTime : false,
      reverseLoadedOrder: current.taskId === taskId ? current.reverseLoadedOrder : false,
      ...updates,
    }));
  };
  const canResetActivityFilters = filterMode !== 'all' || actorFilterMode !== 'all';

  if (!taskId) return null;

  if (isError) {
    return (
      <div role="alert" className="rounded-lg border p-4 text-sm text-muted-foreground">
        <p>Activity is unavailable. Try again later.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            aria-label="Retry activity"
            disabled={isFetching}
            onClick={() => { void refetch().catch(() => undefined); }}
            className="rounded border px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Retry
          </button>
          {page > 1 && (
            <button
              type="button"
              aria-label="Show newest activity"
              disabled={isFetching}
              onClick={() => setPage(1)}
              className="rounded border px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Show newest activity
            </button>
          )}
        </div>
      </div>
    );
  }

  if (isLoading || data === undefined) {
    return (
      <div className="rounded-lg border p-4">
        <h4 className="mb-3 text-sm font-medium">Activity</h4>
        <p className="text-xs text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (pageOutOfRange) {
    return (
      <div className="rounded-lg border p-4" aria-live="polite">
        <h4 className="mb-3 text-sm font-medium">Activity Log</h4>
        <p className="text-xs text-muted-foreground">Showing the newest activity...</p>
      </div>
    );
  }

  const firstEntry = total === undefined || total === 0 || limit === undefined
    ? 0
    : (page - 1) * limit + 1;
  const lastEntry = total === undefined || limit === undefined
    ? 0
    : Math.min(page * limit, total);
  const canGoPrevious = !isLoading && responsePageMatches && page > 1;
  const canGoNext = !isLoading && responsePageMatches && pageCount !== undefined && page < pageCount;

  return (
    <div className="rounded-lg border p-4">
      <h4 className="mb-3 flex items-center gap-2 text-sm font-medium">
        <Clock className="h-4 w-4" />
        Activity Log
      </h4>

      <div className="mb-3 flex items-center gap-2 text-xs">
        <label htmlFor={activityFilterId}>Activity filter</label>
        <select
          id={activityFilterId}
          value={filterMode}
          onChange={(event) => updateFilterState({
            mode: event.target.value === 'status_changes' ? 'status_changes' : 'all',
          })}
          className="rounded border bg-background px-2 py-1"
        >
          <option value="all">All activity</option>
          <option value="status_changes">Status changes on this page</option>
        </select>
      </div>

      <div className="mb-3 flex items-center gap-2 text-xs">
        <label htmlFor={`${activityFilterId}-actor`}>Actor filter</label>
        <select
          id={`${activityFilterId}-actor`}
          value={actorFilterMode}
          onChange={(event) => updateFilterState({
            actorMode: event.target.value === 'humans' || event.target.value === 'agents'
              ? event.target.value
              : 'all',
          })}
          className="rounded border bg-background px-2 py-1"
        >
          <option value="all">All actors</option>
          <option value="humans">Humans on this page</option>
          <option value="agents">Agents on this page</option>
        </select>
      </div>

      <div className="mb-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => updateFilterState({ mode: 'all', actorMode: 'all' })}
          disabled={!canResetActivityFilters}
        >
          Reset activity filters
        </Button>
      </div>

      {canShowVisibleCount && currentPageEntries.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={reverseLoadedOrder}
            aria-describedby={`${activityFilterId}-reverse-order-help`}
            onClick={() => updateFilterState({ reverseLoadedOrder: !reverseLoadedOrder })}
          >
            Reverse loaded activity order
          </Button>
          <span id={`${activityFilterId}-reverse-order-help`} className="text-muted-foreground">
            Reverses only matching activity already loaded on this page.
          </span>
        </div>
      )}

      {canShowVisibleCount && (
        <p role="status" className="mb-3 text-xs text-muted-foreground">
          Showing {entries.length} of {currentPageEntries.length} loaded activity{' '}
          {currentPageEntries.length === 1 ? 'entry' : 'entries'} on this page.
        </p>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={copyVisibleEventIds}
          disabled={!canCopyVisibleEventIds || visibleEventIdCopyStatus === 'pending'}
        >
          Copy visible activity event IDs ({entries.length})
        </Button>
        {visibleEventIdCopyStatus === 'copied' && (
          <span role="status" className="text-xs text-green-700">Activity event IDs copied.</span>
        )}
        {visibleEventIdCopyStatus === 'failed' && (
          <span role="alert" className="text-xs text-destructive">
            Could not copy activity event IDs. Try copying them manually.
          </span>
        )}
      </div>

      <div className="mb-3 flex items-center gap-2 text-xs">
        <input
          id={`${activityFilterId}-exact-utc`}
          type="checkbox"
          checked={showExactUtcTime}
          onChange={(event) => updateFilterState({ showExactUtcTime: event.target.checked })}
        />
        <label htmlFor={`${activityFilterId}-exact-utc`}>Show exact UTC timestamps</label>
      </div>

      <ScrollArea className="h-64">
        <ul className="space-y-3">
          {entries.map((entry) => {
            const commentBody = entry.action === 'comment'
              ? getCommentBody(entry.payload)
              : undefined;
            const taskCreatedDetails = entry.action === 'task:created'
              ? formatTaskCreated(entry.payload)
              : undefined;
            const taskUpdateDetails = entry.action === 'task:updated'
              ? formatTaskUpdate(entry.payload)
              : undefined;
            const evidenceDetails = entry.action === 'task:evidence_attached'
              ? getEvidenceActivityDetails(entry.payload)
              : undefined;
            const exactUtcTime = showExactUtcTime ? formatExactUtcTime(entry.createdAt) : undefined;

            return (
              <li key={entry.id} className="flex gap-3">
                <Avatar className="h-6 w-6 flex-shrink-0 mt-0.5">
                  <AvatarFallback className="text-xs">
                    {entry.actorType === 'agent' ? (
                      <Bot className="h-3 w-3" />
                    ) : (
                      <User className="h-3 w-3" />
                    )}
                  </AvatarFallback>
                </Avatar>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-medium">
                      {entry.actorName || `Actor ID: ${entry.actorId}`}
                    </span>
                    <span className={entry.actorType === 'agent'
                      ? 'rounded bg-blue-100 px-1 py-0.5 text-xs text-blue-700'
                      : 'rounded bg-muted px-1 py-0.5 text-xs text-muted-foreground'}>
                      {entry.actorType}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {entry.action === 'task:status_changed'
                        ? formatStatusTransition(entry.payload) ?? entry.action
                        : entry.action}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {showExactUtcTime
                      ? (exactUtcTime ?? 'Exact time unavailable')
                      : formatRelativeTime(entry.createdAt)}
                  </p>
                  {taskCreatedDetails !== undefined && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {taskCreatedDetails}
                    </p>
                  )}
                  {taskUpdateDetails !== undefined && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {taskUpdateDetails.join(' · ')}
                    </p>
                  )}
                  {commentBody !== undefined && <CommentBody body={commentBody} />}
                  {evidenceDetails !== undefined && (
                    <EvidenceActivityDetailsView details={evidenceDetails} />
                  )}
                  <CopyActivityActorId
                    key={JSON.stringify([
                      taskId,
                      page,
                      filterMode,
                      actorFilterMode,
                      reverseLoadedOrder,
                      visibleEventIdsText,
                      entry.id,
                      entry.actorId,
                    ])}
                    actorId={entry.actorId}
                  />
                </div>
              </li>
            );
          })}
        </ul>
        {entries.length === 0 && (
          <p className="py-3 text-xs text-muted-foreground">
            {actorFilterMode !== 'all'
              ? 'No matching activity on this page.'
              : filterMode === 'status_changes'
              ? 'No status changes on this page.'
              : 'No activity on this page.'}
          </p>
        )}
      </ScrollArea>

      <nav aria-label="Activity pagination" className="mt-3 flex items-center justify-between gap-3 text-xs">
        <span aria-live="polite" className="text-muted-foreground">
          {total !== undefined && limit !== undefined && responsePageMatches
            ? `Showing ${firstEntry}–${lastEntry} of ${total}`
            : `Page ${page}`}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous activity page"
            disabled={!canGoPrevious}
            onClick={() => setPage(page - 1)}
            className="rounded border px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Newer
          </button>
          {pageCount !== undefined && <span>Page {page} of {pageCount}</span>}
          <button
            type="button"
            aria-label="Next activity page"
            disabled={!canGoNext}
            onClick={() => setPage(page + 1)}
            className="rounded border px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Older
          </button>
        </div>
      </nav>
    </div>
  );
}
