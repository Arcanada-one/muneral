import 'reflect-metadata';
import { describe, it, expect, jest } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { createDisposablePostgres } from './support/disposable-postgres.js';
import { HealthController } from '../src/health.controller.js';
import { HEALTH_ROUTE_EXCLUSIONS, ReadinessController } from '../src/readiness.controller.js';
import { ReadinessProbe } from '../src/readiness.probe.js';

jest.setTimeout(120_000);

describe('resident HTTP service across database removal', () => {
  it('DB up => ready 200; owned DB removed => ready 503, live 200', async () => {
    const pg = createDisposablePostgres('readiness');
    const previous = process.env.DATABASE_URL;
    let app: TestingModule | undefined;
    let httpApp: import('@nestjs/common').INestApplication | undefined;
    let removed = false;
    try {
      await pg.start();
      process.env.DATABASE_URL = pg.url();
      app = await Test.createTestingModule({
        controllers: [HealthController, ReadinessController], providers: [ReadinessProbe],
      }).compile();
      httpApp = app.createNestApplication();
      httpApp.setGlobalPrefix('api/v1', { exclude: HEALTH_ROUTE_EXCLUSIONS });
      await httpApp.init();
      const ready = await request(httpApp.getHttpServer()).get('/health/ready').expect(200);
      expect(ready.body.checks.database).toBe('ok');
      await request(httpApp.getHttpServer()).get('/health').expect(200);
      await pg.stop();
      removed = true;
      const start = Date.now();
      const down = await request(httpApp.getHttpServer()).get('/health/ready').expect(503);
      expect(Date.now() - start).toBeLessThan(2000);
      expect(down.body).toEqual({ status: 'not_ready', checks: { database: 'unavailable' } });
      await request(httpApp.getHttpServer()).get('/health').expect(200);
    } finally {
      if (httpApp) await httpApp.close();
      else if (app) await app.close();
      if (!removed) await pg.stop();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});
