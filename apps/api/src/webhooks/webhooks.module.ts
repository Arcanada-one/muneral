import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhooksService, WEBHOOK_QUEUE } from './webhooks.service.js';
import { WebhooksController } from './webhooks.controller.js';
import { WebhookDispatchProcessor } from './webhook-dispatch.processor.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: WEBHOOK_QUEUE })],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookDispatchProcessor],
  exports: [WebhooksService],
})
export class WebhooksModule {}
