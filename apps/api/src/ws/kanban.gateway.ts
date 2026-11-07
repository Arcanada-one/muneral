import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Injectable, Logger } from '@nestjs/common';
import { maySubscribeToProject } from '../plan-graph/project-membership.js';
import { ProjectMembershipService } from '../plan-graph/project-membership.service.js';

export type KanbanEvent =
  | 'task:moved'
  | 'task:updated'
  | 'task:assigned'
  | 'task:created'
  | 'task:deleted';

/**
 * KanbanGateway — Socket.io gateway for real-time Kanban board updates.
 * Auth: validate JWT from socket.handshake.auth.token on connect.
 * Rooms: project:{projectId} — clients subscribe per-project.
 *
 * KCLIVE-10 AC4: join:project requires current workspace membership of the
 * project's workspace. A logged-in socket alone is insufficient.
 */
@Injectable()
@WebSocketGateway({
  cors: {
    origin: process.env.WEB_URL ?? 'https://app.muneral.com',
    credentials: true,
  },
  namespace: '/kanban',
})
export class KanbanGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(KanbanGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly projectMembership: ProjectMembershipService,
  ) {}

  async handleConnection(socket: Socket): Promise<void> {
    const token = socket.handshake.auth['token'] as string | undefined;
    if (!token) {
      socket.disconnect(true);
      return;
    }

    try {
      const payload = this.jwtService.verify(token, {
        secret: process.env.JWT_SECRET ?? 'change-me-in-production',
      }) as { sub: string; type: string };

      if (payload.type !== 'access') {
        socket.disconnect(true);
        return;
      }

      // Attach userId to socket data for room management
      socket.data['userId'] = payload.sub;
    } catch {
      socket.disconnect(true);
    }
  }

  handleDisconnect(_socket: Socket): void {
    // Cleanup is automatic — Socket.io removes from rooms on disconnect
  }

  @SubscribeMessage('join:project')
  async handleJoinProject(
    @MessageBody() data: { projectId: string },
    @ConnectedSocket() socket: Socket,
  ): Promise<{ ok: boolean; reason: string }> {
    const userId = socket.data['userId'] as string | undefined;
    const projectId = data?.projectId;

    const membership = await this.projectMembership.lookup(userId, projectId);
    const decision = maySubscribeToProject(userId, projectId, membership);
    if (!decision.allowed) {
      this.logger.warn(
        `join:project refused user=${userId ?? 'none'} project=${projectId ?? 'none'} reason=${decision.reason}`,
      );
      return { ok: false, reason: decision.reason };
    }

    await socket.join(`project:${projectId}`);
    return { ok: true, reason: decision.reason };
  }

  @SubscribeMessage('leave:project')
  handleLeaveProject(
    @MessageBody() data: { projectId: string },
    @ConnectedSocket() socket: Socket,
  ): void {
    void socket.leave(`project:${data.projectId}`);
  }

  /**
   * Emit a Kanban event to all clients watching a project.
   * Called by KanbanService after every state-changing operation.
   */
  emit(projectId: string, event: KanbanEvent, payload: unknown): void {
    this.server.to(`project:${projectId}`).emit(event, payload);
  }
}
