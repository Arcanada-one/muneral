import { io, Socket } from 'socket.io-client';
import type { TaskStatus } from '@muneral/types';

export interface TaskMovedEvent {
  taskId: string;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
  actorId: string;
  actorName: string;
  timestamp: string;
}

export interface TaskUpdatedEvent {
  taskId: string;
  changes: Record<string, unknown>;
  actorId: string;
  timestamp: string;
}

export interface TaskCreatedEvent {
  taskId: string;
  title: string;
  status: TaskStatus;
  projectId: string;
  timestamp: string;
}

export type KanbanEvent =
  | { type: 'task:moved'; data: TaskMovedEvent }
  | { type: 'task:updated'; data: TaskUpdatedEvent }
  | { type: 'task:created'; data: TaskCreatedEvent };

export type KanbanEventHandler = (event: KanbanEvent) => void;

export interface KanbanWsOptions {
  apiUrl: string;
  workspaceId: string;
  accessToken: string;
  onEvent: KanbanEventHandler;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onFallbackToPolling?: () => void;
  onPollingCancelled?: () => void;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 2000;

export class KanbanWsClient {
  private socket: Socket | null = null;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private isConnected = false;
  private readonly options: KanbanWsOptions;

  constructor(options: KanbanWsOptions) {
    this.options = options;
  }

  connect(): void {
    const { apiUrl, workspaceId, accessToken } = this.options;

    this.socket = io(apiUrl, {
      path: '/ws',
      query: { workspaceId },
      auth: { token: accessToken },
      reconnection: false, // We manage reconnection manually
      transports: ['websocket'],
    });

    this.socket.on('connect', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.stopPolling();
      this.options.onConnect?.();
      this.options.onPollingCancelled?.();
    });

    this.socket.on('disconnect', () => {
      this.isConnected = false;
      this.options.onDisconnect?.();
      this.scheduleReconnect();
    });

    this.socket.on('connect_error', () => {
      this.isConnected = false;
      this.scheduleReconnect();
    });

    this.socket.on('task:moved', (data: TaskMovedEvent) => {
      this.options.onEvent({ type: 'task:moved', data });
    });

    this.socket.on('task:updated', (data: TaskUpdatedEvent) => {
      this.options.onEvent({ type: 'task:updated', data });
    });

    this.socket.on('task:created', (data: TaskCreatedEvent) => {
      this.options.onEvent({ type: 'task:created', data });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.startPolling();
      return;
    }

    const delay = RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    setTimeout(() => {
      if (!this.isConnected) {
        this.socket?.connect();
      }
    }, delay);
  }

  private startPolling(): void {
    if (this.pollingTimer !== null) return;
    this.options.onFallbackToPolling?.();
    // Polling interval — callers use TanStack Query refetchInterval: 10000
    // We emit a synthetic event to signal polling mode
    this.pollingTimer = setInterval(() => {
      // No-op: TanStack Query handles actual polling via refetchInterval
      // This timer tracks the polling state
    }, 10_000);
  }

  private stopPolling(): void {
    if (this.pollingTimer !== null) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  get connected(): boolean {
    return this.isConnected;
  }

  get polling(): boolean {
    return this.pollingTimer !== null;
  }

  disconnect(): void {
    this.stopPolling();
    this.socket?.disconnect();
    this.socket = null;
    this.isConnected = false;
  }
}

/**
 * Factory function for creating a KanbanWsClient.
 * Decoupled from constructor for easier testing.
 */
export function createKanbanWsClient(options: KanbanWsOptions): KanbanWsClient {
  return new KanbanWsClient(options);
}
