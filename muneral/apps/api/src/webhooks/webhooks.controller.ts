import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { CreateWebhookDto } from './dto/create-webhook.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActorInterceptor } from '../common/interceptors/actor.interceptor';

/**
 * Webhook configuration CRUD.
 */
@Controller('webhooks')
@UseGuards(JwtAuthGuard)
@UseInterceptors(ActorInterceptor)
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post()
  create(@Body() dto: CreateWebhookDto) {
    return this.webhooksService.create(dto);
  }

  @Get('workspace/:workspaceId')
  findByWorkspace(@Param('workspaceId') workspaceId: string) {
    return this.webhooksService.findByWorkspace(workspaceId);
  }

  @Delete(':webhookId')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('webhookId') webhookId: string) {
    return this.webhooksService.delete(webhookId);
  }

  @Patch(':webhookId/activate')
  activate(@Param('webhookId') webhookId: string) {
    return this.webhooksService.toggleActive(webhookId, true);
  }

  @Patch(':webhookId/deactivate')
  deactivate(@Param('webhookId') webhookId: string) {
    return this.webhooksService.toggleActive(webhookId, false);
  }
}
