import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { WebhookConfig } from './entities/webhook-config.entity';
import { WebhooksService, WEBHOOK_QUEUE } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { WebhookDispatchProcessor } from './webhook-dispatch.processor';

@Module({
  imports: [
    TypeOrmModule.forFeature([WebhookConfig]),
    BullModule.registerQueue({ name: WEBHOOK_QUEUE }),
  ],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookDispatchProcessor],
  exports: [WebhooksService],
})
export class WebhooksModule {}
