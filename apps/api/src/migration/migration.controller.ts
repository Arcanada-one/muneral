// MUN-0040: HTTP surface for the migration import path.
//
// Writes are agent-only (ApiKeyGuard): a migration producer is an automated
// client, and the activity entries it leaves must carry actor_type 'agent'.
// Reads accept either a human JWT or an agent key (JwtOrApiKeyGuard), because
// readback after a lost response is exactly what an operator does by hand.

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Actor } from '@muneral/types';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { ActorInterceptor } from '../common/interceptors/actor.interceptor';
import { CreateBatchDto } from './dto/create-batch.dto';
import { CreateDecisionDto } from './dto/create-decision.dto';
import { CreateTransitionDto } from './dto/create-transition.dto';
import { CreateWorkItemDto } from './dto/create-work-item.dto';
import { MigrationService } from './migration.service';

type ActorRequest = Request & { actor: Actor };

@Controller('migration')
@UseInterceptors(ActorInterceptor)
export class MigrationController {
  constructor(private readonly migration: MigrationService) {}

  // --- batches ------------------------------------------------------------

  /** 201 when the batch was created, 200 when the key replayed. */
  @Post('batches')
  @UseGuards(ApiKeyGuard)
  async createBatch(
    @Body() dto: CreateBatchDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, batch } = await this.migration.createBatch(dto);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return batch;
  }

  @Get('batches/:batchId')
  @UseGuards(JwtOrApiKeyGuard)
  getBatch(@Param('batchId', ParseUUIDPipe) batchId: string) {
    return this.migration.getBatch(batchId);
  }

  @Post('batches/:batchId/commit')
  @UseGuards(ApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  commitBatch(@Param('batchId', ParseUUIDPipe) batchId: string) {
    return this.migration.commitBatch(batchId);
  }

  // --- work items ---------------------------------------------------------

  /** 201 on the first import of an idempotency key, 200 on its replay. */
  @Post('work-items')
  @UseGuards(ApiKeyGuard)
  async createWorkItem(
    @Body() dto: CreateWorkItemDto,
    @Req() req: ActorRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { replayed, body } = await this.migration.createWorkItem(dto, req.actor);
    res.status(replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return body;
  }

  /**
   * The searchable-alias lookup. Declared before `by-legacy/:ns/:id` only for
   * readability — the two paths cannot collide, they differ in their first
   * segment.
   */
  @Get('work-items/search')
  @UseGuards(JwtOrApiKeyGuard)
  search(@Query('legacyId') legacyId?: unknown) {
    // The query parser is `extended`, so `?legacyId[]=a&legacyId[]=b` arrives
    // as an array and `?legacyId[x]=1` as an object. Handing either to Prisma
    // is an untyped 500 on an endpoint anyone with a key can call.
    if (legacyId !== undefined && typeof legacyId !== 'string') {
      throw new BadRequestException({
        code: 'INVALID_QUERY',
        message: 'legacyId must be a single string value.',
        parameter: 'legacyId',
      });
    }
    return this.migration.searchByLegacyId(legacyId ?? '');
  }

  /**
   * Express has already percent-decoded route params, so this must NOT decode
   * again: a second pass turns `DISCOUNT-50%25` into `DISCOUNT-50%` and then
   * throws `URIError` (an untyped 500), and turns `foo%2520bar` into `foo bar`
   * and answers a spurious 404. This is the readback path — the one where a
   * wrong answer costs the most.
   */
  @Get('work-items/by-legacy/:sourceNamespace/:legacyId')
  @UseGuards(JwtOrApiKeyGuard)
  getByLegacy(
    @Param('sourceNamespace') sourceNamespace: string,
    @Param('legacyId') legacyId: string,
  ) {
    return this.migration.getWorkItemByLegacy(sourceNamespace, legacyId);
  }

  @Post('work-items/:taskId/transitions')
  @UseGuards(ApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  transition(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: CreateTransitionDto,
    @Req() req: ActorRequest,
  ) {
    return this.migration.transition(taskId, dto, req.actor).then((r) => r.body);
  }

  // --- identity decisions -------------------------------------------------

  @Post('identities/:identityId/decisions')
  @UseGuards(ApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  decide(
    @Param('identityId', ParseUUIDPipe) identityId: string,
    @Body() dto: CreateDecisionDto,
    @Req() req: ActorRequest,
  ) {
    return this.migration.decide(identityId, dto, req.actor);
  }

  @Get('identities/:identityId/mappings')
  @UseGuards(JwtOrApiKeyGuard)
  mappings(@Param('identityId', ParseUUIDPipe) identityId: string) {
    return this.migration.getReverseMapping(identityId);
  }
}
