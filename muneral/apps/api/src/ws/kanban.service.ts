import { Injectable } from '@nestjs/common';
import { KanbanGateway, KanbanEvent } from './kanban.gateway';

/**
 * KanbanService — thin wrapper around KanbanGateway.
 * Injected into TasksService and other services that need to push WS events.
 */
@Injectable()
export class KanbanService {
  constructor(private readonly gateway: KanbanGateway) {}

  notify(projectId: string, event: KanbanEvent, payload: unknown): void {
    this.gateway.emit(projectId, event, payload);
  }
}
