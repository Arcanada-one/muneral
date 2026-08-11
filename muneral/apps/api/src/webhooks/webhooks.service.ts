import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { WebhookConfig } from './entities/webhook-config.entity';
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
    @InjectRepository(WebhookConfig)
    private readonly webhookRepo: Repository<WebhookConfig>,
    @InjectQueue(WEBHOOK_QUEUE)
    private readonly webhookQueue: Queue<WebhookJob>,
  ) {}

  async create(dto: CreateWebhookDto): Promise<WebhookConfig> {
    const webhook = this.webhookRepo.create({
      workspaceId: dto.workspaceId,
      url: dto.url,
      events: dto.events,
      secret: dto.secret ?? null,
    });
    return this.webhookRepo.save(webhook);
  }

  async findByWorkspace(workspaceId: string): Promise<WebhookConfig[]> {
    return this.webhookRepo
      .createQueryBuilder('wc')
      .where('wc.workspace_id = :workspaceId', { workspaceId })
      .getMany();
  }

  async delete(webhookId: string): Promise<void> {
    const webhook = await this.webhookRepo.findOne({
      where: { id: webhookId },
    });
    if (!webhook) throw new NotFoundException('Webhook not found');
    await this.webhookRepo.remove(webhook);
  }

  async toggleActive(webhookId: string, active: boolean): Promise<WebhookConfig> {
    const webhook = await this.webhookRepo.findOne({
      where: { id: webhookId },
    });
    if (!webhook) throw new NotFoundException('Webhook not found');
    webhook.active = active;
    return this.webhookRepo.save(webhook);
  }

  /**
   * Dispatch an event to all active webhooks subscribed to it.
   * Enqueues BullMQ jobs for each matching webhook.
   */
  async dispatch(workspaceId: string, event: string, payload: unknown): Promise<void> {
    const webhooks = await this.webhookRepo
      .createQueryBuilder('wc')
      .where('wc.workspace_id = :workspaceId', { workspaceId })
      .andWhere('wc.active = true')
      .andWhere(':event = ANY(wc.events)', { event })
      .getMany();

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
