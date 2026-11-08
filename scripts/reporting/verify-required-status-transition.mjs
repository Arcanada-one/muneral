#!/usr/bin/env node
/**
 * Offline verifier for a required Muneral status transition.
 *
 * Callers (future PR-merge / Orca-close hooks, or author preflight) supply one
 * sanitized JSON envelope. This tool never calls Muneral, never opens a
 * database, and never treats a comment as a status change.
 *
 * Verdicts:
 *   PASS         — required task:status_changed event is present and matches
 *   FAIL         — input is complete and the required transition is absent/mismatched
 *   NOT_MEASURED — caller reported incomplete collection; do not invent a pass
 */
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const INPUT_READ_CHUNK_BYTES = 64 * 1024;
const MAX_EVENTS = 100_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
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

export async function readBounded(stream) {
  let total = 0;
  const chunks = [];
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.byteLength > INPUT_READ_CHUNK_BYTES) throw new InputError('INPUT_INVALID');
    if (total + buf.byteLength > MAX_INPUT_BYTES) throw new InputError('INPUT_TOO_LARGE');
    chunks.push(buf);
    total += buf.byteLength;
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function sanitizeEvent(raw) {
  if (!isRecord(raw)) invalid();
  const id = parseUuid(raw.id);
  const taskId = parseUuid(raw.taskId);
  if (typeof raw.action !== 'string' || raw.action.length === 0 || raw.action.length > 128) invalid();
  const action = raw.action;
  parseTimestamp(raw.createdAt);
  const createdAt = raw.createdAt;
  if (action === TRANSITION_ACTION) {
    const from = requireStatusToken(raw.from);
    const to = requireStatusToken(raw.to);
    if (from === to) invalid();
    return { id, taskId, action, createdAt, from, to };
  }
  return { id, taskId, action, createdAt };
}

/**
 * @returns {{ verdict: 'PASS'|'FAIL'|'NOT_MEASURED', reason: string, matchedEventId: string|null }}
 */
export function verifyRequiredTransition(input) {
  if (!isRecord(input) || input.schemaVersion !== 1) invalid();
  if (!isRecord(input.required)) invalid();
  if (!isRecord(input.completeness)) invalid();

  const taskId = parseUuid(input.required.taskId);
  const from = requireStatusToken(input.required.from);
  const to = requireStatusToken(input.required.to);
  if (from === to) invalid();

  const completenessState = input.completeness.state;
  if (completenessState !== 'complete' && completenessState !== 'incomplete') invalid();
  parseUuid(input.completeness.evidenceId);

  if (!Array.isArray(input.events) || input.events.length > MAX_EVENTS) invalid();

  const byId = new Map();
  for (const raw of input.events) {
    const event = sanitizeEvent(raw);
    const prior = byId.get(event.id);
    if (prior) {
      const same =
        prior.taskId === event.taskId &&
        prior.action === event.action &&
        prior.createdAt === event.createdAt &&
        prior.from === event.from &&
        prior.to === event.to;
      if (!same) invalid();
      continue;
    }
    byId.set(event.id, event);
  }

  if (completenessState === 'incomplete') {
    return {
      schemaVersion: 1,
      verdict: 'NOT_MEASURED',
      reason: 'INPUT_INCOMPLETE',
      matchedEventId: null,
      required: { taskId, from, to, action: TRANSITION_ACTION },
    };
  }

  for (const event of byId.values()) {
    if (
      event.action === TRANSITION_ACTION &&
      event.taskId === taskId &&
      event.from === from &&
      event.to === to
    ) {
      return {
        schemaVersion: 1,
        verdict: 'PASS',
        reason: 'REQUIRED_TRANSITION_PRESENT',
        matchedEventId: event.id,
        required: { taskId, from, to, action: TRANSITION_ACTION },
      };
    }
  }

  return {
    schemaVersion: 1,
    verdict: 'FAIL',
    reason: 'REQUIRED_TRANSITION_ABSENT',
    matchedEventId: null,
    required: { taskId, from, to, action: TRANSITION_ACTION },
  };
}

async function main(argv) {
  if (argv.length !== 1) {
    process.stderr.write(
      'Usage: node scripts/reporting/verify-required-status-transition.mjs <sanitized-envelope.json|->\n',
    );
    process.exit(2);
  }
  const source = argv[0];
  const stream = source === '-' ? process.stdin : createReadStream(source);
  try {
    const text = await readBounded(stream);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new InputError('INPUT_INVALID');
    }
    const report = verifyRequiredTransition(parsed);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.verdict === 'FAIL') process.exit(1);
    if (report.verdict === 'NOT_MEASURED') process.exit(3);
    process.exit(0);
  } catch (err) {
    if (err instanceof InputError) {
      process.stderr.write(`verify-required-status-transition: ${err.code}\n`);
      process.exit(2);
    }
    throw err;
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main(process.argv.slice(2));
}
