// MUN-0040: minimal NestJS wiring for the MUN-0020 execution-authority
// service. The service itself stays framework-free (see index.ts) — this
// module only supplies the two small runtime dependencies (Clock, IdSource)
// it was written to receive, and exposes it as a singleton provider so
// application code (TaskExecutionRecorderService) can inject it instead of
// constructing it by hand, the way every existing test does.
import { Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ExecutionAuthorityService } from './execution-authority.service';
import type { Clock, IdSource } from './execution-authority.types';

export const SYSTEM_CLOCK: Clock = { now: () => new Date() };
export const UUID_ID_SOURCE: IdSource = { generate: () => randomUUID() };

@Module({
  providers: [
    {
      provide: ExecutionAuthorityService,
      useValue: new ExecutionAuthorityService(SYSTEM_CLOCK, UUID_ID_SOURCE),
    },
  ],
  exports: [ExecutionAuthorityService],
})
export class ExecutionAuthorityModule {}
