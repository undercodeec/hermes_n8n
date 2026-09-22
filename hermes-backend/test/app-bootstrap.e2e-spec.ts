import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { ADVERTISING_QUEUE } from '../src/advertising/advertising.constants';
import { AUTO_REPLY_QUEUE } from '../src/auto-replies/auto-reply.constants';
import { CAMPAIGN_QUEUE } from '../src/campaigns/campaigns.constants';
import { NOUS_HERMES_INFERENCE_QUEUE } from '../src/conversation-engine/nous-hermes.constants';
import { N8N_QUEUE } from '../src/integrations/n8n/n8n.constants';
import { AppModule } from '../src/app.module';

const QUEUES = [
  ADVERTISING_QUEUE,
  AUTO_REPLY_QUEUE,
  CAMPAIGN_QUEUE,
  NOUS_HERMES_INFERENCE_QUEUE,
  N8N_QUEUE,
] as const;

describe('AppModule bootstrap composition', () => {
  let moduleRef: TestingModule | undefined;

  beforeAll(() => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    process.env.JWT_SECRET = 'synthetic-bootstrap-jwt-secret';
    process.env.N8N_BASE_URL = 'http://127.0.0.1:5678';
    process.env.N8N_HMAC_SECRET = 'synthetic-bootstrap-hmac-secret';
  });

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  it('compiles the real root module dependency graph', async () => {
    const builder = Test.createTestingModule({ imports: [AppModule] });
    const queueStub = { add: jest.fn() };

    for (const queueName of QUEUES) {
      builder.overrideProvider(getQueueToken(queueName)).useValue(queueStub);
    }

    moduleRef = await builder.compile();

    expect(moduleRef.get(AppModule)).toBeInstanceOf(AppModule);
  });
});
