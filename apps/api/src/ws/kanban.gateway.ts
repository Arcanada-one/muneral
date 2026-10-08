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
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

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
  @WebSocketServer()
  server: Server;

  constructor(private readonly jwtService: JwtService, private readonly prisma: PrismaService) {}

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

      if (payload.type !== 'access' || typeof payload.sub !== 'string' || !payload.sub) {
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
  ): Promise<void> {
    if (typeof data?.projectId !== 'string') return;
    if (await this.mayReadProject(data.projectId, socket.data['userId'])) {
      await socket.join(`project:${data.projectId}`);
    } else {
      await socket.leave(`project:${data.projectId}`);
    }
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
  async emit(projectId: string, event: KanbanEvent, payload: unknown): Promise<void> {
    const room = `project:${projectId}`;
    const sockets = await this.server.in(room).fetchSockets();
    // Room admission is insufficient: membership or the project workspace
    // may have changed after join. Never broadcast without a fresh check.
    for (const socket of sockets) {
      if (await this.mayReadProject(projectId, socket.data['userId'])) {
        socket.emit(event, payload);
      } else {
        await socket.leave(room);
      }
    }
  }

  private async mayReadProject(projectId: string, userId: unknown): Promise<boolean> {
    if (typeof userId !== 'string' || !userId) return false;
    try {
      return !!await this.prisma.project.findFirst({
        where: { id: projectId, workspace: { members: { some: { userId } } } },
        select: { id: true },
      });
    } catch {
      // An unavailable authorization store cannot authorize a disclosure.
      return false;
    }
  }
}
