import { ForbiddenException } from '@nestjs/common';
import { CampaignRecipientStatus, CampaignStatus, MarketingConsentStatus } from '@prisma/client';
import { CampaignsService } from './campaigns.service';

const recipient = {
  id: 'recipient-1', campaignId: 'campaign-1', phone: '593991234567', wamid: null,
  status: CampaignRecipientStatus.QUEUED,
  campaign: { status: CampaignStatus.RUNNING, templateName: 'approved_template', templateLanguage: 'es', headerVideoMediaId: null, headerVideoUrl: null },
  contact: { marketingConsentStatus: MarketingConsentStatus.OPTED_IN },
};

describe('CampaignsService send idempotency', () => {
  const makeService = (overrides: Record<string, unknown> = {}) => {
    const prisma = {
      campaignRecipient: { findUnique: jest.fn().mockResolvedValue(recipient), updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue({}), count: jest.fn().mockResolvedValue(0) },
      campaign: { findUnique: jest.fn().mockResolvedValue({ status: CampaignStatus.RUNNING }), update: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(),
      ...overrides,
    } as any;
    const config = { get: jest.fn().mockReturnValue('false') } as any;
    const meta = { sendTemplateMessage: jest.fn(), toSafeError: jest.fn() } as any;
    const queue = { add: jest.fn() } as any;
    return { service: new CampaignsService(prisma, config, meta, queue), prisma, config, meta };
  };

  it('blocks start before any persistence or Meta work when campaigns are disabled', async () => {
    const { service, prisma } = makeService();
    await expect(service.start('campaign-1', { id: 'user-1' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.campaignRecipient.findMany).toBeUndefined();
  });

  it('does not call Meta when another job already claimed the recipient', async () => {
    const { service, prisma, meta } = makeService();
    prisma.campaignRecipient.updateMany.mockResolvedValue({ count: 0 });
    await service.processSendJob({ campaignId: 'campaign-1', recipientId: 'recipient-1' });
    expect(meta.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('does not retry an ambiguous timeout or 5xx outcome after claiming', async () => {
    const { service, prisma, meta } = makeService();
    meta.sendTemplateMessage.mockRejectedValue(new Error('timeout'));
    meta.toSafeError.mockReturnValue({ retryable: true, status: 500, code: '500', message: 'upstream failure' });
    await service.processSendJob({ campaignId: 'campaign-1', recipientId: 'recipient-1' });
    expect(meta.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(prisma.campaignRecipient.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: CampaignRecipientStatus.FAILED, errorCode: '500' }),
    }));
  });

  it('releases only an explicit 429 claim for BullMQ retry', async () => {
    const { service, prisma, meta } = makeService();
    const rateLimitError = new Error('rate limited');
    meta.sendTemplateMessage.mockRejectedValue(rateLimitError);
    meta.toSafeError.mockReturnValue({ retryable: true, status: 429, code: '429', message: 'rate limited' });
    await expect(service.processSendJob({ campaignId: 'campaign-1', recipientId: 'recipient-1' })).rejects.toBe(rateLimitError);
    expect(prisma.campaignRecipient.update).toHaveBeenCalledWith({ where: { id: 'recipient-1' }, data: { sendAttemptedAt: null } });
  });
});
