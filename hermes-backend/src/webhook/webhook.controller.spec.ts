import { UnauthorizedException } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

describe('WebhookController durable acknowledgement', () => {
  const payload = { object: 'whatsapp_business_account', entry: [] };
  const raw = Buffer.from(JSON.stringify(payload));

  it('waits for durable acceptance before acknowledging', async () => {
    let persist!: () => void;
    const accepted = new Promise<void>((resolve) => (persist = resolve));
    const service = {
      validateSignature: jest.fn().mockReturnValue(true),
      acceptWebhook: jest.fn().mockReturnValue(accepted),
      scan: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new WebhookController(
      service as unknown as WebhookService,
    );
    const response = controller.receive(payload, raw, 'sha256=synthetic');
    expect(service.acceptWebhook).toHaveBeenCalledWith(payload);
    expect(service.scan).not.toHaveBeenCalled();
    persist();
    await expect(response).resolves.toBe('OK');
    expect(service.scan).toHaveBeenCalledTimes(1);
  });

  it('rejects a bad signature and does not persist anything', async () => {
    const service = {
      validateSignature: jest.fn().mockReturnValue(false),
      acceptWebhook: jest.fn(),
    };
    const controller = new WebhookController(
      service as unknown as WebhookService,
    );
    await expect(
      controller.receive(payload, raw, 'sha256=bad'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.acceptWebhook).not.toHaveBeenCalled();
  });

  it('propagates persistence failure instead of acknowledging', async () => {
    const service = {
      validateSignature: jest.fn().mockReturnValue(true),
      acceptWebhook: jest
        .fn()
        .mockRejectedValue(new Error('database unavailable')),
      scan: jest.fn(),
    };
    const controller = new WebhookController(
      service as unknown as WebhookService,
    );
    await expect(
      controller.receive(payload, raw, 'sha256=synthetic'),
    ).rejects.toThrow('database unavailable');
    expect(service.scan).not.toHaveBeenCalled();
  });
});
