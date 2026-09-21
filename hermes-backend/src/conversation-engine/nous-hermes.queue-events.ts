import { QueueEventsHost, QueueEventsListener } from '@nestjs/bullmq';
import { NOUS_HERMES_INFERENCE_QUEUE } from './nous-hermes.constants';

@QueueEventsListener(NOUS_HERMES_INFERENCE_QUEUE)
export class NousHermesQueueEvents extends QueueEventsHost {}
