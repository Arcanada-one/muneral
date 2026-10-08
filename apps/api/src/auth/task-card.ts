import { ForbiddenException } from '@nestjs/common';

/**
 * DEC-AUP-0134: the single refusal of `GET /tasks/:taskId` for an agent key.
 *
 * Unknown id, malformed id, a task of another workspace, a task of a project the
 * key holds no grant for, an expired grant, a grant without `card` — all answer
 * this exact body. It carries no id, no project and no code: an id-keyed route
 * that said "expired" for some ids and "not found" for others would be an
 * existence oracle, and `GRANT_EXPIRED` stays on the project-keyed index route
 * where the caller names the project itself.
 */
export const TASK_CARD_REFUSAL_MESSAGE = 'This task card is not available to this key.';

export const taskCardRefusal = () => new ForbiddenException(TASK_CARD_REFUSAL_MESSAGE);

/** DEC-AUP-0134: the activity action one redacted card read records. */
export const TASK_CARD_READ_ACTION = 'task:card_read';

/** The ETag stand-in for the redacted view: never a valid contract digest, so it
 *  cannot collide with the full view's tag, and independent of the digest. */
export const REDACTED_VIEW_ETAG_TAG = 'view:redacted';
