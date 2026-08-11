import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import * as crypto from 'crypto';
import { WEBHOOK_QUEUE, WebhookJob } from './webhooks.service';

/**
 * WebhookDispatchProcessor — BullMQ worker that POST-s webhook payloads
 * with HMAC-SHA256 signature header.
 */
@Processor(WEBHOOK_QUEUE)
export class WebhookDispatchProcessor extends WorkerHost {
  async process(job: Job<WebhookJob>): Promise<void> {
    const { url, secret, event, payload } = job.data;
    const body = JSON.stringify({ event, payload });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Muneral-Event': event,
      'X-Muneral-Delivery': job.id ?? crypto.randomUUID(),
    };

    if (secret) {
      const sig = crypto
        .createHmac('sha256', secret)
        .update(body)
        .digest('hex');
      headers['X-Muneral-Signature-256'] = `sha256=${sig}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(
        `Webhook delivery failed: ${response.status} ${response.statusText}`,
      );
    }
  }
}
