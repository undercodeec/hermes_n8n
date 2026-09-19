import { ConfigService } from '@nestjs/config';
import { MetaService } from './meta.service';

describe('MetaService typing indicator', () => {
  it('marks the inbound message as read and enables the native text indicator', async () => {
    const config = {
      get: jest.fn((key: string, fallback?: string) => {
        const values: Record<string, string> = {
          META_ACCESS_TOKEN: 'test-token',
          META_API_VERSION: 'v25.0',
          META_PHONE_NUMBER_ID: 'phone-number-id',
        };
        return values[key] ?? fallback;
      }),
    } as unknown as ConfigService;
    const service = new MetaService(config);
    const post = jest.fn().mockResolvedValue({ data: { success: true } });
    const client = (service as unknown as { httpClient: { post: typeof post } })
      .httpClient;
    client.post = post;

    await service.showTypingIndicator('wamid.inbound');

    expect(post).toHaveBeenCalledWith('/messages', {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.inbound',
      typing_indicator: { type: 'text' },
    });
  });

  it('does not interrupt the reply flow if Meta rejects the indicator', async () => {
    const service = new MetaService({
      get: jest.fn((_key: string, fallback?: string) => fallback),
    } as unknown as ConfigService);
    const post = jest.fn().mockRejectedValue(new Error('Meta unavailable'));
    const client = (service as unknown as { httpClient: { post: typeof post } })
      .httpClient;
    client.post = post;

    await expect(
      service.showTypingIndicator('wamid.inbound'),
    ).resolves.toBeUndefined();
  });
});
