import { pathToFileURL } from 'node:url';

export const MAX_STDERR_BYTES = 64 * 1024;
export const MAX_DIAGNOSTIC_LINES = 8;
export const MAX_DIAGNOSTIC_LINE_BYTES = 256;
export const MAX_DIAGNOSTIC_TOTAL_BYTES = 2048;
export const STDERR_REDACTION_MARKER = '[REDACTED]';

const MAX_DIAGNOSTIC_CODES = 8;
const STDERR_PHRASES = new Map([
  ['No usable sandbox!', 'BROWSER_SANDBOX_UNAVAILABLE'],
  ["DevToolsActivePort file doesn't exist", 'BROWSER_STARTUP_FAILURE'],
  ['Missing X server or $DISPLAY', 'BROWSER_DISPLAY_UNAVAILABLE'],
]);
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|.)/g;
const UNSAFE_CODEPOINT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const URL_OR_EMAIL = /(?:\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s<>"']+)|(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/gi;
const ABSOLUTE_PATH = /(?<![A-Za-z0-9])(?:\/[^\s<>"']+|[A-Za-z]:\\[^\s<>"']+)/g;
const PRIVATE_ASSIGNMENT = /\b(?:pass(?:word|wd)?|token|secret|credential|authorization|cookie|api[-_]?key|access[-_]?key)\b\s*[:=].*$/i;

function maskQuotedSegments(value) {
  let output = '';
  let redacted = false;
  for (let index = 0; index < value.length;) {
    const quote = value[index];
    const prior = value[index - 1];
    const startsQuote = quote === '"' || quote === '\x60' ||
      (quote === "'" && (prior === undefined || !/[A-Za-z0-9_]/.test(prior)));
    if (!startsQuote) {
      output += quote;
      index += 1;
      continue;
    }
    redacted = true;
    let cursor = index + 1;
    let closed = false;
    while (cursor < value.length) {
      if (value[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (value[cursor] === quote) {
        cursor += 1;
        closed = true;
        break;
      }
      cursor += 1;
    }
    output += '\u0000';
    index = closed ? cursor : value.length;
  }
  return { value: output, redacted };
}

function maskMatches(value, pattern) {
  let redacted = false;
  const masked = value.replace(pattern, () => {
    redacted = true;
    return '\u0000';
  });
  return { value: masked, redacted };
}

function projectDiagnosticLine(sourceLine) {
  let value = sourceLine.endsWith('\r') ? sourceLine.slice(0, -1) : sourceLine;
  let redacted = false;
  const ansi = maskMatches(value, ANSI_ESCAPE);
  value = ansi.value;
  redacted ||= ansi.redacted;
  const controls = maskMatches(value, UNSAFE_CODEPOINT);
  value = controls.value;
  redacted ||= controls.redacted;
  const quoted = maskQuotedSegments(value);
  value = quoted.value;
  redacted ||= quoted.redacted;
  for (const pattern of [URL_OR_EMAIL, ABSOLUTE_PATH, PRIVATE_ASSIGNMENT]) {
    const masked = maskMatches(value, pattern);
    value = masked.value;
    redacted ||= masked.redacted;
  }

  const matches = [];
  for (const phrase of STDERR_PHRASES.keys()) {
    let offset = 0;
    while (offset < value.length) {
      const start = value.indexOf(phrase, offset);
      if (start < 0) break;
      const end = start + phrase.length;
      const before = value[start - 1];
      const after = value[end];
      const hasSafeBoundaries = (before === undefined || !/[A-Za-z0-9_]/.test(before)) &&
        (after === undefined || !/[A-Za-z0-9_]/.test(after));
      if (hasSafeBoundaries) matches.push({ start, end, phrase });
      offset = end;
    }
  }
  matches.sort((left, right) => left.start - right.start || right.end - left.end);

  const parts = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    const gap = value.slice(cursor, match.start);
    if (/\S/.test(gap)) {
      parts.push(STDERR_REDACTION_MARKER);
      redacted = true;
    }
    parts.push(match.phrase);
    cursor = match.end;
  }
  if (/\S/.test(value.slice(cursor))) {
    parts.push(STDERR_REDACTION_MARKER);
    redacted = true;
  }
  if (parts.length === 0) {
    parts.push(STDERR_REDACTION_MARKER);
    redacted = true;
  }

  let output = '';
  let truncated = false;
  const writtenParts = [];
  for (const part of parts) {
    const next = output.length === 0 ? part : ' ' + part;
    if (Buffer.byteLength(output + next, 'utf8') > MAX_DIAGNOSTIC_LINE_BYTES) {
      truncated = true;
      break;
    }
    writtenParts.push(part);
    output += next;
  }
  if (truncated && redacted && !writtenParts.includes(STDERR_REDACTION_MARKER)) {
    while (writtenParts.length > 0 &&
        Buffer.byteLength(writtenParts.concat(STDERR_REDACTION_MARKER).join(' '), 'utf8') > MAX_DIAGNOSTIC_LINE_BYTES) {
      writtenParts.pop();
    }
    writtenParts.push(STDERR_REDACTION_MARKER);
    output = writtenParts.join(' ');
  }
  return { line: output, redacted, truncated };
}

export function sanitizeStderr(bytes, { truncated = false } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_STDERR_BYTES || typeof truncated !== 'boolean') {
    throw new TypeError('STDERR_INPUT_INVALID');
  }
  if (bytes.length === 0) {
    return {
      stderrCategories: ['UNKNOWN'], stderrLines: [], stderrTruncated: truncated,
      stderrRedacted: false, stderrStatus: truncated ? 'TRUNCATED' : 'EMPTY',
    };
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return {
      stderrCategories: ['UNKNOWN'], stderrLines: [STDERR_REDACTION_MARKER],
      stderrTruncated: truncated, stderrRedacted: true,
      stderrStatus: truncated ? 'TRUNCATED' : 'WITHHELD',
    };
  }

  const lines = text.split('\n');
  const categories = [];
  const stderrLines = [];
  let withheld = false;
  let considered = 0;
  let outputTruncated = truncated;
  let stderrRedacted = false;
  for (const sourceLine of lines) {
    const line = sourceLine.endsWith('\r') ? sourceLine.slice(0, -1) : sourceLine;
    if (line.length === 0) continue;
    considered += 1;
    if (considered > MAX_DIAGNOSTIC_LINES) {
      withheld = true;
      outputTruncated = true;
      break;
    }
    const category = STDERR_PHRASES.get(line);
    if (category) categories.push(category);
    else withheld = true;
    const projected = projectDiagnosticLine(sourceLine);
    stderrLines.push(projected.line);
    stderrRedacted ||= projected.redacted;
    outputTruncated ||= projected.truncated;
    withheld ||= projected.redacted;
  }
  if (considered === 0) {
    withheld = true;
    stderrRedacted = true;
    stderrLines.push(STDERR_REDACTION_MARKER);
  }

  if (withheld && categories.length < MAX_DIAGNOSTIC_CODES) categories.push('STDERR_WITHHELD');
  if (outputTruncated && categories.length < MAX_DIAGNOSTIC_CODES && !categories.includes('STDERR_WITHHELD')) {
    categories.push('STDERR_WITHHELD');
  }
  if (categories.length === 0) categories.push('UNKNOWN');
  return {
    stderrCategories: categories.slice(0, MAX_DIAGNOSTIC_CODES),
    stderrLines,
    stderrTruncated: outputTruncated,
    stderrRedacted,
    stderrStatus: outputTruncated ? 'TRUNCATED' : (withheld ? 'WITHHELD' : 'CLASSIFIED'),
  };
}

function errorDiagnostics(error) {
  return {
    error,
    stderrCategories: ['UNKNOWN'],
    stderrLines: [STDERR_REDACTION_MARKER],
    stderrTruncated: false,
    stderrRedacted: true,
    stderrStatus: 'WITHHELD',
  };
}

function emit(value, exitCode = 0) {
  process.stdout.write(JSON.stringify(value) + '\n');
  process.exitCode = exitCode;
}

function readBoundedStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let retained = 0;
    let truncated = false;
    let settled = false;

    const cleanupReadListeners = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
    };
    const onClose = () => process.stdin.removeListener('error', onError);
    const finish = (result, error, closeInput = false) => {
      if (settled) return;
      settled = true;
      process.stdin.pause();
      cleanupReadListeners();
      if (error) {
        process.stdin.destroy();
        reject(error);
      } else {
        if (closeInput) process.stdin.destroy();
        resolve(result);
      }
    };
    const onEnd = () => finish({ bytes: Buffer.concat(chunks, retained), truncated });
    const onError = () => finish(null, new Error('INPUT_UNAVAILABLE'), true);
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_STDERR_BYTES - retained;
      if (remaining > 0) {
        const kept = Buffer.from(bytes.subarray(0, remaining));
        chunks.push(kept);
        retained += kept.length;
      }
      if (bytes.length > remaining) {
        truncated = true;
        finish({ bytes: Buffer.concat(chunks, retained), truncated }, null, true);
      }
    };

    process.stdin.once('close', onClose);
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.on('error', onError);
    process.stdin.resume();
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node sanitize-browser-stderr.mjs [--help] < stderr-bytes\n');
    return;
  }
  if (args.length !== 0) {
    emit(errorDiagnostics('INVALID_ARGUMENTS'), 2);
    return;
  }
  try {
    const input = await readBoundedStdin();
    emit(sanitizeStderr(input.bytes, { truncated: input.truncated }));
  } catch {
    emit(errorDiagnostics('INPUT_UNAVAILABLE'), 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
