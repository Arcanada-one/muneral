import { Controller, Get } from '@nestjs/common';

/** Simple health check endpoint for Docker/load balancer probes. */
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string; version: string } {
    return { status: 'ok', version: '0.1.0' };
  }
}
