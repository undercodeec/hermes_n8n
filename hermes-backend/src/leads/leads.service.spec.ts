/* eslint-disable @typescript-eslint/unbound-method */
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LeadStage } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../prisma/prisma.service';
import { LeadsService } from './leads.service';

describe('LeadsService', () => {
  const tx = {
    $executeRaw: jest.fn(),
    lead: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    contact: { findUniqueOrThrow: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  } as unknown as PrismaService;
  const events = { emit: jest.fn() } as unknown as EventEmitter2;
  const cls = {
    isActive: jest.fn().mockReturnValue(false),
  } as unknown as ClsService;
  const config = {
    get: jest.fn().mockReturnValue('https://example.com/admin/crm'),
  } as unknown as ConfigService;
  const service = new LeadsService(prisma, events, cls, config);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('crea exactamente un lead NEW para la primera conversación', async () => {
    tx.lead.findFirst.mockResolvedValue(null);
    tx.lead.create.mockResolvedValue({
      id: 'lead-1',
      contactId: 'contact-1',
      conversationId: 'conversation-1',
      stage: LeadStage.NEW,
    });

    const lead = await service.findOrCreateForConversation({
      contactId: 'contact-1',
      conversationId: 'conversation-1',
    });

    expect(lead.stage).toBe(LeadStage.NEW);
    expect(tx.lead.create).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      'lead.created',
      expect.objectContaining({ leadId: 'lead-1' }),
    );
  });

  it('reutiliza el lead existente sin crear duplicados', async () => {
    tx.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      contactId: 'contact-1',
      conversationId: 'conversation-1',
      stage: LeadStage.NEW,
    });

    await service.findOrCreateForConversation({
      contactId: 'contact-1',
      conversationId: 'conversation-1',
    });

    expect(tx.lead.create).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('promueve el mismo lead a QUALIFIED y amplía el evento para Telegram', async () => {
    const existing = {
      id: 'lead-1',
      contactId: 'contact-1',
      conversationId: 'conversation-1',
      stage: LeadStage.NEW,
      productOfInterest: null,
    };
    const qualified = {
      ...existing,
      stage: LeadStage.QUALIFIED,
      productOfInterest: 'Hermes',
      closeProbability: null,
    };
    tx.lead.findFirst.mockResolvedValue(existing);
    tx.lead.update.mockResolvedValue(qualified);
    tx.contact.findUniqueOrThrow.mockResolvedValue({
      name: 'Ada',
      waId: '593999999999',
    });

    const lead = await service.qualifyFromConversation({
      contactId: 'contact-1',
      conversationId: 'conversation-1',
      detectedIntent: 'cotizacion',
      productOfInterest: 'Hermes',
    });

    expect(lead.stage).toBe(LeadStage.QUALIFIED);
    expect(tx.lead.create).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(
      'lead.qualified',
      expect.objectContaining({
        leadId: 'lead-1',
        contactName: 'Ada',
        waId: '593999999999',
        crmUrl: 'https://example.com/admin/crm/leads/lead-1',
      }),
    );
  });
});
