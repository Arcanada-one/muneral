import { Injectable } from '@nestjs/common';
import { KanbanGateway } from './kanban.gateway.js';
import type { KanbanEvent } from './kanban.gateway.js';
import { scopeOutboxEventsByMembership } from '../plan-graph/project-membership.js';
import { ProjectMembershipService } from '../plan-graph/project-membership.service.js';

/**
 * KanbanService — thin wrapper around KanbanGateway.
 * Injected into TasksService and other services that need to push WS events.
 *
 * KCLIVE-10 AC4: client outbox delivery is filtered by current member project
 * ids via {@link scopeOutboxEventsByMembership} before emit (production call-site).
 */
@Injectable()
export class KanbanService {
  constructor(
    private readonly gateway: KanbanGateway,
    private readonly projectMembership: ProjectMembershipService,
  ) {}

  notify(projectId: string, event: KanbanEvent, payload: unknown): void {
    this.gateway.emit(projectId, event, payload);
  }

  /**
   * Deliver outbox/event payloads only to projects the caller currently
   * belongs to. Events outside the membership set are withheld (not emitted).
   */
  async deliverScopedOutboxEvents<
    T extends { projectId: string; eventId: string },
  >(
    userId: string,
    events: T[],
  ): Promise<{ delivered: T[]; withheld: T[] }> {
    const memberProjectIds =
      await this.projectMembership.listMemberProjectIds(userId);
    const scoped = scopeOutboxEventsByMembership(events, memberProjectIds);
    for (const event of scoped.delivered) {
      this.gateway.emit(event.projectId, 'task:updated', event);
    }
    return scoped;
  }
}
