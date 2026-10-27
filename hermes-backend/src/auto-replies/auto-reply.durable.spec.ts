import { ConfigService } from '@nestjs/config';
import { AutoReplyService } from './auto-reply.service';
import { InboundTurnService } from './inbound-turn.service';
import { NousQueuePendingError } from '../conversation-engine/nous-hermes.engine';

describe('durable Nous auto-reply continuation', () => {
  it('releases the auto-reply worker but preserves the provider claim on a pending job', async () => {
    const detachNousWait = jest.fn().mockResolvedValue(true);
    const complete = jest.fn();
    const release = jest.fn();
    const turns = {
      claim: jest.fn().mockResolvedValue({
        id: 'turn-1',
        lastMessageId: 'inbound-1',
        processingToken: 'token-1',
      }),
      messages: jest.fn().mockResolvedValue([]),
      detachNousWait,
      complete,
      release,
    } as unknown as InboundTurnService;
    const config = {
      get: jest.fn((_key: string, fallback?: unknown) => fallback),
    } as unknown as ConfigService;
    const dependency = {} as never;
    const service = new AutoReplyService(
      config,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      dependency,
      turns,
    );
    Object.defineProperty(service, 'processTurn', {
      value: jest.fn().mockRejectedValue(new NousQueuePendingError()),
    });
    await service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-1',
      inboundTurnId: 'turn-1',
    });
    expect(detachNousWait).toHaveBeenCalledWith('turn-1', 'token-1');
    expect(complete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
