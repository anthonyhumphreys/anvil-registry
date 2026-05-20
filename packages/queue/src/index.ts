import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient
} from "@aws-sdk/client-sqs";
import { Queue, type Job, type WorkerOptions } from "bullmq";
import type { AnvilConfig } from "@anvil/config";
import type { AnalysisJob } from "@anvil/shared";

export interface JobQueue {
  healthCheck?(): Promise<void>;
  enqueueAnalysisJob(job: AnalysisJob): Promise<void>;
  receiveAnalysisJobs(): AsyncIterable<AnalysisJob>;
  acknowledge(jobId: string): Promise<void>;
  fail(jobId: string, reason: string): Promise<void>;
}

export class MemoryJobQueue implements JobQueue {
  private readonly jobs: AnalysisJob[] = [];

  async healthCheck(): Promise<void> {}

  async enqueueAnalysisJob(job: AnalysisJob): Promise<void> {
    this.jobs.push({ ...job, id: job.id ?? crypto.randomUUID() });
  }

  async *receiveAnalysisJobs(): AsyncIterable<AnalysisJob> {
    while (this.jobs.length > 0) {
      yield this.jobs.shift()!;
    }
  }

  async acknowledge(): Promise<void> {}

  async fail(_jobId: string, reason: string): Promise<void> {
    throw new Error(`Analysis job failed: ${reason}`);
  }
}

export class BullMqJobQueue implements JobQueue {
  private readonly queue: Queue<AnalysisJob>;

  constructor(options: { redisUrl: string; queueName: string }) {
    this.queue = new Queue<AnalysisJob>(options.queueName, {
      connection: connectionFromRedisUrl(options.redisUrl)
    });
  }

  async enqueueAnalysisJob(job: AnalysisJob): Promise<void> {
    await this.queue.add("analysis", { ...job, id: job.id ?? crypto.randomUUID() }, { priority: priorityValue(job.priority) });
  }

  async healthCheck(): Promise<void> {
    await this.queue.getJobCounts("waiting", "active", "delayed", "failed");
  }

  receiveAnalysisJobs(): AsyncIterable<AnalysisJob> {
    throw new Error("BullMqJobQueue.receiveAnalysisJobs is not used directly; use createBullMqWorker for worker consumption.");
  }

  async acknowledge(): Promise<void> {}

  async fail(_jobId: string, reason: string): Promise<void> {
    throw new Error(`Analysis job failed: ${reason}`);
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

export class SqsJobQueue implements JobQueue {
  private readonly client: SqsClientLike;
  private readonly queueUrl: string;

  constructor(options: { queueUrl: string; region: string; client?: SqsClientLike }) {
    this.queueUrl = options.queueUrl;
    this.client = options.client ?? new SQSClient({ region: options.region });
  }

  async enqueueAnalysisJob(job: AnalysisJob): Promise<void> {
    const jobWithId = { ...job, id: job.id ?? crypto.randomUUID() };
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(jobWithId)
      })
    );
  }

  async healthCheck(): Promise<void> {
    await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.queueUrl,
        AttributeNames: ["QueueArn"]
      })
    );
  }

  receiveAnalysisJobs(): AsyncIterable<AnalysisJob> {
    throw new Error("SqsJobQueue.receiveAnalysisJobs is not used directly; use createSqsAnalysisWorker for worker consumption.");
  }

  async acknowledge(): Promise<void> {}

  async fail(_jobId: string, reason: string): Promise<void> {
    throw new Error(`Analysis job failed: ${reason}`);
  }

  close(): void {
    this.client.destroy?.();
  }
}

export type AnalysisWorkerHandle = {
  close(): Promise<void>;
};

export type BullMqAnalysisWorker = AnalysisWorkerHandle;
export type SqsAnalysisWorker = AnalysisWorkerHandle;

export async function createBullMqAnalysisWorker(options: {
  redisUrl: string;
  queueName: string;
  handler: (job: AnalysisJob) => Promise<void>;
  concurrency?: number;
}): Promise<BullMqAnalysisWorker> {
  const { Worker } = await import("bullmq");
  const workerOptions: WorkerOptions = {
    connection: connectionFromRedisUrl(options.redisUrl),
    concurrency: options.concurrency ?? 2
  };
  const worker = new Worker<AnalysisJob>(
    options.queueName,
    async (job: Job<AnalysisJob>) => {
      await options.handler({ ...job.data, id: job.data.id ?? job.id });
    },
    workerOptions
  );

  return {
    close: () => worker.close()
  };
}

export function createSqsAnalysisWorker(options: {
  queueUrl: string;
  region: string;
  handler: (job: AnalysisJob) => Promise<void>;
  waitTimeSeconds?: number;
  visibilityTimeoutSeconds?: number;
  client?: SqsClientLike;
}): SqsAnalysisWorker {
  const client = options.client ?? new SQSClient({ region: options.region });
  let running = true;

  const loop = (async () => {
    while (running) {
      const response = (await client.send(
        new ReceiveMessageCommand({
          QueueUrl: options.queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: options.waitTimeSeconds ?? 20,
          VisibilityTimeout: options.visibilityTimeoutSeconds ?? 300
        })
      )) as SqsReceiveResponse;

      for (const message of response.Messages ?? []) {
        if (!message.Body || !message.ReceiptHandle) continue;

        try {
          const job = parseSqsAnalysisJob(message.Body, message.MessageId);
          await options.handler(job);
          await client.send(new DeleteMessageCommand({ QueueUrl: options.queueUrl, ReceiptHandle: message.ReceiptHandle }));
        } catch {
          await client.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: options.queueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 0
            })
          );
        }
      }
    }
  })().catch(() => undefined);

  return {
    async close() {
      running = false;
      void loop;
      client.destroy?.();
    }
  };
}

export function createJobQueue(config: AnvilConfig): JobQueue {
  if (config.QUEUE_DRIVER === "bullmq") {
    return new BullMqJobQueue({
      redisUrl: config.REDIS_URL,
      queueName: config.ANALYSIS_QUEUE_NAME
    });
  }

  if (config.QUEUE_DRIVER === "sqs") {
    if (!config.ANALYSIS_QUEUE_URL) throw new Error("ANALYSIS_QUEUE_URL is required when QUEUE_DRIVER=sqs");
    return new SqsJobQueue({
      queueUrl: config.ANALYSIS_QUEUE_URL,
      region: config.AWS_REGION
    });
  }

  return new MemoryJobQueue();
}

export function connectionFromRedisUrl(redisUrl: string): { host: string; port: number; password?: string; username?: string } {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username || undefined,
    password: url.password || undefined
  };
}

function priorityValue(priority: AnalysisJob["priority"]): number {
  if (priority === "high") return 1;
  if (priority === "normal") return 5;
  return 10;
}

function parseSqsAnalysisJob(body: string, messageId?: string): AnalysisJob {
  const parsed = JSON.parse(body) as AnalysisJob;
  return { ...parsed, id: parsed.id ?? messageId };
}

export type SqsClientLike = {
  send(command: SendMessageCommand | ReceiveMessageCommand | DeleteMessageCommand | ChangeMessageVisibilityCommand | GetQueueAttributesCommand): Promise<unknown>;
  destroy?: () => void;
};

type SqsReceiveResponse = {
  Messages?: Array<{
    MessageId?: string;
    ReceiptHandle?: string;
    Body?: string;
  }>;
};
