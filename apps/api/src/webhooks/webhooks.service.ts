import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWebhookDto } from './dto/create-webhook.dto';

export const WEBHOOK_QUEUE = 'webhook-dispatch';

export interface WebhookJob {
  webhookId: string;
  url: string;
  secret: string | null;
  event: string;
  payload: unknown;
}

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(WEBHOOK_QUEUE)
    private readonly webhookQueue: Queue<WebhookJob>,
  ) {}

  async create(dto: CreateWebhookDto) {
    return this.prisma.webhookConfig.create({
      data: {
        workspaceId: dto.workspaceId,
        url: dto.url,
        events: dto.events,
        secret: dto.secret ?? null,
      },
    });
  }

  async findByWorkspace(workspaceId: string) {
    return this.prisma.webhookConfig.findMany({ where: { workspaceId } });
  }

  async delete(webhookId: string): Promise<void> {
    const webhook = await this.prisma.webhookConfig.findUnique({
      where: { id: webhookId },
    });
    if (!webhook) throw new NotFoundException('Webhook not found');
    await this.prisma.webhookConfig.delete({ where: { id: webhookId } });
  }

  async toggleActive(webhookId: string, active: boolean) {
    const webhook = await this.prisma.webhookConfig.findUnique({
      where: { id: webhookId },
    });
    if (!webhook) throw new NotFoundException('Webhook not found');
    return this.prisma.webhookConfig.update({
      where: { id: webhookId },
      data: { active },
    });
  }

  /**
   * Dispatch an event to all active webhooks subscribed to it.
   * Enqueues BullMQ jobs for each matching webhook.
   */
  async dispatch(workspaceId: string, event: string, payload: unknown): Promise<void> {
    const webhooks = await this.prisma.webhookConfig.findMany({
      where: {
        workspaceId,
        active: true,
        events: { has: event },
      },
    });

    const jobs = webhooks.map((wh) => ({
      name: 'dispatch',
      data: {
        webhookId: wh.id,
        url: wh.url,
        secret: wh.secret,
        event,
        payload,
      } satisfies WebhookJob,
    }));

    if (jobs.length > 0) {
      await this.webhookQueue.addBulk(jobs);
    }
  }
}
