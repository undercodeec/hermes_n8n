import { ConfigService } from '@nestjs/config';
import { ConversationStatus, MessageDirection } from '@prisma/client';
import { Queue } from 'bullmq';
import { AutoReplyService } from './auto-reply.service';
import { PrismaService } from '../prisma/prisma.service';
import { MetaService } from '../meta/meta.service';
import { HermesService } from '../hermes/hermes.service';
import { HandoffService } from '../handoff/handoff.service';
import { LeadsService } from '../leads/leads.service';
import { ConversationGuardService } from '../conversation-guard/conversation-guard.service';
import { TasksService } from '../tasks/tasks.service';
import { CommercialPolicyService } from '../hermes/commercial-policy.service';
import { AutoReplyJobData } from './auto-reply.constants';

describe('AutoReplyService', () => {
  it('schedules the first automatic reply with a ten-second pause', async () => {
    const add = jest.fn().mockResolvedValue({});
    const queue = { add } as unknown as Queue<AutoReplyJobData>;
    const service = new AutoReplyService(
      { get: jest.fn() } as unknown as ConfigService,
      {
        message: { findFirst: jest.fn().mockResolvedValue(null) },
      } as unknown as PrismaService,
      {} as MetaService,
      {} as HermesService,
      {} as HandoffService,
      {} as LeadsService,
      {} as TasksService,
      new CommercialPolicyService(),
      {} as ConversationGuardService,
      queue,
    );
    const data = {
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-1',
    };

    await service.enqueue(data, 500);

    expect(add).toHaveBeenCalledWith(
      'send-auto-reply',
      data,
      expect.objectContaining({ delay: 10_000 }),
    );
  });

  it('keeps the regular delay after Hermes has already replied', async () => {
    const add = jest.fn().mockResolvedValue({});
    const service = new AutoReplyService(
      { get: jest.fn() } as unknown as ConfigService,
      {
        message: {
          findFirst: jest.fn().mockResolvedValue({ id: 'outbound-1' }),
        },
      } as unknown as PrismaService,
      {} as MetaService,
      {} as HermesService,
      {} as HandoffService,
      {} as LeadsService,
      {} as TasksService,
      new CommercialPolicyService(),
      {} as ConversationGuardService,
      { add } as unknown as Queue<AutoReplyJobData>,
    );

    await service.enqueue(
      {
        conversationId: 'conversation-1',
        contactId: 'contact-1',
        inboundMessageId: 'inbound-2',
      },
      40,
    );

    expect(add).toHaveBeenCalledWith(
      'send-auto-reply',
      expect.any(Object),
      expect.objectContaining({ delay: 2000 }),
    );
  });

  it('does not answer an older message when the customer wrote again', async () => {
    const prisma = {
      message: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'inbound-1',
          conversationId: 'conversation-1',
          contactId: 'contact-1',
          content: 'Hola',
          createdAt: new Date('2026-09-18T20:00:00Z'),
          rawPayload: { timestamp: '1789761600' },
        }),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'inbound-2',
            createdAt: new Date('2026-09-18T20:01:00Z'),
            rawPayload: { timestamp: '1789761660' },
          },
        ]),
      },
      conversation: {
        findUnique: jest.fn().mockResolvedValue({
          status: ConversationStatus.ACTIVE,
          contact: { name: 'Ana', waId: '593991234567' },
        }),
      },
    } as unknown as PrismaService;
    const meta = { sendTextMessage: jest.fn() } as unknown as MetaService;
    const hermes = { generateResponse: jest.fn() } as unknown as HermesService;
    const service = new AutoReplyService(
      { get: jest.fn() } as unknown as ConfigService,
      prisma,
      meta,
      hermes,
      { create: jest.fn() } as unknown as HandoffService,
      { qualifyFromConversation: jest.fn() } as unknown as LeadsService,
      { requestCallback: jest.fn() } as unknown as TasksService,
      new CommercialPolicyService(),
      { consumeAiQuota: jest.fn() } as unknown as ConversationGuardService,
      { add: jest.fn() } as unknown as Queue,
    );

    await service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-1',
    });

    expect(hermes.generateResponse).not.toHaveBeenCalled();
    expect(meta.sendTextMessage).not.toHaveBeenCalled();
  });

  it('does not answer a queued job after the conversation was closed', async () => {
    const prisma = {
      message: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'inbound-1',
          conversationId: 'conversation-1',
          contactId: 'contact-1',
          content: 'Hola',
          createdAt: new Date(),
          rawPayload: null,
        }),
      },
      conversation: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'conversation-1',
          status: ConversationStatus.CLOSED,
          contact: { name: 'Ana', waId: '593991234567' },
        }),
      },
    } as unknown as PrismaService;
    const meta = { sendTextMessage: jest.fn() } as unknown as MetaService;
    const hermes = { generateResponse: jest.fn() } as unknown as HermesService;
    const service = new AutoReplyService(
      { get: jest.fn() } as unknown as ConfigService,
      prisma,
      meta,
      hermes,
      {} as HandoffService,
      {} as LeadsService,
      {} as TasksService,
      new CommercialPolicyService(),
      {} as ConversationGuardService,
      { add: jest.fn() } as unknown as Queue,
    );

    await service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-1',
    });

    expect(hermes.generateResponse).not.toHaveBeenCalled();
    expect(meta.sendTextMessage).not.toHaveBeenCalled();
  });

  it('creates a pending callback task and reuses the WhatsApp number', async () => {
    const inbound = {
      id: 'inbound-call',
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      content: 'Quiero que me llamen',
      createdAt: new Date('2026-09-18T20:00:00Z'),
      rawPayload: { timestamp: '1789761600' },
    };
    const prisma = {
      message: {
        findUnique: jest.fn().mockResolvedValue(inbound),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([inbound])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([inbound]),
        create: jest.fn().mockResolvedValue({ id: 'outbound-1' }),
      },
      conversation: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'conversation-1',
          status: ConversationStatus.ACTIVE,
          contact: {
            name: 'Ana',
            waId: '593991234567',
            email: null,
          },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      conversationState: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      lead: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'lead-1', metadata: null }),
      },
      task: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const meta = {
      sendTextMessage: jest
        .fn()
        .mockResolvedValue({ messages: [{ id: 'wamid.outbound' }] }),
    } as unknown as MetaService;
    const hermes = { generateResponse: jest.fn() } as unknown as HermesService;
    const tasks = {
      requestCallback: jest.fn().mockResolvedValue({ id: 'task-1' }),
    } as unknown as TasksService;
    const leads = {
      recordCommercialProfileFromConversation: jest.fn().mockResolvedValue({}),
    } as unknown as LeadsService;
    const guard = {
      consumeAiQuota: jest.fn(),
    } as unknown as ConversationGuardService;
    const service = new AutoReplyService(
      { get: jest.fn() } as unknown as ConfigService,
      prisma,
      meta,
      hermes,
      { create: jest.fn() } as unknown as HandoffService,
      leads,
      tasks,
      new CommercialPolicyService(),
      guard,
      { add: jest.fn() } as unknown as Queue,
    );

    await service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-call',
    });

    expect(tasks.requestCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        sourceMessageId: 'inbound-call',
      }),
    );
    expect(meta.sendTextMessage).toHaveBeenCalledWith(
      '593991234567',
      expect.stringContaining('este mismo número de WhatsApp'),
    );
    expect(hermes.generateResponse).not.toHaveBeenCalled();
    expect(guard.consumeAiQuota).not.toHaveBeenCalled();
  });

  it('creates human handoff before acknowledging it', async () => {
    const inbound = {
      id: 'inbound-human',
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      content: 'Quiero hablar con una persona',
      createdAt: new Date('2026-09-18T20:00:00Z'),
      rawPayload: { timestamp: '1789761600' },
    };
    const callOrder: string[] = [];
    const prisma = {
      message: {
        findUnique: jest.fn().mockResolvedValue(inbound),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([inbound])
          .mockResolvedValueOnce([]),
        create: jest.fn().mockImplementation(async () => {
          callOrder.push('persist');
          return { id: 'outbound-1' };
        }),
      },
      conversation: {
        findUnique: jest.fn().mockResolvedValue({
          status: ConversationStatus.ACTIVE,
          contact: { name: 'Ana', waId: '593991234567', email: null },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      conversationState: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-1' }) },
      task: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const handoff = {
      create: jest.fn().mockImplementation(async () => {
        callOrder.push('handoff');
        return { id: 'handoff-1' };
      }),
    } as unknown as HandoffService;
    const meta = {
      sendTextMessage: jest.fn().mockImplementation(async () => {
        callOrder.push('send');
        return { messages: [{ id: 'wamid.outbound' }] };
      }),
    } as unknown as MetaService;
    const service = new AutoReplyService(
      { get: jest.fn() } as unknown as ConfigService,
      prisma,
      meta,
      { generateResponse: jest.fn() } as unknown as HermesService,
      handoff,
      {} as LeadsService,
      {} as TasksService,
      new CommercialPolicyService(),
      { consumeAiQuota: jest.fn() } as unknown as ConversationGuardService,
      { add: jest.fn() } as unknown as Queue,
    );

    await service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-human',
    });

    expect(callOrder).toEqual(['handoff', 'send', 'persist']);
  });

  it('creates a real quote task instead of extending discovery when scope is sufficient', async () => {
    const inbound = {
      id: 'inbound-price',
      wamid: 'wamid.inbound-price',
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      content: '¿Cuánto cuesta?',
      createdAt: new Date('2026-09-18T20:00:00Z'),
      rawPayload: { timestamp: '1789761600' },
    };
    const prisma = {
      message: {
        findUnique: jest.fn().mockResolvedValue(inbound),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([inbound])
          .mockResolvedValueOnce([
            {
              direction: MessageDirection.INBOUND,
              content: 'Necesito una web para mi floristería',
              createdAt: new Date('2026-09-18T19:55:00Z'),
              rawPayload: { timestamp: '1789761300' },
            },
          ])
          .mockResolvedValueOnce([inbound]),
        create: jest.fn().mockResolvedValue({ id: 'outbound-1' }),
      },
      conversation: {
        findUnique: jest.fn().mockResolvedValue({
          status: ConversationStatus.ACTIVE,
          contact: { name: 'Ana', waId: '593991234567', email: null },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      conversationState: {
        findUnique: jest.fn().mockResolvedValue({
          summary: 'Cliente busca vender flores por internet.',
        }),
        upsert: jest.fn().mockResolvedValue({}),
      },
      lead: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'lead-1',
          metadata: {
            commercialProfile: {
              service: 'desarrollo web',
              need: 'catálogo de diez productos con botón de WhatsApp',
              sector: 'floristería',
            },
          },
        }),
      },
      task: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const meta = {
      showTypingIndicator: jest.fn().mockResolvedValue(undefined),
      sendTextMessage: jest
        .fn()
        .mockResolvedValue({ messages: [{ id: 'wamid.outbound' }] }),
    } as unknown as MetaService;
    const hermes = {
      generateResponse: jest.fn().mockResolvedValue({
        response:
          'Para darte un precio preciso, necesitaríamos conversar sobre más detalles.',
        detectedIntent: 'consulta_precio',
        nextAction: 'continuar_descubrimiento',
        commercialProfile: {
          service: 'desarrollo web',
          need: 'catálogo de diez productos con botón de WhatsApp',
          sector: 'floristería',
        },
      }),
    } as unknown as HermesService;
    const tasks = {
      requestQuote: jest.fn().mockResolvedValue({ id: 'quote-task-1' }),
    } as unknown as TasksService;
    const leads = {
      recordCommercialProfileFromConversation: jest.fn().mockResolvedValue({
        metadata: {},
      }),
      qualifyFromConversation: jest.fn().mockResolvedValue({}),
    } as unknown as LeadsService;
    const service = new AutoReplyService(
      { get: jest.fn() } as unknown as ConfigService,
      prisma,
      meta,
      hermes,
      { create: jest.fn() } as unknown as HandoffService,
      leads,
      tasks,
      new CommercialPolicyService(),
      {
        consumeAiQuota: jest.fn().mockResolvedValue(true),
        isSafeGeneratedResponse: jest.fn().mockReturnValue(true),
      } as unknown as ConversationGuardService,
      { add: jest.fn() } as unknown as Queue,
    );

    await service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-price',
    });

    expect(tasks.requestQuote).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMessageId: 'inbound-price' }),
    );
    expect(hermes.generateResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationSummary: 'Cliente busca vender flores por internet.',
        conversationHistory: [
          {
            role: 'user',
            content: 'Necesito una web para mi floristería',
          },
        ],
        commercialProfile: expect.objectContaining({
          service: 'desarrollo web',
          need: 'catálogo de diez productos con botón de WhatsApp',
        }),
      }),
    );
    expect(meta.showTypingIndicator).toHaveBeenCalledWith(
      'wamid.inbound-price',
    );
    expect(meta.sendTextMessage).toHaveBeenCalledWith(
      '593991234567',
      expect.stringContaining('He registrado una solicitud de cotización'),
    );
  });

  it('sends and persists a long reply as at most three ordered messages', async () => {
    const inbound = {
      id: 'inbound-long',
      wamid: 'wamid.inbound-long',
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      content: 'Explíqueme cómo funciona.',
      createdAt: new Date('2026-09-18T20:00:00Z'),
      rawPayload: null,
    };
    const longResponse = [
      'La primera parte explica el concepto de forma sencilla para el cliente.',
      'La segunda parte relaciona ese concepto directamente con su negocio y su objetivo.',
      'La tercera parte completa la información necesaria sin convertir la respuesta en una lista interminable.',
      'Finalmente se indica el siguiente paso de manera natural y sin repetir preguntas.',
    ].join(' ');
    const messageCreate = jest.fn().mockResolvedValue({ id: 'outbound' });
    const prisma = {
      message: {
        findUnique: jest.fn().mockResolvedValue(inbound),
        findMany: jest
          .fn()
          .mockImplementation(async (args) =>
            args.where?.NOT ? [] : [inbound],
          ),
        create: messageCreate,
      },
      conversation: {
        findUnique: jest.fn().mockResolvedValue({
          status: ConversationStatus.ACTIVE,
          contact: { name: 'Ana', waId: '593991234567', email: null },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      conversationState: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      lead: { findFirst: jest.fn().mockResolvedValue(null) },
      task: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const meta = {
      showTypingIndicator: jest.fn().mockResolvedValue(undefined),
      sendTextMessage: jest
        .fn()
        .mockResolvedValue({ messages: [{ id: 'wamid.outbound' }] }),
    } as unknown as MetaService;
    const service = new AutoReplyService(
      {
        get: jest.fn((key: string) => {
          if (key === 'AI_MESSAGE_SPLIT_THRESHOLD') return 120;
          if (key === 'AI_MESSAGE_PART_DELAY_MS') return 0;
          return undefined;
        }),
      } as unknown as ConfigService,
      prisma,
      meta,
      {
        generateResponse: jest.fn().mockResolvedValue({
          response: longResponse,
          detectedIntent: 'info_general',
          nextAction: 'sin_accion',
          tokensUsed: 100,
          costEstimate: 0.01,
        }),
      } as unknown as HermesService,
      { create: jest.fn() } as unknown as HandoffService,
      {
        recordCommercialProfileFromConversation: jest
          .fn()
          .mockResolvedValue({}),
      } as unknown as LeadsService,
      {} as TasksService,
      new CommercialPolicyService(),
      {
        consumeAiQuota: jest.fn().mockResolvedValue(true),
        isSafeGeneratedResponse: jest.fn().mockReturnValue(true),
      } as unknown as ConversationGuardService,
      { add: jest.fn() } as unknown as Queue,
    );

    await service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-long',
    });

    expect(meta.sendTextMessage).toHaveBeenCalledTimes(3);
    expect(messageCreate).toHaveBeenCalledTimes(3);
    const sentParts = (meta.sendTextMessage as jest.Mock).mock.calls.map(
      (call) => call[1],
    );
    expect(sentParts.join(' ')).toBe(longResponse);
  });
});
