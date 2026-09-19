import { ConversationEventsService } from './conversation-events.service';

describe('ConversationEventsService', () => {
  it('abre el stream y publica mensajes entrantes sin exponer el payload crudo', async () => {
    const service = new ConversationEventsService();
    const received: Array<{ type?: string; data: unknown }> = [];
    const subscription = service.stream().subscribe((event) => {
      received.push(event);
    });

    await service.publishCustomerMessage({
      messageId: 'message-1',
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      contactName: 'Ana',
      content: 'Hola',
      messageType: 'TEXT',
      createdAt: '2026-09-19T12:00:00.000Z',
    });

    expect(received[0]).toEqual(
      expect.objectContaining({ type: 'connected', retry: 3000 }),
    );
    expect(received[1]?.type).toBe('customer_message');
    expect(received[1]?.data).toMatchObject({
      messageId: 'message-1',
      conversationId: 'conversation-1',
      content: 'Hola',
    });
    subscription.unsubscribe();
  });
});
