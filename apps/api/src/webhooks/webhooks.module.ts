import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhooksService, WEBHOOK_QUEUE } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { WebhookDispatchProcessor } from './webhook-dispatch.processor';

@Module({
  imports: [BullModule.registerQueue({ name: WEBHOOK_QUEUE })],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookDispatchProcessor],
  exports: [WebhooksService],
})
export class WebhooksModule {}
