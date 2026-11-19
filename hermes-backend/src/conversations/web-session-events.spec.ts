import { of, firstValueFrom, toArray } from 'rxjs';
import { ConversationsController } from './conversations.controller';
import { UnauthorizedException } from '@nestjs/common';

describe('CRM web SSE authorization after handshake', () => {
  const stream = jest.fn(() => of(
    { type: 'connected', data: { connectedAt: 'test' } },
    { type: 'customer_message', data: { messageId: 'test' } },
  ));
  const checkWeb = jest.fn();
  const controller = new ConversationsController(
    {} as never, { stream } as never, { checkWeb } as never,
  );
  const user = { id: 'operator', sessionId: 'session', sessionType: 'web', accessExpiresAt: Math.floor(Date.now() / 1000) + 100 };

  beforeEach(() => { jest.clearAllMocks(); });

  it('does not send events after DB revocation and never calls activity', async () => {
    checkWeb.mockResolvedValueOnce({ active: true }).mockRejectedValueOnce(new UnauthorizedException());
    const events = await firstValueFrom(controller.events(user).pipe(toArray()));
    expect(events).toHaveLength(1);
    expect(checkWeb).toHaveBeenCalledTimes(2);
  });

  it('does not emit even the connection event for expired sessions', async () => {
    checkWeb.mockRejectedValue(new UnauthorizedException());
    const events = await firstValueFrom(controller.events(user).pipe(toArray()));
    expect(events).toEqual([]);
  });
});
