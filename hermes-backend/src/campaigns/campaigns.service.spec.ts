import { ForbiddenException } from '@nestjs/common';
import {
  CampaignRecipientStatus,
  CampaignStatus,
  MarketingConsentStatus,
} from '@prisma/client';
import { CampaignsService } from './campaigns.service';

const recipient = {
  id: 'recipient-1',
  campaignId: 'campaign-1',
  phone: '593991234567',
  wamid: null,
  status: CampaignRecipientStatus.QUEUED,
  campaign: {
    status: CampaignStatus.RUNNING,
    templateName: 'approved_template',
    templateLanguage: 'es',
    headerVideoMediaId: null,
    headerVideoUrl: null,
  },
  contact: { marketingConsentStatus: MarketingConsentStatus.OPTED_IN },
};

describe('CampaignsService send idempotency', () => {
  const makeService = (overrides: Record<string, unknown> = {}) => {
    const prisma = {
      campaignRecipient: {
        findUnique: jest.fn().mockResolvedValue(recipient),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
      campaign: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: CampaignStatus.RUNNING }),
        update: jest.fn().mockResolvedValue({}),
      },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(),
      ...overrides,
    } as any;
    const config = { get: jest.fn().mockReturnValue('false') } as any;
    const meta = {
      sendTemplateMessage: jest.fn(),
      toSafeError: jest.fn(),
    } as any;
    const queue = { add: jest.fn() } as any;
    return {
      service: new CampaignsService(prisma, config, meta, queue),
      prisma,
      config,
      meta,
    };
  };

  it('blocks start before any persistence or Meta work when campaigns are disabled', async () => {
    const { service, prisma } = makeService();
    await expect(
      service.start('campaign-1', { id: 'user-1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.campaignRecipient.findMany).toBeUndefined();
  });

  it('snapshots the video configured for the exact approved template language', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'campaign-3' });
    const template = {
      id: 'template-es',
      name: 'promo',
      language: 'es',
      status: 'APPROVED',
      components: [{ type: 'HEADER', format: 'VIDEO' }],
    };
    const templateMedia = {
      campaignMediaId: 'asset-1',
      mediaUrl: null,
      campaignMedia: {
        id: 'asset-1',
        metaMediaId: 'meta-media-1',
        mimeType: 'video/mp4',
      },
    };
    const { service, prisma } = makeService({
      campaign: { findUnique: jest.fn(), create, update: jest.fn() },
      campaignTemplateMedia: {
        findUnique: jest.fn().mockResolvedValue(templateMedia),
      },
    });
    service['meta'].getApprovedMessageTemplates = jest
      .fn()
      .mockResolvedValue([template]);
    service['meta'].getConfiguredWabaId = jest.fn().mockReturnValue('waba-1');

    await service.createCampaign(
      {
        name: 'Promoción',
        templateName: 'promo',
        templateLanguage: 'es',
      },
      { id: 'user-1' },
    );

    expect(prisma.campaignTemplateMedia.findUnique).toHaveBeenCalledWith({
      where: {
        wabaId_templateName_templateLanguage_headerType: {
          wabaId: 'waba-1',
          templateName: 'promo',
          templateLanguage: 'es',
          headerType: 'VIDEO',
        },
      },
      include: { campaignMedia: true },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          templateMetaId: 'template-es',
          templateHeaderType: 'VIDEO',
          headerVideoAssetId: 'asset-1',
          headerVideoMediaId: 'meta-media-1',
        }),
      }),
    );
  });

  it('rejects a VIDEO campaign when its template has no configured video', async () => {
    const template = {
      id: 'template-es',
      name: 'promo',
      language: 'es',
      status: 'APPROVED',
      components: [{ type: 'HEADER', format: 'VIDEO' }],
    };
    const { service } = makeService({
      campaign: {
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'campaign-4' }),
        update: jest.fn(),
      },
      campaignTemplateMedia: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    service['meta'].getApprovedMessageTemplates = jest
      .fn()
      .mockResolvedValue([template]);
    service['meta'].getConfiguredWabaId = jest.fn().mockReturnValue('waba-1');

    await expect(
      service.createCampaign(
        {
          name: 'Promoción',
          templateName: 'promo',
          templateLanguage: 'es',
        },
        { id: 'user-1' },
      ),
    ).rejects.toThrow('todavía no tiene un video configurado');
  });

  it('lists a VIDEO template with its reusable media configuration', async () => {
    const template = {
      id: 'template-es',
      name: 'promo',
      language: 'es',
      status: 'APPROVED',
      components: [{ type: 'HEADER', format: 'VIDEO' }],
    };
    const configuration = {
      templateName: 'promo',
      templateLanguage: 'es',
      headerType: 'VIDEO',
      campaignMediaId: 'asset-1',
      mediaUrl: null,
      campaignMedia: {
        id: 'asset-1',
        name: 'promo.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1024,
      },
    };
    const { service } = makeService({
      campaignTemplateMedia: {
        findMany: jest.fn().mockResolvedValue([configuration]),
      },
    });
    service['meta'].getApprovedMessageTemplates = jest
      .fn()
      .mockResolvedValue([template]);
    service['meta'].getConfiguredWabaId = jest.fn().mockReturnValue('waba-1');

    await expect(service.getTemplates()).resolves.toEqual([
      expect.objectContaining({
        headerType: 'VIDEO',
        mediaConfiguration: {
          configured: true,
          mediaLibraryId: 'asset-1',
          mediaName: 'promo.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 1024,
          usesAdvancedUrl: false,
        },
      }),
    ]);
  });

  it('rejects an association whose language does not match the approved template', async () => {
    const { service } = makeService();
    service['meta'].getApprovedMessageTemplates = jest.fn().mockResolvedValue([
      {
        id: 'template-es',
        name: 'promo',
        language: 'es',
        status: 'APPROVED',
        components: [{ type: 'HEADER', format: 'VIDEO' }],
      },
    ]);
    service['meta'].getConfiguredWabaId = jest.fn().mockReturnValue('waba-1');

    await expect(
      (service as any).configureTemplateMedia(
        {
          templateId: 'template-es',
          templateName: 'promo',
          templateLanguage: 'en',
          campaignMediaId: 'asset-1',
        },
        { id: 'user-1' },
      ),
    ).rejects.toThrow('no coincide');
  });

  it('blocks a VIDEO campaign before reading recipients when its snapshot is missing', async () => {
    const campaign = {
      id: 'campaign-1',
      status: CampaignStatus.READY,
      templateHeaderType: 'VIDEO',
      headerVideoMediaId: null,
      headerVideoUrl: null,
    };
    const findMany = jest.fn().mockResolvedValue([]);
    const { service } = makeService({
      campaign: {
        findUnique: jest.fn().mockResolvedValue(campaign),
        update: jest.fn(),
      },
      campaignRecipient: {
        findMany,
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
    });
    service['config'].get = jest.fn().mockReturnValue('true');

    await expect(service.start('campaign-1', { id: 'user-1' })).rejects.toThrow(
      'no tiene un video snapshot válido',
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it('sends the VIDEO media ID stored in the campaign snapshot', async () => {
    const videoRecipient = {
      ...recipient,
      campaign: {
        ...recipient.campaign,
        templateHeaderType: 'VIDEO',
        headerVideoMediaId: 'snapshot-media-id',
        headerVideoUrl: null,
      },
    };
    const { service, meta } = makeService({
      campaignRecipient: {
        findUnique: jest.fn().mockResolvedValue(videoRecipient),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
    });
    meta.sendTemplateMessage.mockResolvedValue({
      messages: [{ id: 'wamid-1' }],
    });

    await service.processSendJob({
      campaignId: 'campaign-1',
      recipientId: 'recipient-1',
    });

    expect(meta.sendTemplateMessage).toHaveBeenCalledWith(
      '593991234567',
      'approved_template',
      'es',
      { headerVideoMediaId: 'snapshot-media-id', headerVideoUrl: undefined },
    );
  });

  it('replaces a template association without updating existing campaigns', async () => {
    const upsert = jest.fn().mockResolvedValue({
      id: 'configuration-2',
      campaignMediaId: 'asset-2',
      mediaUrl: null,
      campaignMedia: {
        id: 'asset-2',
        metaMediaId: 'meta-media-2',
        mimeType: 'video/mp4',
      },
    });
    const update = jest.fn();
    const { service, prisma } = makeService({
      campaign: { findUnique: jest.fn(), update },
      campaignMedia: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'asset-2', mimeType: 'video/mp4' }),
      },
      campaignTemplateMedia: {
        findUnique: jest.fn().mockResolvedValue({ campaignMediaId: 'asset-1' }),
        upsert,
      },
    });
    service['meta'].getApprovedMessageTemplates = jest.fn().mockResolvedValue([
      {
        id: 'template-es',
        name: 'promo',
        language: 'es',
        status: 'APPROVED',
        components: [{ type: 'HEADER', format: 'VIDEO' }],
      },
    ]);
    service['meta'].getConfiguredWabaId = jest.fn().mockReturnValue('waba-1');

    await (service as any).configureTemplateMedia(
      {
        templateId: 'template-es',
        templateName: 'promo',
        templateLanguage: 'es',
        campaignMediaId: 'asset-2',
      },
      { id: 'user-1' },
    );

    expect(upsert).toHaveBeenCalled();
    expect(prisma.campaign.update).not.toHaveBeenCalled();
  });

  it('does not call Meta when another job already claimed the recipient', async () => {
    const { service, prisma, meta } = makeService();
    prisma.campaignRecipient.updateMany.mockResolvedValue({ count: 0 });
    await service.processSendJob({
      campaignId: 'campaign-1',
      recipientId: 'recipient-1',
    });
    expect(meta.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('does not retry an ambiguous timeout or 5xx outcome after claiming', async () => {
    const { service, prisma, meta } = makeService();
    meta.sendTemplateMessage.mockRejectedValue(new Error('timeout'));
    meta.toSafeError.mockReturnValue({
      retryable: true,
      status: 500,
      code: '500',
      message: 'upstream failure',
    });
    await service.processSendJob({
      campaignId: 'campaign-1',
      recipientId: 'recipient-1',
    });
    expect(meta.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(prisma.campaignRecipient.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: CampaignRecipientStatus.FAILED,
          errorCode: '500',
        }),
      }),
    );
  });

  it('releases only an explicit 429 claim for BullMQ retry', async () => {
    const { service, prisma, meta } = makeService();
    const rateLimitError = new Error('rate limited');
    meta.sendTemplateMessage.mockRejectedValue(rateLimitError);
    meta.toSafeError.mockReturnValue({
      retryable: true,
      status: 429,
      code: '429',
      message: 'rate limited',
    });
    await expect(
      service.processSendJob({
        campaignId: 'campaign-1',
        recipientId: 'recipient-1',
      }),
    ).rejects.toBe(rateLimitError);
    expect(prisma.campaignRecipient.update).toHaveBeenCalledWith({
      where: { id: 'recipient-1' },
      data: { sendAttemptedAt: null },
    });
  });
});
