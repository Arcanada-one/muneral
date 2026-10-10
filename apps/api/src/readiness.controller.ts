import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { buildInfo } from './build-info.js';
import { ReadinessProbe } from './readiness.probe.js';

export const HEALTH_ROUTE_EXCLUSIONS = ['health', 'health/routes', 'health/ready'];

@Controller('health')
export class ReadinessController {
  constructor(private readonly probe: ReadinessProbe) {}

  @Get('ready')
  async check(): Promise<{ status: string; build: ReturnType<typeof buildInfo>; checks: { database: string } }> {
    try {
      await this.probe.check();
      return { status: 'ready', build: buildInfo(), checks: { database: 'ok' } };
    } catch {
      // Never expose connection strings, database errors or host information.
      throw new ServiceUnavailableException({ status: 'not_ready', checks: { database: 'unavailable' } });
    }
  }
}
