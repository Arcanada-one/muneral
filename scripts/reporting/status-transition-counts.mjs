#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_EVENTS = 100_000;
const MAX_COHORT_TASKS = 50_000;
const MAX_WINDOW_DAYS = 3_660;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
// Mirrors TASK_STATUSES at packages/types/src/index.ts on the source pin.
const TASK_STATUSES = new Set(['todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled', 'archived']);
const TRANSITION_ACTION = 'task:status_changed';

class InputError extends Error {
  constructor(code) {
    super(code);
    this.name = 'InputError';
    this.code = code;
  }
}

function invalid() {
  throw new InputError('INPUT_INVALID');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseUuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value;
}

function parseTimestamp(value) {
  if (typeof value !== 'string') invalid();
  const match = UTC_TIMESTAMP.exec(value);
  if (!match) invalid();
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) invalid();
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day) ||
    parsed.getUTCHours() !== Number(hour) ||
    parsed.getUTCMinutes() !== Number(minute) ||
    parsed.getUTCSeconds() !== Number(second) ||
    parsed.getUTCMilliseconds() !== Number((fraction + '000').slice(0, 3))
  ) invalid();
  return timestamp;
}

function requireStatusToken(value) {
  if (typeof value !== 'string' || !TASK_STATUSES.has(value)) invalid();
  return value;
}

function dayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function utcDayStart(day) {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function buildReport(input) {
  if (!isRecord(input) || input.schemaVersion !== 1) invalid();
  if (!isRecord(input.scope) || !Array.isArray(input.scope.taskIds)) invalid();
  if (input.scope.taskIds.length > MAX_COHORT_TASKS) invalid();

  const taskIds = input.scope.taskIds.map(parseUuid);
  const cohort = new Set(taskIds);
  if (cohort.size !== taskIds.length) invalid();

  const start = parseTimestamp(input.scope.startInclusiveUtc);
  const end = parseTimestamp(input.scope.endExclusiveUtc);
  if (start >= end || end - start > MAX_WINDOW_DAYS * 86_400_000) invalid();

  if (!isRecord(input.completeness)) invalid();
  const completeness = input.completeness.state;
  if (completeness !== 'complete' && completeness !== 'incomplete') invalid();
  const completenessEvidenceId = parseUuid(input.completeness.evidenceId);

  if (!Array.isArray(input.events) || input.events.length > MAX_EVENTS) invalid();
  const uniqueEvents = new Map();
  for (const event of input.events) {
    if (!isRecord(event)) invalid();
    const id = parseUuid(event.id);
    const taskId = parseUuid(event.taskId);
    if (typeof event.action !== 'string' || !/^[a-z][a-z0-9:_-]{0,79}$/.test(event.action)) invalid();
    const createdAtMs = parseTimestamp(event.createdAt);
    const sanitized = { id, taskId, action: event.action, createdAt: event.createdAt };
    if (event.action === TRANSITION_ACTION) {
      const from = requireStatusToken(event.from);
      const to = requireStatusToken(event.to);
      if (from === to) invalid();
      sanitized.from = from;
      sanitized.to = to;
    }
    const previous = uniqueEvents.get(id);
    if (previous) {
      if (
        previous.taskId !== sanitized.taskId ||
        previous.action !== sanitized.action ||
        previous.createdAt !== sanitized.createdAt ||
        previous.from !== sanitized.from ||
        previous.to !== sanitized.to
      ) invalid();
      continue;
    }
    uniqueEvents.set(id, { ...sanitized, createdAtMs });
  }

  const countsByDay = new Map();
  let observedTotal = 0;
  for (const event of uniqueEvents.values()) {
    if (event.action !== TRANSITION_ACTION || !cohort.has(event.taskId)) continue;
    if (event.createdAtMs < start || event.createdAtMs >= end) continue;
    const dateUtc = dayKey(event.createdAtMs);
    countsByDay.set(dateUtc, (countsByDay.get(dateUtc) ?? 0) + 1);
    observedTotal += 1;
  }

  const complete = completeness === 'complete';
  const firstDay = utcDayStart(dayKey(start));
  const lastIncludedMs = end - 1;
  const lastDay = utcDayStart(dayKey(lastIncludedMs));
  const dailyCounts = [];
  for (let day = firstDay; day <= lastDay; day += 86_400_000) {
    const dateUtc = new Date(day).toISOString().slice(0, 10);
    const observed = countsByDay.get(dateUtc) ?? 0;
    if (complete || observed > 0) {
      dailyCounts.push({ dateUtc, count: observed });
    }
  }

  return {
    schemaVersion: 1,
    scope: {
      taskIds: [...taskIds].sort(),
      cohortTaskCount: taskIds.length,
      startInclusiveUtc: input.scope.startInclusiveUtc,
      endExclusiveUtc: input.scope.endExclusiveUtc,
      timeZone: 'UTC',
      eventAction: TRANSITION_ACTION,
      denominatorMeaning: 'Number of distinct task UUIDs in the explicitly supplied cohort; counts are transition events, not unique transitioned tasks.',
    },
    inputCompleteness: {
      state: complete ? 'CALLER_REPORTED_COMPLETE' : 'CALLER_REPORTED_INCOMPLETE',
      evidenceId: completenessEvidenceId,
    },
    transitions: {
      verdict: complete ? 'MEASURED' : 'NOT_MEASURED',
      observedTotal,
      dailyCounts,
      dailyCountsMeaning: complete
        ? 'Counts include zero for every UTC date intersecting the half-open window.'
        : 'Only dates with observed events are listed; absent dates are not zero because the input is incomplete.',
    },
    rates: {
      verdict: 'NOT_MEASURED',
      reason: 'Aggregate events do not establish the number of unique tasks that transitioned or their historical state.',
    },
    comparability: {
      verdict: 'NOT_MEASURED',
      reason: 'No paired report with matching cohort and UTC window was supplied.',
    },
  };
}

export async function reportFromFile(inputPath) {
  let bytes;
  try {
    bytes = await readFile(inputPath);
  } catch {
    throw new InputError('INPUT_UNAVAILABLE');
  }
  if (bytes.length > MAX_INPUT_BYTES) throw new InputError('INPUT_TOO_LARGE');
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new InputError('INPUT_INVALID');
  }
  return buildReport(parsed);
}

export { buildReport };

async function main() {
  if (process.argv.length !== 3) {
    process.stderr.write('Usage: node scripts/reporting/status-transition-counts.mjs <sanitized-envelope.json>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const report = await reportFromFile(process.argv[2]);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const code = error instanceof InputError ? error.code : 'INPUT_INVALID';
    process.stderr.write(`status-transition-counts: ${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
