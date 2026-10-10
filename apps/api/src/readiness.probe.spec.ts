import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { ReadinessProbe, READINESS_TIMEOUT_MS } from './readiness.probe.js';
import type { PrismaClient } from '@prisma/client';

function fixture(run: () => Promise<unknown>) {
  const query = jest.fn(run);
  const disconnect = jest.fn(async () => undefined);
  const probe = ReadinessProbe.withClient({ $queryRaw: query, $disconnect: disconnect } as unknown as PrismaClient);
  return { probe, query, disconnect };
}

afterEach(() => { jest.useRealTimers(); });

describe('bounded read-only database readiness', () => {
  it('executes only SELECT 1 and disconnects its owned client', async () => {
    const { probe, query, disconnect } = fixture(async () => [{ '?column?': 1 }]);
    await probe.check();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toEqual([['SELECT 1']]);
    await probe.onModuleDestroy();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('propagates database failure and allows a later recovery', async () => {
    const { probe, query } = fixture(async () => { throw new Error('private database detail'); });
    await expect(probe.check()).rejects.toThrow('private database detail');
    query.mockImplementation(async () => []);
    await expect(probe.check()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('times out stalled work and coalesces concurrent and subsequent probes', async () => {
    jest.useFakeTimers();
    const { probe, query } = fixture(() => new Promise(() => undefined));
    const first = expect(probe.check()).rejects.toThrow('readiness deadline');
    const second = expect(probe.check()).rejects.toThrow('readiness deadline');
    await jest.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);
    await Promise.all([first, second]);
    const third = expect(probe.check()).rejects.toThrow('readiness deadline');
    await jest.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);
    await third;
    expect(query).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
