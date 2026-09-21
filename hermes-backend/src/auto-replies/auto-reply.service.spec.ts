import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConversationStatus, MessageDirection } from '@prisma/client';
import { Queue } from 'bullmq';
import { AutoReplyService } from './auto-reply.service';
import { PrismaService } from '../prisma/prisma.service';
import { MetaService } from '../meta/meta.service';
import { ConversationEngineService } from '../conversation-engine/conversation-engine.service';
import { HandoffService } from '../handoff/handoff.service';
import { LeadsService } from '../leads/leads.service';
import {
  ConversationGuardService,
  GeneratedResponseDecision,
} from '../conversation-guard/conversation-guard.service';
import { TasksService } from '../tasks/tasks.service';
import { CommercialPolicyService } from '../hermes/commercial-policy.service';
import { AutoReplyJobData } from './auto-reply.constants';
import {
  CommercialProfile,
  HermesResponseDto,
} from '../hermes/dto/hermes-request.dto';

describe('AutoReplyService', () => {
  const toEngineResult = (response: HermesResponseDto) => ({
    replyText: response.response,
    proposedActions: [{ type: 'none' as const }],
    engine: 'gemini_direct' as const,
    providerModel: 'gemini-test',
    usage:
      response.tokensUsed === undefined
        ? undefined
        : { totalTokens: response.tokensUsed },
    traceId: 'inbound-recovery',
    costEstimate: response.costEstimate,
    business: {
      suggestedTags: response.suggestedTags,
      detectedIntent: response.detectedIntent,
      nextAction: response.nextAction,
      decision: response.decision,
      commercialProfile: response.commercialProfile,
    },
    diagnostic: response.diagnostic,
  });

  type ProcessHarnessOptions = {
    hermesResponse: HermesResponseDto;
    outputDecision?: GeneratedResponseDecision;
    reviewTask?: { id: string } | Error;
    persistedProfile?: CommercialProfile;
  };

  function setupProcessHarness(options: ProcessHarnessOptions): {
    service: AutoReplyService;
    meta: { sendTextMessage: jest.Mock; showTypingIndicator: jest.Mock };
    tasks: { requestHermesReview: jest.Mock; requestQuote: jest.Mock };
    leads: {
      recordCommercialProfileFromConversation: jest.Mock;
      qualifyFromConversation: jest.Mock;
    };
    handoffs: { create: jest.Mock };
    guard: { consumeAiQuota: jest.Mock; inspectGeneratedResponse: jest.Mock };
    messageCreate: jest.Mock;
    conversationUpdate: jest.Mock;
  } {
    const inbound = {
      id: 'inbound-recovery',
      wamid: 'wamid.inbound-recovery',
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      content: 'Necesito confirmar este punto',
      createdAt: new Date('2026-09-20T18:00:00.000Z'),
      rawPayload: null,
    };
    const messageCreate = jest.fn().mockResolvedValue({ id: 'outbound-1' });
    const conversationUpdate = jest.fn().mockResolvedValue({});
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
          id: 'conversation-1',
          status: ConversationStatus.ACTIVE,
          metadata: {},
          contact: { name: 'Ana', waId: '593991234567', email: null },
        }),
        update: conversationUpdate,
      },
      conversationState: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      lead: {
        findFirst: jest.fn().mockResolvedValue(
          options.persistedProfile
            ? {
                id: 'lead-1',
                metadata: { commercialProfile: options.persistedProfile },
              }
            : null,
        ),
      },
      task: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const meta = {
      showTypingIndicator: jest.fn().mockResolvedValue(undefined),
      sendTextMessage: jest
        .fn()
        .mockResolvedValue({ messages: [{ id: 'wamid.outbound' }] }),
    };
    const requestHermesReview =
      options.reviewTask instanceof Error
        ? jest.fn().mockRejectedValue(options.reviewTask)
        : jest
            .fn()
            .mockResolvedValue(options.reviewTask ?? { id: 'review-task-1' });
    const tasks = {
      requestHermesReview,
      requestQuote: jest.fn().mockResolvedValue({ id: 'quote-task-1' }),
    };
    const leads = {
      recordCommercialProfileFromConversation: jest.fn().mockResolvedValue({}),
      qualifyFromConversation: jest.fn().mockResolvedValue({}),
    };
    const guard = {
      consumeAiQuota: jest.fn().mockResolvedValue(true),
      inspectGeneratedResponse: jest
        .fn()
        .mockReturnValue(options.outputDecision ?? { action: 'ALLOW' }),
    };
    const handoffs = {
      create: jest.fn().mockResolvedValue({ id: 'handoff-1' }),
    };
    const service = new AutoReplyService(
      {
        get: jest.fn((key: string) =>
          key === 'AI_MESSAGE_PART_DELAY_MS' ? 0 : undefined,
        ),
      } as unknown as ConfigService,
      prisma,
      meta as unknown as MetaService,
      {
        respond: jest
          .fn()
          .mockResolvedValue(toEngineResult(options.hermesResponse)),
      } as unknown as ConversationEngineService,
      handoffs as unknown as HandoffService,
      leads as unknown as LeadsService,
      tasks as unknown as TasksService,
      new CommercialPolicyService(),
      guard as unknown as ConversationGuardService,
      { add: jest.fn() } as unknown as Queue,
    );
    return {
      service,
      meta,
      tasks,
      leads,
      handoffs,
      guard,
      messageCreate,
      conversationUpdate,
    };
  }

  it('keeps the internal Hermes incident visible to CRM and absent from customer copy', async () => {
    const harness = setupProcessHarness({
      hermesResponse: {
        response: 'Disculpe, no pude completar la respuesta en este momento.',
        detectedIntent: 'error',
        nextAction: 'sin_accion',
        diagnostic: {
          category: 'PROVIDER_ERROR',
          code: 'HERMES_PROVIDER_UNAVAILABLE',
          summary: 'HTTP 503',
          attempts: 2,
          recovered: false,
          requiresHumanReview: true,
        },
      },
    });
    const callOrder: string[] = [];
    harness.tasks.requestHermesReview.mockImplementation(async () => {
      callOrder.push('review-task');
      return { id: 'review-task-1' };
    });
    harness.meta.sendTextMessage.mockImplementation(async () => {
      callOrder.push('send');
      return { messages: [{ id: 'wamid.outbound' }] };
    });
    harness.messageCreate.mockImplementation(async () => {
      callOrder.push('persist');
      return { id: 'outbound-1' };
    });

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });

    expect(callOrder).toEqual(['review-task', 'send', 'persist']);
    expect(harness.meta.sendTextMessage).toHaveBeenCalledWith(
      '593991234567',
      expect.stringContaining(
        'Ya dejé registrado el caso para revisarlo y continuar por este mismo chat',
      ),
    );
    const customerCopy = harness.meta.sendTextMessage.mock
      .calls[0][1] as string;
    expect(customerCopy).not.toMatch(/HTTP 503|HERMES_PROVIDER_UNAVAILABLE/);
    expect(harness.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            hermesIncident: expect.objectContaining({
              taskId: 'review-task-1',
              sourceMessageId: 'inbound-recovery',
            }),
          }),
        }),
      }),
    );
    expect(harness.conversationUpdate).toHaveBeenCalledWith({
      where: { id: 'conversation-1' },
      data: {
        metadata: expect.objectContaining({
          lastHermesIncident: expect.objectContaining({
            code: 'HERMES_PROVIDER_UNAVAILABLE',
            summary: 'HTTP 503',
            taskId: 'review-task-1',
          }),
        }),
      },
    });
  });

  it('creates a review before promising confirmation of a missing commercial fact', async () => {
    const harness = setupProcessHarness({
      hermesResponse: {
        response:
          'El valor específico requiere una valoración según el alcance solicitado.',
        detectedIntent: 'consulta_precio',
        nextAction: 'sin_accion',
        diagnostic: {
          category: 'POLICY_VIOLATION',
          code: 'UNAUTHORIZED_PRICE',
          summary: 'No existe un valor autorizado',
          attempts: 2,
          recovered: true,
          requiresHumanReview: true,
        },
      },
    });

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });

    expect(harness.tasks.requestHermesReview).toHaveBeenCalledTimes(1);
    expect(harness.meta.sendTextMessage).toHaveBeenCalledWith(
      '593991234567',
      expect.stringContaining(
        'Permítame consultar este punto con el equipo. Le confirmaremos por este mismo chat',
      ),
    );
  });

  it('does not persist an outbound reply when Meta returns no wamid', async () => {
    const harness = setupProcessHarness({
      hermesResponse: {
        response: 'Podemos ayudarle con su sitio web.',
        detectedIntent: 'consulta_servicio',
        nextAction: 'continuar_descubrimiento',
      },
    });
    harness.meta.sendTextMessage.mockResolvedValue(null);

    await expect(
      harness.service.process({
        conversationId: 'conversation-1',
        contactId: 'contact-1',
        inboundMessageId: 'inbound-recovery',
      }),
    ).rejects.toThrow('Meta no confirmó el envío del mensaje');

    expect(harness.messageCreate).not.toHaveBeenCalled();
    expect(harness.conversationUpdate).not.toHaveBeenCalled();
  });

  it('records when an automatic reply is skipped by the AI quota', async () => {
    const harness = setupProcessHarness({
      hermesResponse: {
        response: 'Podemos ayudarle con su sitio web.',
        detectedIntent: 'consulta_servicio',
        nextAction: 'continuar_descubrimiento',
      },
    });
    harness.guard.consumeAiQuota.mockResolvedValue(false);
    const warn = jest.spyOn(
      (harness.service as unknown as { logger: Logger }).logger,
      'warn',
    );

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });

    const event = JSON.parse(warn.mock.calls.at(-1)?.[0] as string);
    expect(event).toEqual(
      expect.objectContaining({
        event: 'auto_reply_skipped',
        reason: 'AI_QUOTA_EXCEEDED',
        conversationId: 'conversation-1',
        correlationId: 'inbound-recovery',
      }),
    );
    expect(harness.meta.sendTextMessage).not.toHaveBeenCalled();
  });

  it('backs an accepted follow-up promise with a review task before sending', async () => {
    const harness = setupProcessHarness({
      hermesResponse: {
        response:
          'Permítame consultar este punto con el equipo. Le confirmaremos por este mismo chat.',
        detectedIntent: 'consulta_precio',
        nextAction: 'sin_accion',
      },
    });
    const order: string[] = [];
    harness.tasks.requestHermesReview.mockImplementation(async () => {
      order.push('review-task');
      return { id: 'review-task-1' };
    });
    harness.meta.sendTextMessage.mockImplementation(async () => {
      order.push('send');
      return { messages: [{ id: 'wamid.outbound' }] };
    });

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });

    expect(order.slice(0, 2)).toEqual(['review-task', 'send']);
    expect(harness.tasks.requestHermesReview).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'HERMES_UNBACKED_FOLLOWUP_PROMISE' }),
    );
  });

  it('does not promise review when the Hermes review task fails', async () => {
    const harness = setupProcessHarness({
      hermesResponse: {
        response: 'Disculpe, no pude completar la respuesta en este momento.',
        detectedIntent: 'error',
        nextAction: 'sin_accion',
        diagnostic: {
          category: 'PROVIDER_ERROR',
          code: 'HERMES_PROVIDER_UNAVAILABLE',
          summary: 'HTTP 503',
          attempts: 2,
          recovered: false,
          requiresHumanReview: true,
        },
      },
      reviewTask: new Error('database unavailable'),
    });

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });

    const sent = harness.meta.sendTextMessage.mock.calls[0][1] as string;
    expect(sent).toContain('enviar nuevamente su mensaje');
    expect(sent).not.toMatch(/equipo|revisar|confirmaremos|registrado/i);
  });

  it('persists a recovered policy incident without creating a review task', async () => {
    const harness = setupProcessHarness({
      hermesResponse: {
        response:
          'UnderCodeEC trabaja de forma remota y su sede principal está en Quito, Ecuador.',
        detectedIntent: 'info_general',
        nextAction: 'sin_accion',
        diagnostic: {
          category: 'POLICY_VIOLATION',
          code: 'UNAUTHORIZED_LOCATION_DETAIL',
          summary: 'Se reemplazó una ubicación no autorizada',
          attempts: 2,
          recovered: true,
          requiresHumanReview: false,
        },
      },
    });

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });

    expect(harness.tasks.requestHermesReview).not.toHaveBeenCalled();
    expect(harness.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            hermesIncident: expect.objectContaining({
              code: 'UNAUTHORIZED_LOCATION_DETAIL',
            }),
          }),
        }),
      }),
    );
    expect(harness.conversationUpdate.mock.calls).not.toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            data: expect.objectContaining({ status: expect.anything() }),
          }),
        ],
      ]),
    );
  });

  it('does not execute handoff or lead qualification from rejected response metadata', async () => {
    const handoffHarness = setupProcessHarness({
      hermesResponse: {
        response:
          'UnderCodeEC trabaja de forma remota y su sede principal está en Quito, Ecuador.',
        detectedIntent: 'solicitud_humano',
        nextAction: 'derivar_humano',
        diagnostic: {
          category: 'POLICY_VIOLATION',
          code: 'UNAUTHORIZED_LOCATION_DETAIL',
          summary: 'Se descartó la intención del candidato rechazado',
          attempts: 2,
          recovered: true,
          requiresHumanReview: false,
        },
      },
    });
    const qualificationHarness = setupProcessHarness({
      hermesResponse: {
        response: 'El valor requiere una valoración del alcance.',
        detectedIntent: 'consulta_precio',
        nextAction: 'sin_accion',
        diagnostic: {
          category: 'POLICY_VIOLATION',
          code: 'UNAUTHORIZED_PRICE',
          summary: 'Se descartó la intención del candidato rechazado',
          attempts: 2,
          recovered: true,
          requiresHumanReview: false,
        },
      },
    });

    await handoffHarness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });
    await qualificationHarness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });

    expect(handoffHarness.handoffs.create).not.toHaveBeenCalled();
    expect(
      qualificationHarness.leads.qualifyFromConversation,
    ).not.toHaveBeenCalled();
  });

  it('replaces unsafe structured output without sending the original content', async () => {
    const unsafe = '{"response":"internal payload"}';
    const harness = setupProcessHarness({
      hermesResponse: {
        response: unsafe,
        detectedIntent: 'info_general',
        nextAction: 'sin_accion',
      },
      outputDecision: { action: 'BLOCK', reason: 'STRUCTURED_PAYLOAD' },
    });

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });

    const sent = harness.meta.sendTextMessage.mock.calls[0][1] as string;
    expect(sent).not.toContain(unsafe);
    expect(harness.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            hermesIncident: expect.objectContaining({
              category: 'OUTPUT_BLOCKED',
              code: 'HERMES_OUTPUT_STRUCTURED_PAYLOAD',
            }),
          }),
        }),
      }),
    );
  });

  it('does not persist rejected profile fields from a recovered response', async () => {
    const harness = setupProcessHarness({
      persistedProfile: { service: 'sitio web' },
      hermesResponse: {
        response: 'Podemos continuar con una respuesta autorizada.',
        detectedIntent: 'consulta_servicio',
        nextAction: 'sin_accion',
        commercialProfile: {
          service: 'sitio web',
          company: 'Inventada SA',
          budget: 'USD $9999',
          recommendedPlan: 'Plan inventado',
        },
        diagnostic: {
          category: 'POLICY_VIOLATION',
          code: 'UNAUTHORIZED_PRICE',
          summary: 'Perfil rechazado con la salida',
          attempts: 2,
          recovered: true,
          requiresHumanReview: false,
        },
      },
    });

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });

    const persistedProfile =
      harness.leads.recordCommercialProfileFromConversation.mock.calls[0][0]
        .profile;
    expect(persistedProfile).toEqual(
      expect.objectContaining({ service: 'sitio web' }),
    );
    expect(persistedProfile).not.toEqual(
      expect.objectContaining({ company: 'Inventada SA' }),
    );
    expect(persistedProfile).not.toEqual(
      expect.objectContaining({ budget: 'USD $9999' }),
    );
  });

  it('never converts a technical Hermes error into a human handoff', () => {
    const service = new AutoReplyService(
      {
        get: jest.fn((_key: string, fallback?: unknown) => fallback),
      } as unknown as ConfigService,
      {} as PrismaService,
      {} as MetaService,
      {} as ConversationEngineService,
      {} as HandoffService,
      {} as LeadsService,
      {} as TasksService,
      new CommercialPolicyService(),
      {} as ConversationGuardService,
      {} as Queue,
    );

    expect(
      (service as any).checkHandoffSignals('Mostrar servisiso', 'error'),
    ).toBe(false);
  });

  it('schedules the first automatic reply with a ten-second pause', async () => {
    const add = jest.fn().mockResolvedValue({});
    const queue = { add } as unknown as Queue<AutoReplyJobData>;
    const service = new AutoReplyService(
      { get: jest.fn() } as unknown as ConfigService,
      {
        message: { findFirst: jest.fn().mockResolvedValue(null) },
      } as unknown as PrismaService,
      {} as MetaService,
      {} as ConversationEngineService,
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
      {} as ConversationEngineService,
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
    const engine = {
      respond: jest.fn(),
    } as unknown as ConversationEngineService;
    const service = new AutoReplyService(
      { get: jest.fn() } as unknown as ConfigService,
      prisma,
      meta,
      engine,
      { create: jest.fn() } as unknown as HandoffService,
      { qualifyFromConversation: jest.fn() } as unknown as LeadsService,
      { requestCallback: jest.fn() } as unknown as TasksService,
      new CommercialPolicyService(),
      { consumeAiQuota: jest.fn() } as unknown as ConversationGuardService,
      { add: jest.fn() } as unknown as Queue,
    );
    const warn = jest.spyOn(
      (service as unknown as { logger: Logger }).logger,
      'warn',
    );

    await service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-1',
    });

    expect(engine.respond).not.toHaveBeenCalled();
    expect(meta.sendTextMessage).not.toHaveBeenCalled();
    expect(JSON.parse(warn.mock.calls[0][0] as string)).toEqual(
      expect.objectContaining({
        event: 'auto_reply_skipped',
        reason: 'NEWER_INBOUND',
        conversationId: 'conversation-1',
        correlationId: 'inbound-1',
      }),
    );
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
    const engine = {
      respond: jest.fn(),
    } as unknown as ConversationEngineService;
    const service = new AutoReplyService(
      { get: jest.fn() } as unknown as ConfigService,
      prisma,
      meta,
      engine,
      {} as HandoffService,
      {} as LeadsService,
      {} as TasksService,
      new CommercialPolicyService(),
      {} as ConversationGuardService,
      { add: jest.fn() } as unknown as Queue,
    );
    const warn = jest.spyOn(
      (service as unknown as { logger: Logger }).logger,
      'warn',
    );

    await service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-1',
    });

    expect(engine.respond).not.toHaveBeenCalled();
    expect(meta.sendTextMessage).not.toHaveBeenCalled();
    expect(JSON.parse(warn.mock.calls[0][0] as string)).toEqual(
      expect.objectContaining({
        event: 'auto_reply_skipped',
        reason: 'CONVERSATION_NOT_ACTIVE',
        status: ConversationStatus.CLOSED,
      }),
    );
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
    const engine = {
      respond: jest.fn(),
    } as unknown as ConversationEngineService;
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
      engine,
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
    expect(engine.respond).not.toHaveBeenCalled();
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
      { respond: jest.fn() } as unknown as ConversationEngineService,
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
    const engine = {
      respond: jest.fn().mockResolvedValue(
        toEngineResult({
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
      ),
    } as unknown as ConversationEngineService;
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
      engine,
      { create: jest.fn() } as unknown as HandoffService,
      leads,
      tasks,
      new CommercialPolicyService(),
      {
        consumeAiQuota: jest.fn().mockResolvedValue(true),
        inspectGeneratedResponse: jest
          .fn()
          .mockReturnValue({ action: 'ALLOW' }),
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
    expect(engine.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedContext: expect.objectContaining({
          conversationSummary: 'Cliente busca vender flores por internet.',
          recentMessages: [
            {
              role: 'user',
              text: 'Necesito una web para mi floristería',
            },
          ],
          commercialProfile: expect.objectContaining({
            service: 'desarrollo web',
            need: 'catálogo de diez productos con botón de WhatsApp',
          }),
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

  it('sends and persists a long reply without loss in bounded messages', async () => {
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
        respond: jest.fn().mockResolvedValue(
          toEngineResult({
            response: longResponse,
            detectedIntent: 'info_general',
            nextAction: 'sin_accion',
            tokensUsed: 100,
            costEstimate: 0.01,
          }),
        ),
      } as unknown as ConversationEngineService,
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
        inspectGeneratedResponse: jest
          .fn()
          .mockReturnValue({ action: 'ALLOW' }),
      } as unknown as ConversationGuardService,
      { add: jest.fn() } as unknown as Queue,
    );

    await service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-long',
    });

    const sentParts = (meta.sendTextMessage as jest.Mock).mock.calls.map(
      (call) => call[1],
    );
    expect(sentParts.length).toBeLessThanOrEqual(9);
    expect(messageCreate).toHaveBeenCalledTimes(sentParts.length);
    expect(sentParts.every((part) => part.length <= 1000)).toBe(true);
    expect(sentParts.join(' ')).toBe(longResponse);
  });
});
