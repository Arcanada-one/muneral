import { Injectable, Logger } from '@nestjs/common';
import { KanbanGateway } from './kanban.gateway.js';
import type { KanbanEvent } from './kanban.gateway.js';

/**
 * KanbanService — thin wrapper around KanbanGateway.
 * Injected into TasksService and other services that need to push WS events.
 */
@Injectable()
export class KanbanService {
  private readonly logger = new Logger(KanbanService.name);
  constructor(private readonly gateway: KanbanGateway) {}

  notify(projectId: string, event: KanbanEvent, payload: unknown): void {
    void this.gateway.emit(projectId, event, payload).catch(() => {
      this.logger.warn('Kanban event delivery unavailable');
    });
  }
}
