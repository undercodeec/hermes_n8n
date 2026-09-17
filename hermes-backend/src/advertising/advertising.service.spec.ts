/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { AdvertisingConsentChoice, AdvertisingEventType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdvertisingService } from './advertising.service';

const consent = {
  adStorage: AdvertisingConsentChoice.DENIED,
  analyticsStorage: AdvertisingConsentChoice.GRANTED,
  adUserData: AdvertisingConsentChoice.GRANTED,
  adPersonalization: AdvertisingConsentChoice.DENIED,
  source: 'CMP',
  recordedAt: '2026-09-17T12:00:00.000Z',
};

describe('AdvertisingService', () => {
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'AD_ATTRIBUTION_REFERENCE_PEPPER') {
        return 'test-reference-pepper-at-least-32-characters';
      }
      return fallback;
    }),
  } as unknown as ConfigService;

  it('creates an opaque reference and preserves click identifiers exactly', async () => {
    const touchCreate = jest.fn().mockImplementation(({ data }) => ({
      id: 'touch-1',
      ...data,
    }));
    const conversionCreate = jest.fn().mockResolvedValue({ id: 'event-1' });
    const prisma = {
      advertisingTouch: { create: touchCreate },
      advertisingConversion: { create: conversionCreate },
    } as unknown as PrismaService;
    const service = new AdvertisingService(prisma, config, {} as Queue);

    const result = await service.createContactIntent({
      gclid: 'Exact_Gclid-123',
      utmCampaign: 'es-b2b',
      consent,
    });

    expect(result.reference).toMatch(/^UC-[A-Z2-7]{22}$/);
    expect(touchCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        gclid: 'Exact_Gclid-123',
        utmCampaign: 'es-b2b',
        referenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        referenceLast4: result.reference.slice(-4),
      }),
    });
    expect(JSON.stringify(touchCreate.mock.calls)).not.toContain(
      result.reference,
    );
    expect(conversionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: AdvertisingEventType.WHATSAPP_CLICK,
        verified: false,
      }),
    });
  });

  it('does not resolve a message with no exact reference', async () => {
    const service = new AdvertisingService(
      {} as PrismaService,
      config,
      {} as Queue,
    );
    await expect(
      service.claimReference({
        messageContent: 'Hola, eliminé la referencia',
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        inboundMessageId: 'message-1',
      }),
    ).resolves.toEqual({ status: 'missing' });
  });

  it('confirms a valid reference transactionally and creates one conversation event', async () => {
    const serviceForReference = new AdvertisingService(
      {
        advertisingTouch: {
          create: jest
            .fn()
            .mockImplementation(({ data }) => ({ id: 'touch-1', ...data })),
        },
        advertisingConversion: { create: jest.fn().mockResolvedValue({}) },
      } as unknown as PrismaService,
      config,
      {} as Queue,
    );
    const issued = await serviceForReference.createContactIntent({ consent });

    const tx = {
      $executeRaw: jest.fn(),
      advertisingAttribution: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'attribution-1' }),
      },
      advertisingTouch: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'touch-1',
          expiresAt: new Date(Date.now() + 60_000),
          useCount: 0,
          maxUses: 1,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      lead: { findUnique: jest.fn().mockResolvedValue({ id: 'lead-1' }) },
      advertisingConversion: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as unknown as PrismaService;
    const service = new AdvertisingService(prisma, config, {} as Queue);

    await expect(
      service.claimReference({
        messageContent: `Hola. Referencia: ${issued.reference}`,
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        inboundMessageId: 'message-1',
      }),
    ).resolves.toEqual({ status: 'confirmed' });
    expect(tx.advertisingAttribution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'CONFIRMED',
        inboundMessageId: 'message-1',
      }),
    });
    expect(tx.advertisingConversion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: AdvertisingEventType.CONVERSATION_STARTED,
        idempotencyKey: 'conversation-started:lead-1',
      }),
    });
  });

  it('does not attribute an expired reference', async () => {
    const tx = {
      $executeRaw: jest.fn(),
      advertisingAttribution: { findUnique: jest.fn().mockResolvedValue(null) },
      advertisingTouch: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'touch-expired',
          expiresAt: new Date(Date.now() - 1),
          useCount: 0,
          maxUses: 1,
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as unknown as PrismaService;
    const service = new AdvertisingService(prisma, config, {} as Queue);

    await expect(
      service.claimReference({
        messageContent: `Referencia: UC-${'A'.repeat(22)}`,
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        inboundMessageId: 'message-1',
      }),
    ).resolves.toEqual({ status: 'expired' });
  });

  it('treats a repeated inbound message as already confirmed', async () => {
    const tx = {
      $executeRaw: jest.fn(),
      advertisingAttribution: {
        findUnique: jest.fn().mockResolvedValue({ id: 'attribution-1' }),
      },
      advertisingTouch: { findUnique: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as unknown as PrismaService;
    const service = new AdvertisingService(prisma, config, {} as Queue);

    await expect(
      service.claimReference({
        messageContent: `Referencia: UC-${'B'.repeat(22)}`,
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        inboundMessageId: 'message-1',
      }),
    ).resolves.toEqual({ status: 'confirmed' });
    expect(tx.advertisingTouch.findUnique).not.toHaveBeenCalled();
  });
});
