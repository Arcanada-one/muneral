const PAGE_LIMIT = 20;

export const TASK_IDS = Object.freeze({
  populated: '11111111-1111-4111-8111-111111111111',
  empty: '22222222-2222-4222-8222-222222222222',
});

const stats = {
  getAttempts: 0,
  successfulGets: 0,
  rejectedCalls: 0,
  mutationAttempts: 0,
  requests: [],
};

function uuid(sequence) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function activityRow(sequence, taskId, actorType, action, createdAt) {
  return {
    id: uuid(sequence),
    taskId,
    actorId: uuid(sequence + 10_000),
    actorName: `Synthetic actor ${String(sequence).padStart(2, '0')}`,
    actorType,
    action,
    payload: action === 'task:status_changed'
      ? { from: 'todo', to: 'in_progress' }
      : { body: `Synthetic activity ${String(sequence).padStart(2, '0')}` },
    createdAt,
  };
}

const populatedPageOne = Array.from({ length: PAGE_LIMIT }, (_, offset) => {
  const sequence = offset + 1;
  const statusChange = sequence <= 8;
  return activityRow(
    sequence,
    TASK_IDS.populated,
    statusChange ? 'agent' : (sequence % 2 === 0 ? 'human' : 'agent'),
    statusChange ? 'task:status_changed' : 'comment',
    sequence === 1 ? '2026-10-24T01:02:03.456Z' : `2026-10-24T01:02:${String(sequence).padStart(2, '0')}.000Z`,
  );
});

const populatedPageTwo = Array.from({ length: 7 }, (_, offset) => {
  const sequence = offset + PAGE_LIMIT + 1;
  const statusChange = offset < 3;
  return activityRow(
    sequence,
    TASK_IDS.populated,
    statusChange ? 'agent' : 'human',
    statusChange ? 'task:status_changed' : 'comment',
    `2026-10-24T02:03:${String(offset + 1).padStart(2, '0')}.000Z`,
  );
});

const responsePages = new Map([
  [`${TASK_IDS.populated}:1`, { data: populatedPageOne, total: 27, page: 1, limit: PAGE_LIMIT }],
  [`${TASK_IDS.populated}:2`, { data: populatedPageTwo, total: 27, page: 2, limit: PAGE_LIMIT }],
  [`${TASK_IDS.empty}:1`, { data: [], total: 0, page: 1, limit: PAGE_LIMIT }],
]);

function rejectUnexpectedCall({ mutation = false } = {}) {
  stats.rejectedCalls += 1;
  if (mutation) stats.mutationAttempts += 1;
  return Promise.reject(new Error('Synthetic activity adapter rejected an unexpected call'));
}

function parseActivityRequest(requestPath) {
  if (typeof requestPath !== 'string' || !requestPath.startsWith('/')) return undefined;
  let requestUrl;
  try {
    requestUrl = new URL(requestPath, 'http://activity-fixture.invalid');
  } catch {
    return undefined;
  }
  if (requestUrl.origin !== 'http://activity-fixture.invalid' || requestUrl.hash !== '') return undefined;
  const match = /^\/tasks\/([0-9a-f-]{36})\/activity$/.exec(requestUrl.pathname);
  if (!match) return undefined;
  const taskId = match[1];
  const pageText = requestUrl.searchParams.get('page');
  const limitText = requestUrl.searchParams.get('limit');
  if (
    taskId !== TASK_IDS.populated && taskId !== TASK_IDS.empty ||
    !/^[1-9][0-9]*$/.test(pageText ?? '') ||
    limitText !== String(PAGE_LIMIT) ||
    [...requestUrl.searchParams.keys()].length !== 2 ||
    requestUrl.search !== `?page=${pageText}&limit=${PAGE_LIMIT}`
  ) return undefined;
  const page = Number(pageText);
  if (!Number.isSafeInteger(page) || !responsePages.has(`${taskId}:${page}`)) return undefined;
  return { taskId, page };
}

export function getFixtureStats() {
  return {
    getAttempts: stats.getAttempts,
    successfulGets: stats.successfulGets,
    rejectedCalls: stats.rejectedCalls,
    mutationAttempts: stats.mutationAttempts,
    requests: stats.requests.map(({ taskId, page }) => ({ taskId, page })),
  };
}

const apiClient = Object.freeze({
  async get(requestPath) {
    stats.getAttempts += 1;
    const request = parseActivityRequest(requestPath);
    if (!request) return rejectUnexpectedCall();
    const response = responsePages.get(`${request.taskId}:${request.page}`);
    if (!response) return rejectUnexpectedCall();
    stats.successfulGets += 1;
    stats.requests.push(request);
    return { data: structuredClone(response) };
  },
  post() { return rejectUnexpectedCall({ mutation: true }); },
  put() { return rejectUnexpectedCall({ mutation: true }); },
  patch() { return rejectUnexpectedCall({ mutation: true }); },
  delete() { return rejectUnexpectedCall({ mutation: true }); },
});

export default apiClient;

export const __test = Object.freeze({ parseActivityRequest, responsePages, stats });
