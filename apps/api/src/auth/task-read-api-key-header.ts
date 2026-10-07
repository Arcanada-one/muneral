import { SetMetadata, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

const TASK_READ_API_KEY_HEADER = 'task-read-api-key-header';

/** Opt-in belongs to the exact task GET handler, never a controller. */
export const TaskReadApiKeyHeader = () => SetMetadata(TASK_READ_API_KEY_HEADER, true);

export function isTaskReadKeyHandler(req: Request, handler: object | undefined): boolean {
  return req.method === 'GET' && !!handler &&
    Reflect.getOwnMetadata(TASK_READ_API_KEY_HEADER, handler) === true;
}

/** Select one credential without mutating headers or falling back after denial. */
export function taskReadApiKey(req: Request, handler: object | undefined): string | undefined {
  const alias = req.headers['x-api-key'];
  const count = (name: string) => (req.rawHeaders ?? []).filter(
    (_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name,
  ).length;
  if (alias === undefined) {
    if (isTaskReadKeyHandler(req, handler) && count('authorization') > 1) {
      throw new UnauthorizedException('One authorization credential is required');
    }
    return undefined;
  }
  if (!isTaskReadKeyHandler(req, handler) || req.headers.authorization !== undefined ||
      count('x-api-key') > 1 || count('authorization') > 0 ||
      typeof alias !== 'string' || !/^mun_sk_[A-Za-z0-9_]+$/.test(alias)) {
    throw new UnauthorizedException('One API key is required on the scoped task GET');
  }
  return alias;
}
