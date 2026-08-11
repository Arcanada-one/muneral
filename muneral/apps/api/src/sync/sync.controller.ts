import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  UseInterceptors,
  Header,
} from '@nestjs/common';
import { SyncService } from './sync.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { ActorInterceptor } from '../common/interceptors/actor.interceptor';

/**
 * Sync controller — Datarim tasks.md import/export.
 */
@Controller('sync')
@UseInterceptors(ActorInterceptor)
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  /** Export project tasks in Datarim tasks.md format */
  @Get('datarim/:projectId')
  @UseGuards(JwtAuthGuard)
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  async exportDatarim(@Param('projectId') projectId: string): Promise<string> {
    return this.syncService.exportDatarim(projectId);
  }

  /** Import tasks from Datarim markdown — agents or humans */
  @Post('datarim/:projectId/import')
  @UseGuards(ApiKeyGuard)
  async importDatarim(
    @Param('projectId') projectId: string,
    @Body() body: { markdown: string },
  ) {
    return this.syncService.importDatarim(projectId, body.markdown);
  }
}
