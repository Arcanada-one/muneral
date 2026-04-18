import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KanbanWsClient, createKanbanWsClient, type KanbanWsOptions } from '@/lib/ws/kanban';

// Mock socket.io-client — each io() call returns a fresh mock socket
vi.mock('socket.io-client', () => {
  type Handler = (...args: unknown[]) => void;

  function createMockSocket() {
    const eventHandlers: Record<string, Handler[]> = {};
    return {
      on: vi.fn((event: string, cb: Handler) => {
        if (!eventHandlers[event]) eventHandlers[event] = [];
        eventHandlers[event].push(cb);
      }),
      disconnect: vi.fn(),
      connect: vi.fn(),
      _emit(event: string, ...args: unknown[]) {
        (eventHandlers[event] ?? []).forEach((cb) => cb(...args));
      },
    };
  }

  let currentSocket: ReturnType<typeof createMockSocket> | null = null;

  return {
    io: vi.fn(() => {
      currentSocket = createMockSocket();
      return currentSocket;
    }),
    get __currentSocket() {
      return currentSocket;
    },
  };
});

import * as socketModule from 'socket.io-client';
const mockIo = socketModule.io as ReturnType<typeof vi.fn>;

type MockSocket = {
  on: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  _emit: (event: string, ...args: unknown[]) => void;
};

function getMockSocket(): MockSocket {
  return (socketModule as unknown as { __currentSocket: MockSocket }).__currentSocket;
}

describe('KanbanWsClient', () => {
  let client: KanbanWsClient;
  const onEvent = vi.fn();
  const onConnect = vi.fn();
  const onDisconnect = vi.fn();
  const onFallbackToPolling = vi.fn();
  const onPollingCancelled = vi.fn();

  const opts: KanbanWsOptions = {
    apiUrl: 'http://localhost:3500',
    workspaceId: 'ws-1',
    accessToken: 'test-jwt',
    onEvent,
    onConnect,
    onDisconnect,
    onFallbackToPolling,
    onPollingCancelled,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    client = new KanbanWsClient(opts);
  });

  afterEach(() => {
    client.disconnect();
  });

  it('calls io() with correct parameters on connect', () => {
    client.connect();
    expect(mockIo).toHaveBeenCalledWith(
      'http://localhost:3500',
      expect.objectContaining({
        path: '/ws',
        query: { workspaceId: 'ws-1' },
        auth: { token: 'test-jwt' },
      }),
    );
  });

  it('sets connected to true when socket connects', () => {
    client.connect();
    const socket = getMockSocket();
    socket._emit('connect');
    expect(client.connected).toBe(true);
  });

  it('calls onConnect callback when socket connects', () => {
    client.connect();
    const socket = getMockSocket();
    socket._emit('connect');
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('sets connected to false when socket disconnects', () => {
    client.connect();
    const socket = getMockSocket();
    socket._emit('connect');
    socket._emit('disconnect');
    expect(client.connected).toBe(false);
  });

  it('calls onDisconnect callback when socket disconnects', () => {
    client.connect();
    const socket = getMockSocket();
    socket._emit('connect');
    socket._emit('disconnect');
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('forwards task:moved event to onEvent handler', () => {
    client.connect();
    const socket = getMockSocket();
    const eventData = {
      taskId: 'task-1',
      fromStatus: 'todo',
      toStatus: 'in_progress',
      actorId: 'user-1',
      actorName: 'Alice',
      timestamp: new Date().toISOString(),
    };
    socket._emit('task:moved', eventData);
    expect(onEvent).toHaveBeenCalledWith({ type: 'task:moved', data: eventData });
  });

  it('forwards task:updated event to onEvent handler', () => {
    client.connect();
    const socket = getMockSocket();
    const eventData = {
      taskId: 'task-2',
      changes: { title: 'New title' },
      actorId: 'agent-1',
      timestamp: new Date().toISOString(),
    };
    socket._emit('task:updated', eventData);
    expect(onEvent).toHaveBeenCalledWith({ type: 'task:updated', data: eventData });
  });

  it('forwards task:created event to onEvent handler', () => {
    client.connect();
    const socket = getMockSocket();
    const eventData = {
      taskId: 'task-3',
      title: 'New task',
      status: 'todo',
      projectId: 'proj-1',
      timestamp: new Date().toISOString(),
    };
    socket._emit('task:created', eventData);
    expect(onEvent).toHaveBeenCalledWith({ type: 'task:created', data: eventData });
  });

  it('calls onPollingCancelled when reconnecting after polling', () => {
    client.connect();
    const socket = getMockSocket();
    // Reconnect after having been disconnected
    socket._emit('connect');
    expect(onPollingCancelled).toHaveBeenCalledTimes(1);
  });

  it('polling property is false initially', () => {
    expect(client.polling).toBe(false);
  });

  it('disconnect clears socket and sets connected to false', () => {
    client.connect();
    const socket = getMockSocket();
    socket._emit('connect');
    client.disconnect();
    expect(client.connected).toBe(false);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('createKanbanWsClient factory creates a KanbanWsClient instance', () => {
    const instance = createKanbanWsClient(opts);
    expect(instance).toBeInstanceOf(KanbanWsClient);
    instance.disconnect();
  });
});
