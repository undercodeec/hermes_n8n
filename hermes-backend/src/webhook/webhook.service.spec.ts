import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { ConversationStatus, HandoffReason } from '@prisma/client';
import { CampaignsService } from '../campaigns/campaigns.service';
import { HandoffService } from '../handoff/handoff.service';
import { HermesService } from '../hermes/hermes.service';
import { LeadsService } from '../leads/leads.service';
import { MetaService } from '../meta/meta.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookService } from './webhook.service';
import { AutoReplyService } from '../auto-replies/auto-reply.service';
import { ConversationGuardService } from '../conversation-guard/conversation-guard.service';
import { AdvertisingService } from '../advertising/advertising.service';

describe('WebhookService campaign replies', () => {
  it('accepts only a valid Meta HMAC signature', () => {
    const secret = 'test-meta-secret';
    const payload = Buffer.from('{"object":"whatsapp_business_account"}');
    const signature = `sha256=${crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex')}`;
    const service = new WebhookService(
      {
        get: jest.fn((key: string) =>
          key === 'META_APP_SECRET' ? secret : undefined,
        ),
      } as unknown as ConfigService,
      {} as PrismaService,
      {} as MetaService,
      {} as HermesService,
      {} as HandoffService,
      {} as LeadsService,
      {} as CampaignsService,
      {} as AutoReplyService,
      {} as ConversationGuardService,
      {} as AdvertisingService,
    );

    expect(service.validateSignature(payload, signature)).toBe(true);
    expect(service.validateSignature(payload, 'sha256=bad')).toBe(false);
  });

  it('sends a campaign reply to human handoff without invoking Hermes', async () => {
    const prismaMock = {
      $executeRaw: jest.fn(),
      contact: {
        upsert: jest.fn().mockResolvedValue({
          id: 'contact-1',
          waId: '593991234567',
          name: 'Contacto de prueba',
        }),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockResolvedValue({ id: 'conversation-1', status: 'ACTIVE' }),
        update: jest.fn().mockResolvedValue({}),
      },
      humanHandoff: { findFirst: jest.fn().mockResolvedValue(null) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      message: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'inbound-1' }),
      },
      $transaction: jest.fn(),
    };
    prismaMock.$transaction.mockImplementation((callback: any) =>
      callback(prismaMock),
    );
    const prisma = prismaMock as unknown as PrismaService;
    const meta = { sendTextMessage: jest.fn() } as unknown as MetaService;
    const hermes = { generateResponse: jest.fn() } as unknown as HermesService;
    const handoff = {
      create: jest.fn().mockResolvedValue({ id: 'handoff-1' }),
    } as unknown as HandoffService;
    const leads = {
      findOrCreateForConversation: jest.fn().mockResolvedValue({}),
    } as unknown as LeadsService;
    const campaigns = {
      markReplied: jest.fn().mockResolvedValue(undefined),
      findHumanManagedRecipient: jest
        .fn()
        .mockResolvedValue({ campaignId: 'campaign-1' }),
    } as unknown as CampaignsService;
    const autoReplies = { enqueue: jest.fn() } as unknown as AutoReplyService;
    const guard = { inspect: jest.fn() } as unknown as ConversationGuardService;
    const advertising = {
      claimReference: jest.fn().mockResolvedValue({ status: 'missing' }),
    } as unknown as AdvertisingService;
    const service = new WebhookService(
      { get: jest.fn() } as unknown as ConfigService,
      prisma,
      meta,
      hermes,
      handoff,
      leads,
      campaigns,
      autoReplies,
      guard,
      advertising,
    );

    await (service as any).processIncomingMessage(
      {
        id: 'wamid.inbound',
        from: '593991234567',
        type: 'text',
        text: { body: 'Necesito información' },
      },
      { wa_id: '593991234567', profile: { name: 'Contacto de prueba' } },
    );

    expect(handoff.create).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      reason: HandoffReason.CUSTOM,
      reasonDetail:
        'Respuesta a campaña campaign-1; requiere atención humana desde CRM.',
    });
    expect(hermes.generateResponse).not.toHaveBeenCalled();
    expect(meta.sendTextMessage).not.toHaveBeenCalled();
    expect(autoReplies.enqueue).not.toHaveBeenCalled();
    expect(advertising.claimReference).toHaveBeenCalledWith({
      messageContent: 'Necesito información',
      contactId: 'contact-1',
      conversationId: 'conversation-1',
      inboundMessageId: 'inbound-1',
    });
  });

  it('resumes the latest closed conversation without replacing its lead', async () => {
    const closedAt = new Date('2026-09-18T18:00:00Z');
    const closedConversation = {
      id: 'conversation-closed',
      contactId: 'contact-1',
      status: ConversationStatus.CLOSED,
      closedAt,
    };
    const resumedConversation = {
      ...closedConversation,
      status: ConversationStatus.ACTIVE,
      closedAt: null,
    };
    const prismaMock = {
      $executeRaw: jest.fn(),
      contact: {
        upsert: jest.fn().mockResolvedValue({
          id: 'contact-1',
          waId: '593991234567',
          name: 'Ana',
        }),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue(closedConversation),
        create: jest.fn(),
        update: jest
          .fn()
          .mockResolvedValueOnce(resumedConversation)
          .mockResolvedValue({}),
      },
      humanHandoff: { findFirst: jest.fn().mockResolvedValue(null) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      message: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'inbound-1' }),
      },
      $transaction: jest.fn(),
    };
    prismaMock.$transaction.mockImplementation((callback: any) =>
      callback(prismaMock),
    );
    const leads = {
      findOrCreateForConversation: jest
        .fn()
        .mockResolvedValue({ id: 'lead-existing', stage: 'QUALIFIED' }),
    } as unknown as LeadsService;
    const campaigns = {
      markReplied: jest.fn().mockResolvedValue(undefined),
      findHumanManagedRecipient: jest
        .fn()
        .mockResolvedValue({ campaignId: 'campaign-1' }),
    } as unknown as CampaignsService;
    const autoReplies = { enqueue: jest.fn() } as unknown as AutoReplyService;
    const service = new WebhookService(
      { get: jest.fn() } as unknown as ConfigService,
      prismaMock as unknown as PrismaService,
      { sendTextMessage: jest.fn() } as unknown as MetaService,
      { generateResponse: jest.fn() } as unknown as HermesService,
      { create: jest.fn().mockResolvedValue({}) } as unknown as HandoffService,
      leads,
      campaigns,
      autoReplies,
      { inspect: jest.fn() } as unknown as ConversationGuardService,
      {
        claimReference: jest.fn().mockResolvedValue({ status: 'missing' }),
      } as unknown as AdvertisingService,
    );

    await (service as any).processIncomingMessage(
      {
        id: 'wamid.resumed',
        from: '593991234567',
        type: 'text',
        text: { body: 'Quiero retomar la cotización' },
      },
      { wa_id: '593991234567', profile: { name: 'Ana' } },
    );

    expect(prismaMock.conversation.create).not.toHaveBeenCalled();
    expect(prismaMock.conversation.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'conversation-closed' },
      data: { status: ConversationStatus.ACTIVE, closedAt: null },
    });
    expect(leads.findOrCreateForConversation).toHaveBeenCalledWith({
      contactId: 'contact-1',
      conversationId: 'conversation-closed',
    });
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'CONVERSATION_REOPENED',
          entityId: 'conversation-closed',
          changes: expect.objectContaining({ source: 'INBOUND_MESSAGE' }),
        }),
      }),
    );
  });

  it('preserves an open handoff when an inbound message resumes a closed conversation', async () => {
    const closedConversation = {
      id: 'conversation-closed',
      contactId: 'contact-1',
      status: ConversationStatus.CLOSED,
      closedAt: new Date('2026-09-18T18:00:00Z'),
    };
    const prismaMock = {
      $executeRaw: jest.fn(),
      conversation: {
        findFirst: jest.fn().mockResolvedValue(closedConversation),
        update: jest.fn().mockResolvedValue({
          ...closedConversation,
          status: ConversationStatus.HANDED_OFF,
          closedAt: null,
        }),
        create: jest.fn(),
      },
      humanHandoff: {
        findFirst: jest.fn().mockResolvedValue({ id: 'handoff-open' }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(),
    };
    prismaMock.$transaction.mockImplementation((callback: any) =>
      callback(prismaMock),
    );
    const service = new WebhookService(
      {} as ConfigService,
      prismaMock as unknown as PrismaService,
      {} as MetaService,
      {} as HermesService,
      {} as HandoffService,
      {} as LeadsService,
      {} as CampaignsService,
      {} as AutoReplyService,
      {} as ConversationGuardService,
      {} as AdvertisingService,
    );

    const result = await (service as any).getOrCreateConversation('contact-1');

    expect(result.status).toBe(ConversationStatus.HANDED_OFF);
    expect(prismaMock.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conversation-closed' },
      data: { status: ConversationStatus.HANDED_OFF, closedAt: null },
    });
    expect(prismaMock.conversation.create).not.toHaveBeenCalled();
  });
});
