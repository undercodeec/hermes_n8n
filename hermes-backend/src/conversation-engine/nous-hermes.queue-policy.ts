import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { NOUS_HERMES_INFERENCE_QUEUE } from './nous-hermes.constants';

@Injectable()
export class NousHermesQueuePolicy implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(NOUS_HERMES_INFERENCE_QUEUE) private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.setGlobalConcurrency(1);
  }
}
