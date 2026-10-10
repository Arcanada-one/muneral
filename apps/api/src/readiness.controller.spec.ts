import 'reflect-metadata';
import { describe, it, expect } from '@jest/globals';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HealthController } from './health.controller.js';
import { HEALTH_ROUTE_EXCLUSIONS, ReadinessController } from './readiness.controller.js';
import { ReadinessProbe } from './readiness.probe.js';
import type { PrismaClient } from '@prisma/client';

async function appWith(probe: ReadinessProbe) {
  const module = await Test.createTestingModule({
    controllers: [HealthController, ReadinessController],
    providers: [{ provide: ReadinessProbe, useValue: probe }],
  }).compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix('api/v1', { exclude: HEALTH_ROUTE_EXCLUSIONS });
  await app.init();
  return app;
}

describe('readiness HTTP contract', () => {
  it('reports ready with build identity when the database probe succeeds', async () => {
    const probe = ReadinessProbe.withClient({ $queryRaw: async () => [], $disconnect: async () => undefined } as unknown as PrismaClient);
    const app = await appWith(probe);
    try {
      const response = await request(app.getHttpServer()).get('/health/ready').expect(200);
      expect(response.body).toMatchObject({ status: 'ready', checks: { database: 'ok' } });
      expect(response.body).toHaveProperty('build.sha');
      await request(app.getHttpServer()).get('/health').expect(200);
    } finally { await app.close(); }
  });

  it('real refused database connection returns 503 while liveness stays 200', async () => {
    const previous = process.env.DATABASE_URL;
    // Local TCP discard port: a genuine driver connection failure, no mock or real data.
    process.env.DATABASE_URL = 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic';
    const app = await appWith(new ReadinessProbe());
    try {
      const started = Date.now();
      const response = await request(app.getHttpServer()).get('/health/ready').expect(503);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(response.body).toEqual({ status: 'not_ready', checks: { database: 'unavailable' } });
      expect(JSON.stringify(response.body)).not.toMatch(/synthetic|127\.0\.0\.1|postgres|Prisma/);
      await request(app.getHttpServer()).get('/health').expect(200);
      await request(app.getHttpServer()).get('/api/v1/health/ready').expect(404);
    } finally {
      await app.close();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});
