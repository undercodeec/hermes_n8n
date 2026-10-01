/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
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
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    contact: { findUniqueOrThrow: jest.fn() },
    advertisingConversion: {
      upsert: jest.fn().mockResolvedValue({ id: 'conversion-1' }),
    },
    advertisingSyncJob: { upsert: jest.fn() },
    auditLog: { create: jest.fn() },
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
    get: jest.fn().mockReturnValue('https://admincrm.undercodeec.com'),
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
      commercialProfile: {
        service: 'Software a medida',
        need: 'Centralizar los pedidos',
        company: 'Distribuidora Ejemplo',
      },
    });

    expect(lead.stage).toBe(LeadStage.QUALIFIED);
    expect(tx.lead.create).not.toHaveBeenCalled();
    expect(tx.advertisingConversion.upsert).toHaveBeenCalledWith({
      where: {
        leadId_eventType: { leadId: 'lead-1', eventType: 'LEAD_QUALIFIED' },
      },
      create: expect.objectContaining({
        leadId: 'lead-1',
        eventType: 'LEAD_QUALIFIED',
        source: 'CRM_QUALIFICATION_RULES',
      }),
      update: {},
    });
    expect(tx.advertisingSyncJob.upsert).toHaveBeenCalledWith({
      where: { conversionId: 'conversion-1' },
      create: expect.objectContaining({
        conversionId: 'conversion-1',
        status: 'PENDING',
      }),
      update: {},
    });
    expect(events.emit).toHaveBeenCalledWith(
      'lead.qualified',
      expect.objectContaining({
        leadId: 'lead-1',
        contactName: 'Ada',
        waId: '593999999999',
        crmUrl: 'https://admincrm.undercodeec.com/leads/lead-1',
      }),
    );
  });

  it('persists a manual QUALIFIED transition and its outbox intent in one transaction', async () => {
    tx.lead.findUnique.mockResolvedValue({
      id: 'lead-manual',
      contactId: 'contact-1',
      stage: LeadStage.NEW,
    });
    tx.lead.update.mockResolvedValue({
      id: 'lead-manual',
      contactId: 'contact-1',
      conversationId: 'conversation-1',
      stage: LeadStage.QUALIFIED,
      contact: { name: 'Ada', waId: '593999999999' },
    });
    tx.advertisingConversion.upsert.mockResolvedValue({
      id: 'conversion-manual',
    });
    await service.update(
      'lead-manual',
      { stage: LeadStage.QUALIFIED },
      'operator-1',
    );
    expect(tx.advertisingConversion.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          leadId: 'lead-manual',
          source: 'CRM_STAGE_CHANGE',
        }),
      }),
    );
    expect(tx.advertisingSyncJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { conversionId: 'conversion-manual' } }),
    );
  });

  it('persists the milestone when an API lead is created directly as QUALIFIED', async () => {
    tx.lead.findFirst.mockResolvedValue(null);
    tx.lead.create.mockResolvedValue({
      id: 'lead-created-qualified',
      contactId: 'contact-1',
      stage: LeadStage.QUALIFIED,
      contact: { name: 'Ada', waId: '593999999999' },
    });
    await service.create({
      contactId: 'contact-1',
      stage: LeadStage.QUALIFIED,
    });
    expect(tx.advertisingConversion.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          leadId: 'lead-created-qualified',
          source: 'CRM_LEAD_CREATE',
        }),
      }),
    );
    expect(tx.advertisingSyncJob.upsert).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      'lead.qualified',
      expect.objectContaining({ leadId: 'lead-created-qualified' }),
    );
  });

  it('rejects a WON stage change without amount, currency and contract reference', async () => {
    tx.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      contactId: 'contact-1',
      stage: LeadStage.PROPOSAL,
      contractedAmount: null,
      commercialCurrency: null,
      contractReference: null,
    });
    await expect(
      service.update('lead-1', { stage: LeadStage.WON }, 'operator-1'),
    ).rejects.toThrow();
    expect(tx.lead.update).not.toHaveBeenCalled();
    expect(tx.advertisingConversion.upsert).not.toHaveBeenCalled();
  });

  it('commits a verified CONTRACT_WON milestone with a complete WON transition', async () => {
    tx.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      contactId: 'contact-1',
      stage: LeadStage.PROPOSAL,
      contractedAmount: null,
      commercialCurrency: null,
      contractReference: null,
    });
    tx.lead.update.mockResolvedValue({
      id: 'lead-1',
      contactId: 'contact-1',
      stage: LeadStage.WON,
      contractedAmount: 1200,
      commercialCurrency: 'USD',
      contractReference: 'contract-1',
      contact: { name: 'Ada', waId: '593999999999' },
    });
    tx.advertisingConversion.upsert.mockResolvedValue({
      id: 'conversion-won',
      value: 1200,
      currency: 'USD',
      commercialReference: 'contract-1',
    });
    await service.update(
      'lead-1',
      {
        stage: LeadStage.WON,
        contractedAmount: 1200,
        commercialCurrency: 'USD',
        contractReference: 'contract-1',
      },
      'operator-1',
    );
    expect(tx.advertisingConversion.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          leadId: 'lead-1',
          eventType: 'CONTRACT_WON',
          value: expect.anything(),
          currency: 'USD',
          commercialReference: 'contract-1',
          source: 'CRM_STAGE_CHANGE',
        }),
      }),
    );
    expect(tx.advertisingSyncJob.upsert).toHaveBeenCalledTimes(1);
  });

  it('rejects a conflicting WON milestone instead of changing the recorded sale', async () => {
    tx.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      contactId: 'contact-1',
      stage: LeadStage.PROPOSAL,
    });
    tx.lead.update.mockResolvedValue({
      id: 'lead-1',
      contactId: 'contact-1',
      stage: LeadStage.WON,
      contractedAmount: 1200,
      commercialCurrency: 'USD',
      contractReference: 'contract-1',
    });
    tx.advertisingConversion.upsert.mockResolvedValue({
      id: 'conversion-won',
      value: 900,
      currency: 'USD',
      commercialReference: 'contract-1',
    });
    await expect(
      service.update(
        'lead-1',
        {
          stage: LeadStage.WON,
          contractedAmount: 1200,
          commercialCurrency: 'USD',
          contractReference: 'contract-1',
        },
        'operator-1',
      ),
    ).rejects.toThrow('immutable');
    expect(tx.advertisingSyncJob.upsert).not.toHaveBeenCalled();
  });

  it('commits CONTRACT_LOST with its outbox intent on a LOST transition', async () => {
    tx.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      contactId: 'contact-1',
      stage: LeadStage.QUALIFIED,
    });
    tx.lead.update.mockResolvedValue({
      id: 'lead-1',
      contactId: 'contact-1',
      stage: LeadStage.LOST,
      lostReason: 'Budget',
    });
    tx.advertisingConversion.upsert.mockResolvedValue({
      id: 'conversion-lost',
    });
    await service.update(
      'lead-1',
      { stage: LeadStage.LOST, lostReason: 'Budget' },
      'operator-1',
    );
    expect(tx.advertisingConversion.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          eventType: 'CONTRACT_LOST',
          commercialReference: 'Budget',
        }),
      }),
    );
    expect(tx.advertisingSyncJob.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversionId: 'conversion-lost' },
      }),
    );
  });

  it('rejects silent edits to the value of an already WON lead', async () => {
    tx.lead.findUnique.mockResolvedValue({
      id: 'lead-1',
      contactId: 'contact-1',
      stage: LeadStage.WON,
      contractedAmount: 1200,
      commercialCurrency: 'USD',
      contractReference: 'contract-1',
    });
    await expect(
      service.update('lead-1', { contractedAmount: 1500 }, 'operator-1'),
    ).rejects.toThrow('immutable');
    expect(tx.lead.update).not.toHaveBeenCalled();
  });

  it('rejects creating a lead directly as WON without a verified contract', async () => {
    tx.lead.findFirst.mockResolvedValue(null);
    await expect(
      service.create({ contactId: 'contact-1', stage: LeadStage.WON }),
    ).rejects.toThrow();
    expect(tx.lead.create).not.toHaveBeenCalled();
  });
});
