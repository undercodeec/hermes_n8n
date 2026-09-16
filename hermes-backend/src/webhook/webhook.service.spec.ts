import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { HandoffReason } from '@prisma/client';
import { CampaignsService } from '../campaigns/campaigns.service';
import { HandoffService } from '../handoff/handoff.service';
import { HermesService } from '../hermes/hermes.service';
import { LeadsService } from '../leads/leads.service';
import { MetaService } from '../meta/meta.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookService } from './webhook.service';
import { AutoReplyService } from '../auto-replies/auto-reply.service';
import { ConversationGuardService } from '../conversation-guard/conversation-guard.service';

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
    );

    expect(service.validateSignature(payload, signature)).toBe(true);
    expect(service.validateSignature(payload, 'sha256=bad')).toBe(false);
  });

  it('sends a campaign reply to human handoff without invoking Hermes', async () => {
    const prisma = {
      contact: {
        upsert: jest
          .fn()
          .mockResolvedValue({
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
      message: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'inbound-1' }),
      },
    } as unknown as PrismaService;
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
  });
});
