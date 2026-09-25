/* eslint-disable
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/require-await,
  @typescript-eslint/unbound-method
  -- This integration-style unit suite uses dynamic Nest, Prisma, and BullMQ doubles. */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  CommercialMarket,
  CommercialPriceType,
  CommercialTaxMode,
  ConversationStatus,
  MessageDirection,
} from '@prisma/client';
import { Queue } from 'bullmq';
import { AutoReplyService } from './auto-reply.service';
import { PrismaService } from '../prisma/prisma.service';
import { MetaMediaUploadError, MetaService } from '../meta/meta.service';
import { ConversationEngineService } from '../conversation-engine/conversation-engine.service';
import { HandoffService } from '../handoff/handoff.service';
import { LeadsService } from '../leads/leads.service';
import {
  ConversationGuardService,
  GeneratedResponseDecision,
} from '../conversation-guard/conversation-guard.service';
import { TasksService } from '../tasks/tasks.service';
import { CommercialPolicyService } from '../hermes/commercial-policy.service';
import {
  AuthorizedOffer,
  CommercialAuthorityService,
} from '../hermes/commercial-authority.service';
import { AutoReplyJobData } from './auto-reply.constants';
import {
  CommercialProfile,
  HermesResponseDto,
} from '../hermes/dto/hermes-request.dto';
import { AutomatedDeliveryService } from '../automated-deliveries/automated-delivery.service';
import { PrepareAutomatedDeliveryBatch } from '../automated-deliveries/automated-delivery.types';
import { InboundTurnService } from './inbound-turn.service';
import { VoiceProcessingError, VoiceService } from '../voice/voice.service';
import { AgentOutputValidator } from '../conversation-engine/agent-output.validator';
import { NousHermesTransport } from '../conversation-engine/nous-hermes.transport';

describe('AutoReplyService', () => {
  const testOffer = (
    name: string,
    amount: string,
    serviceCode: string,
  ): AuthorizedOffer => ({
    id: name,
    name,
    serviceCode,
    market: CommercialMarket.EC,
    marketScope: 'MARKET',
    priceType: CommercialPriceType.FIXED,
    amount,
    currency: 'USD',
    taxMode: CommercialTaxMode.INCLUDED,
    taxLabel: 'IVA',
    scope: 'Fixture de prueba',
    policyVersion: 'test-only',
    promotion: false,
  });
  const authority = {
    snapshot: jest.fn().mockResolvedValue({
      marketSource: 'UNKNOWN',
      relevantServiceCodes: [],
      offers: [],
      needsMarketClarification: false,
    }),
  } as unknown as CommercialAuthorityService;
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

  function passthroughDeliveries(
    metaService: MetaService,
    messageCreate: jest.Mock = jest
      .fn()
      .mockResolvedValue({ id: 'outbound-1' }),
  ): AutomatedDeliveryService {
    let prepared: PrepareAutomatedDeliveryBatch | undefined;
    const sendTextMessage = (
      metaService as unknown as { sendTextMessage: jest.Mock }
    ).sendTextMessage;
    return {
      recoverBatch: jest.fn().mockResolvedValue(null),
      prepareBatch: jest.fn().mockImplementation(async (input) => {
        prepared = input;
      }),
      deliverPreparedBatch: jest.fn().mockImplementation(async () => {
        if (!prepared) throw new Error('delivery batch was not prepared');
        for (const part of prepared.parts) {
          const sent = await sendTextMessage('593991234567', part.content);
          const wamid = sent?.messages?.[0]?.id;
          if (!wamid) throw new Error('Meta no confirmó el envío del mensaje');
          await messageCreate({
            data: {
              conversationId: prepared.conversationId,
              contactId: prepared.contactId,
              direction: 'OUTBOUND',
              sender: prepared.sender,
              type: 'TEXT',
              content: part.content,
              wamid,
              metadata: part.metadata,
            },
          });
        }
        return {
          handled: true,
          confirmed: prepared.parts.length,
          terminal: true,
        };
      }),
    } as unknown as AutomatedDeliveryService;
  }

  type ProcessHarnessOptions = {
    hermesResponse: HermesResponseDto;
    inboundContent?: string;
    outputDecision?: GeneratedResponseDecision;
    reviewTask?: { id: string } | Error;
    persistedProfile?: CommercialProfile;
  };

  function setupProcessHarness(options: ProcessHarnessOptions): {
    service: AutoReplyService;
    meta: {
      sendTextMessage: jest.Mock;
      showTypingIndicator: jest.Mock;
      uploadVoiceNote: jest.Mock;
    };
    tasks: {
      requestHermesReview: jest.Mock;
      requestQuote: jest.Mock;
      requestCallback: jest.Mock;
    };
    leads: {
      recordCommercialProfileFromConversation: jest.Mock;
      qualifyFromConversation: jest.Mock;
    };
    handoffs: { create: jest.Mock };
    guard: { consumeAiQuota: jest.Mock; inspectGeneratedResponse: jest.Mock };
    engine: { respond: jest.Mock; selectedEngine: jest.Mock };
    deliveries: {
      recoverBatch: jest.Mock;
      prepareBatch: jest.Mock;
      deliverPreparedBatch: jest.Mock;
    };
    messageCreate: jest.Mock;
    conversationUpdate: jest.Mock;
  } {
    const inbound = {
      id: 'inbound-recovery',
      wamid: 'wamid.inbound-recovery',
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      content: options.inboundContent ?? 'Necesito confirmar este punto',
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
      uploadVoiceNote: jest.fn().mockResolvedValue('media-voice-1'),
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
      requestCallback: jest.fn().mockResolvedValue({ id: 'callback-task-1' }),
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
    const engine = {
      selectedEngine: jest.fn().mockReturnValue('gemini_direct'),
      respond: jest
        .fn()
        .mockResolvedValue(toEngineResult(options.hermesResponse)),
    };
    const deliveries = {
      recoverBatch: jest.fn().mockResolvedValue(null),
      prepareBatch: jest.fn().mockResolvedValue(undefined),
      deliverPreparedBatch: jest.fn().mockImplementation(async () => {
        const prepared = deliveries.prepareBatch.mock.calls.at(-1)?.[0];
        if (!prepared) return { handled: false, confirmed: 0, terminal: false };
        for (const part of prepared.parts) {
          const sent = await meta.sendTextMessage('593991234567', part.content);
          if (!sent?.messages?.[0]?.id) {
            throw new Error('Meta no confirmó el envío del mensaje');
          }
          await messageCreate({
            data: {
              conversationId: prepared.conversationId,
              contactId: prepared.contactId,
              direction: 'OUTBOUND',
              sender: prepared.sender,
              type: 'TEXT',
              content: part.content,
              wamid: sent.messages[0].id,
              metadata: part.metadata,
            },
          });
        }
        return {
          handled: true,
          confirmed: prepared.parts.length,
          terminal: true,
        };
      }),
    };
    const service = new AutoReplyService(
      {
        get: jest.fn((key: string, fallback?: string) =>
          key === 'AI_MESSAGE_PART_DELAY_MS' ||
          key === 'HERMES_CONVERSATION_MESSAGE_DELAY_MS'
            ? 0
            : fallback,
        ),
      } as unknown as ConfigService,
      prisma,
      meta as unknown as MetaService,
      engine as unknown as ConversationEngineService,
      handoffs as unknown as HandoffService,
      leads as unknown as LeadsService,
      tasks as unknown as TasksService,
      new CommercialPolicyService(),
      authority,
      guard as unknown as ConversationGuardService,
      { add: jest.fn() } as unknown as Queue,
      deliveries as unknown as AutomatedDeliveryService,
    );
    return {
      service,
      meta,
      tasks,
      leads,
      handoffs,
      guard,
      engine,
      deliveries,
      messageCreate,
      conversationUpdate,
    };
  }

  it('recommends the restaurant base plan while separating reservations from the plan', async () => {
    const launch = {
      ...testOffer('Plan de Lanzamiento', '360.00', 'WEBSITE'),
      scope:
        'Hasta cinco páginas, formulario y WhatsApp para presentar el restaurante y sus platos.',
      renewalUsdPerYear: 40,
      estimatedBusinessDays: 10,
    };
    (authority.snapshot as jest.Mock).mockResolvedValueOnce({
      marketSource: 'UNKNOWN',
      relevantServiceCodes: ['WEBSITE'],
      offers: [launch],
      recommendedOfferId: launch.id,
      additionalScope: [
        'Reservas automatizadas si necesita calendario y disponibilidad',
        'Pedidos automatizados si necesita gestión interna o pagos en línea',
      ],
      needsMarketClarification: false,
    });
    const harness = setupProcessHarness({
      inboundContent:
        'Quiero recibir pedidos, captar clientes y reservar un salón.',
      persistedProfile: {
        service: 'sitio web',
        sector: 'restaurante',
        need: 'Mostrar la empresa y los platos',
      },
      hermesResponse: {
        response:
          'El valor depende de las funciones específicas; el equipo debe confirmarlo según el alcance.',
      },
    });
    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });
    const answer =
      harness.deliveries.prepareBatch.mock.calls.at(-1)?.[0].parts[0].content;
    expect(answer).toContain('Plan de Lanzamiento');
    expect(answer).toContain('formulario y WhatsApp');
    expect(answer).toContain('Reservas automatizadas');
    expect(answer).not.toMatch(/USD|\$360/);
  });

  it('answers annual renewal from the selected product terms', async () => {
    const launch = {
      ...testOffer('Plan de Lanzamiento', '360.00', 'WEBSITE'),
      renewalUsdPerYear: 40,
    };
    (authority.snapshot as jest.Mock).mockResolvedValueOnce({
      marketSource: 'UNKNOWN',
      relevantServiceCodes: ['WEBSITE'],
      offers: [launch],
      recommendedOfferId: launch.id,
      renewalRequested: true,
      needsMarketClarification: false,
    });
    const harness = setupProcessHarness({
      inboundContent: '¿Qué gastos anuales tendré por hosting y dominio?',
      persistedProfile: {
        service: 'sitio web',
        need: 'Mostrar mi restaurante',
      },
      hermesResponse: { response: 'El equipo debe confirmar esos gastos.' },
    });
    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });
    const answer =
      harness.deliveries.prepareBatch.mock.calls.at(-1)?.[0].parts[0].content;
    expect(answer).toContain('USD 40 anuales');
    expect(answer).toContain('primer año');
  });

  it('shares the existing restaurant plan price when the customer asks for it', async () => {
    const launch = {
      ...testOffer('Plan de Lanzamiento', '360.00', 'WEBSITE'),
      scope: 'Hasta cinco páginas, formulario y WhatsApp.',
    };
    (authority.snapshot as jest.Mock).mockResolvedValueOnce({
      marketSource: 'UNKNOWN',
      relevantServiceCodes: ['WEBSITE'],
      offers: [launch],
      recommendedOfferId: launch.id,
      additionalScope: ['Reservas automatizadas con calendario'],
      needsMarketClarification: false,
    });
    const harness = setupProcessHarness({
      inboundContent: '¿Sí me puede compartir un precio?',
      persistedProfile: {
        service: 'sitio web',
        sector: 'restaurante',
        need: 'Mostrar empresa, platos y recibir reservas',
      },
      hermesResponse: {
        response:
          'El valor depende de las funciones específicas; el equipo debe confirmarlo según el alcance.',
      },
    });
    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });
    const answer =
      harness.deliveries.prepareBatch.mock.calls.at(-1)?.[0].parts[0].content;
    expect(answer).toContain('Plan de Lanzamiento: USD $360.00');
    expect(answer).toContain('Reservas automatizadas con calendario');
    expect(answer).not.toContain('El valor depende');
    expect(harness.tasks.requestQuote).not.toHaveBeenCalled();
  });

  it('answers the authorized custom timeline with material dependency', async () => {
    (authority.snapshot as jest.Mock).mockResolvedValueOnce({
      marketSource: 'UNKNOWN',
      relevantServiceCodes: [],
      offers: [],
      policies: [
        'Aplicaciones móviles: mínimo aproximado de 30 días laborables, sujeto a valoración y entrega de material.',
      ],
      needsMarketClarification: false,
    });
    const harness = setupProcessHarness({
      inboundContent: '¿Cuál es el plazo de una app móvil?',
      persistedProfile: {
        service: 'aplicación móvil',
        need: 'App para clientes',
      },
      hermesResponse: { response: 'El equipo debe confirmar el plazo.' },
    });
    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });
    const answer =
      harness.deliveries.prepareBatch.mock.calls.at(-1)?.[0].parts[0].content;
    expect(answer).toContain('30 días laborables');
    expect(answer).toContain('sujeto a que entregue a tiempo');
  });

  it('uses one inference for all messages in a claimed conversation turn', async () => {
    const harness = setupProcessHarness({
      hermesResponse: {
        response: 'Podemos combinar la web y el rastreo de prendas.',
        detectedIntent: 'consulta_servicio',
      },
    });
    const at = new Date('2026-09-20T18:00:00.000Z');
    const turns = {
      claim: jest.fn().mockResolvedValue({
        id: 'turn-1',
        lastMessageId: 'inbound-recovery',
        processingToken: 'claim-token',
      }),
      messages: jest.fn().mockResolvedValue([
        {
          id: 'm1',
          wamid: 'wamid.m1',
          type: 'TEXT',
          content: 'Quiero una página',
          createdAt: at,
          rawPayload: null,
        },
        {
          id: 'm2',
          wamid: 'wamid.m2',
          type: 'TEXT',
          content: 'Es para una lavandería',
          createdAt: at,
          rawPayload: null,
        },
        {
          id: 'inbound-recovery',
          wamid: 'wamid.m3',
          type: 'TEXT',
          content: 'Quiero rastrear prendas',
          createdAt: at,
          rawPayload: null,
        },
      ]),
      complete: jest.fn(),
      release: jest.fn(),
      findOpen: jest.fn(),
    };
    Object.assign(harness.service, {
      inboundTurns: turns as unknown as InboundTurnService,
    });

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'm1',
      inboundTurnId: 'turn-1',
    });

    expect(harness.engine.respond).toHaveBeenCalledTimes(1);
    const request = harness.engine.respond.mock.calls[0][0] as {
      customerMessage: string;
    };
    expect(request.customerMessage).toContain('Quiero una página');
    expect(request.customerMessage).toContain('Es para una lavandería');
    expect(request.customerMessage).toContain('Quiero rastrear prendas');
    expect(turns.complete).toHaveBeenCalledWith('turn-1', 'claim-token');
    expect(harness.deliveries.prepareBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: expect.arrayContaining([
          expect.objectContaining({
            metadata: expect.objectContaining({ conversationTurnId: 'turn-1' }),
          }),
        ]),
      }),
    );
  });

  it('personalizes an initial greeting and removes a corporate welcome without fixing the whole reply', async () => {
    const harness = setupProcessHarness({
      inboundContent: 'Buenas tardes',
      hermesResponse: {
        response:
          'Buenas tardes. Bienvenido a Undercodeec, ¿en qué podemos ayudarle con su proyecto hoy?',
        detectedIntent: 'info_general',
      },
    });
    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });
    const prepared = harness.deliveries.prepareBatch.mock.calls[0][0] as {
      parts: Array<{ content: string }>;
    };
    expect(prepared.parts[0].content).toBe(
      'Buenas tardes, Ana. ¿En qué podemos ayudarle con su proyecto hoy?',
    );
  });

  it('uses the name for a new greeting even when the conversation has older messages', async () => {
    const harness = setupProcessHarness({
      inboundContent: 'Buenas tardes',
      hermesResponse: {
        response: 'Buenas tardes. ¿Cómo podemos ayudarle hoy?',
        detectedIntent: 'info_general',
      },
    });
    const internals = harness.service as unknown as {
      prisma: { message: { findMany: jest.Mock } };
    };
    internals.prisma.message.findMany.mockImplementation(async (args) =>
      args.where?.NOT
        ? [
            {
              direction: MessageDirection.OUTBOUND,
              content: 'Podemos continuar por aquí.',
              createdAt: new Date('2026-09-20T18:00:00.000Z'),
              rawPayload: null,
            },
          ]
        : [],
    );
    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });
    const prepared = harness.deliveries.prepareBatch.mock.calls[0][0] as {
      parts: Array<{ content: string }>;
    };
    expect(prepared.parts[0].content).toBe(
      'Buenas tardes, Ana. ¿Cómo podemos ayudarle hoy?',
    );
  });

  it('keeps a service answer while removing the corporate welcome', async () => {
    const harness = setupProcessHarness({
      inboundContent: 'Necesito una página web',
      hermesResponse: {
        response:
          'Bienvenido a Undercodeec. Podemos crear su sitio web. ¿A qué se dedica su negocio?',
        detectedIntent: 'consulta_servicio',
      },
    });
    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });
    const prepared = harness.deliveries.prepareBatch.mock.calls[0][0] as {
      parts: Array<{ content: string }>;
    };
    expect(prepared.parts[0].content).toBe(
      'Podemos crear su sitio web. ¿A qué se dedica su negocio?',
    );
  });

  it('transcribes an audio turn before inference and selects voice in MIRROR mode', async () => {
    const harness = setupProcessHarness({
      hermesResponse: {
        response: 'Sí, podemos crear esa web.',
        detectedIntent: 'consulta_servicio',
      },
    });
    const at = new Date('2026-09-20T18:00:00.000Z');
    const audio = {
      id: 'inbound-recovery',
      wamid: 'wamid.audio',
      type: 'AUDIO',
      content: '[Audio]',
      createdAt: at,
      rawPayload: { audio: { id: 'media-inbound' } },
    };
    const turns = {
      claim: jest.fn().mockResolvedValue({
        id: 'turn-audio',
        lastMessageId: audio.id,
        processingToken: 'claim-token',
      }),
      messages: jest
        .fn()
        .mockResolvedValueOnce([audio])
        .mockResolvedValueOnce([
          { ...audio, content: 'Necesito una página web para una lavandería.' },
        ]),
      complete: jest.fn(),
      release: jest.fn(),
      findOpen: jest.fn(),
    };
    const voice = {
      transcribe: jest.fn().mockResolvedValue({
        text: 'Necesito una página web para una lavandería.',
        language: 'es',
        sourceType: 'AUDIO',
      }),
      synthesize: jest.fn().mockResolvedValue(Buffer.from('OggSopus')),
    };
    Object.assign(harness.service, {
      inboundTurns: turns as unknown as InboundTurnService,
      voice: voice as unknown as VoiceService,
    });
    const internals = harness.service as unknown as {
      prisma: { message: { update: jest.Mock } };
    };
    internals.prisma.message.update = jest.fn().mockResolvedValue({});

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: audio.id,
      inboundTurnId: 'turn-audio',
    });

    expect(voice.transcribe).toHaveBeenCalledWith('media-inbound');
    expect(harness.engine.respond).toHaveBeenCalledTimes(1);
    expect(voice.synthesize).toHaveBeenCalled();
    expect(harness.meta.uploadVoiceNote).toHaveBeenCalled();
    expect(harness.deliveries.prepareBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: expect.arrayContaining([
          expect.objectContaining({
            metadata: expect.objectContaining({
              voiceMediaId: 'media-voice-1',
            }),
          }),
        ]),
      }),
    );
  });

  it('passes an audio price question to the existing commercial authority', async () => {
    (authority.snapshot as jest.Mock).mockResolvedValueOnce({
      market: CommercialMarket.EC,
      marketSource: 'CURRENT',
      relevantServiceCodes: ['WEBSITE'],
      offers: [testOffer('Plan de Lanzamiento', '360.00', 'WEBSITE')],
      needsMarketClarification: false,
    });
    const harness = setupProcessHarness({
      hermesResponse: {
        response: 'El Plan de Lanzamiento cuesta USD 360.',
        detectedIntent: 'consulta_precio',
      },
    });
    const audio = {
      id: 'inbound-recovery',
      wamid: 'wamid.audio-price',
      type: 'AUDIO',
      content: '[Audio]',
      createdAt: new Date('2026-09-20T18:00:00.000Z'),
      rawPayload: { audio: { id: 'media-price' } },
    };
    const turns = {
      claim: jest.fn().mockResolvedValue({
        id: 'turn-price',
        lastMessageId: audio.id,
        processingToken: 'claim-token',
      }),
      messages: jest
        .fn()
        .mockResolvedValueOnce([audio])
        .mockResolvedValueOnce([
          {
            ...audio,
            content: '¿Cuánto cuesta una página web para mi lavandería?',
          },
        ]),
      complete: jest.fn(),
      release: jest.fn(),
    };
    const voice = {
      transcribe: jest.fn().mockResolvedValue({
        text: '¿Cuánto cuesta una página web para mi lavandería?',
        sourceType: 'AUDIO',
      }),
      synthesize: jest.fn().mockResolvedValue(Buffer.from('OggSopus')),
    };
    Object.assign(harness.service, {
      inboundTurns: turns as unknown as InboundTurnService,
      voice: voice as unknown as VoiceService,
    });
    const internals = harness.service as unknown as {
      prisma: { message: { update: jest.Mock } };
    };
    internals.prisma.message.update = jest.fn().mockResolvedValue({});

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: audio.id,
      inboundTurnId: 'turn-price',
    });

    expect(authority.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        customerMessage: expect.stringContaining(
          '¿Cuánto cuesta una página web para mi lavandería?',
        ),
        priceRequested: true,
      }),
    );
    expect(harness.deliveries.prepareBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: expect.arrayContaining([
          expect.objectContaining({
            content: expect.stringContaining('USD 360'),
          }),
        ]),
      }),
    );
  });

  it('delivers approved text when voice synthesis fails', async () => {
    const harness = setupProcessHarness({
      hermesResponse: {
        response: 'Podemos crear su sitio web.',
        detectedIntent: 'consulta_servicio',
      },
    });
    const audio = {
      id: 'inbound-recovery',
      wamid: 'wamid.audio',
      type: 'AUDIO',
      content: 'Necesito una web',
      createdAt: new Date('2026-09-20T18:00:00.000Z'),
      rawPayload: { audio: { id: 'media-inbound' } },
    };
    Object.assign(harness.service, {
      inboundTurns: {
        claim: jest.fn().mockResolvedValue({
          id: 'turn-audio',
          lastMessageId: audio.id,
          processingToken: 'claim-token',
        }),
        messages: jest.fn().mockResolvedValue([audio]),
        complete: jest.fn(),
        release: jest.fn(),
      } as unknown as InboundTurnService,
      voice: {
        synthesize: jest.fn().mockRejectedValue(new Error('TTS unavailable')),
      } as unknown as VoiceService,
    });

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: audio.id,
      inboundTurnId: 'turn-audio',
    });

    expect(harness.meta.uploadVoiceNote).not.toHaveBeenCalled();
    const prepared = harness.deliveries.prepareBatch.mock.calls[0][0] as {
      parts: Array<{ content: string; metadata?: { voiceMediaId?: string } }>;
    };
    expect(prepared.parts[0].content).toBe('Podemos crear su sitio web.');
    expect(prepared.parts[0].metadata?.voiceMediaId).toBeUndefined();
    expect(harness.deliveries.deliverPreparedBatch).toHaveBeenCalled();
  });

  it('keeps every reply part as text when synthesis fails after an earlier part', async () => {
    const firstPart = `${'primera '.repeat(36).trim()}.`;
    const secondPart = `${'segunda '.repeat(36).trim()}.`;
    const harness = setupProcessHarness({
      hermesResponse: {
        response: `${firstPart} ${secondPart}`,
        detectedIntent: 'consulta_servicio',
      },
    });
    const audio = {
      id: 'inbound-recovery',
      wamid: 'wamid.audio',
      type: 'AUDIO',
      content: 'Necesito una web',
      createdAt: new Date('2026-09-20T18:00:00.000Z'),
      rawPayload: { audio: { id: 'media-inbound' } },
    };
    Object.assign(harness.service, {
      inboundTurns: {
        claim: jest.fn().mockResolvedValue({
          id: 'turn-audio',
          lastMessageId: audio.id,
          processingToken: 'claim-token',
        }),
        messages: jest.fn().mockResolvedValue([audio]),
        complete: jest.fn(),
        release: jest.fn(),
      } as unknown as InboundTurnService,
      voice: {
        synthesize: jest
          .fn()
          .mockResolvedValueOnce(Buffer.from('OggSfirst'))
          .mockRejectedValueOnce(new Error('TTS unavailable')),
      } as unknown as VoiceService,
    });

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: audio.id,
      inboundTurnId: 'turn-audio',
    });

    expect(harness.meta.uploadVoiceNote).not.toHaveBeenCalled();
    const prepared = harness.deliveries.prepareBatch.mock.calls[0][0] as {
      parts: Array<{ metadata?: { voiceMediaId?: string } }>;
    };
    expect(prepared.parts).toHaveLength(2);
    expect(
      prepared.parts.every((part) => part.metadata?.voiceMediaId === undefined),
    ).toBe(true);
  });

  it('keeps the text fallback and reports a Meta upload failure without calling it TTS', async () => {
    const harness = setupProcessHarness({
      hermesResponse: {
        response: 'Podemos crear su sitio web.',
        detectedIntent: 'consulta_servicio',
      },
    });
    const warn = jest.spyOn(
      (harness.service as unknown as { logger: Logger }).logger,
      'warn',
    );
    const audio = {
      id: 'inbound-recovery',
      wamid: 'wamid.audio',
      type: 'AUDIO',
      content: 'Necesito una web',
      createdAt: new Date('2026-09-20T18:00:00.000Z'),
      rawPayload: { audio: { id: 'media-inbound' } },
    };
    const uploadFailure = new MetaMediaUploadError(400);
    harness.meta.uploadVoiceNote.mockRejectedValue(uploadFailure);
    Object.assign(harness.service, {
      inboundTurns: {
        claim: jest.fn().mockResolvedValue({
          id: 'turn-audio',
          lastMessageId: audio.id,
          processingToken: 'claim-token',
        }),
        messages: jest.fn().mockResolvedValue([audio]),
        complete: jest.fn(),
        release: jest.fn(),
      } as unknown as InboundTurnService,
      voice: {
        synthesize: jest.fn().mockResolvedValue(Buffer.from('OggSopus')),
      } as unknown as VoiceService,
    });

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: audio.id,
      inboundTurnId: 'turn-audio',
    });

    const prepared = harness.deliveries.prepareBatch.mock.calls[0][0] as {
      parts: Array<{ content: string; metadata?: { voiceMediaId?: string } }>;
    };
    expect(prepared.parts[0].content).toBe('Podemos crear su sitio web.');
    expect(prepared.parts[0].metadata?.voiceMediaId).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"event":"voice_media_upload_failed"'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"reasonCode":"META_MEDIA_UPLOAD_FAILED"'),
    );
    expect(warn.mock.calls.flat().join('')).not.toContain('TTS no disponible');
  });

  it('returns to text in MIRROR mode when the last message is a text correction', async () => {
    const harness = setupProcessHarness({
      hermesResponse: {
        response: 'Entendido: son 15 productos.',
        detectedIntent: 'consulta_servicio',
      },
    });
    const at = new Date('2026-09-20T18:00:00.000Z');
    const messages = [
      {
        id: 'audio-first',
        wamid: 'wamid.audio',
        type: 'AUDIO',
        content: 'Quiero diez productos',
        createdAt: at,
        rawPayload: { audio: { id: 'media-inbound' } },
      },
      {
        id: 'inbound-recovery',
        wamid: 'wamid.text',
        type: 'TEXT',
        content: 'No, quise decir 15 productos',
        createdAt: at,
        rawPayload: null,
      },
    ];
    const voice = { synthesize: jest.fn() };
    Object.assign(harness.service, {
      inboundTurns: {
        claim: jest.fn().mockResolvedValue({
          id: 'turn-correction',
          lastMessageId: 'inbound-recovery',
          processingToken: 'claim-token',
        }),
        messages: jest.fn().mockResolvedValue(messages),
        complete: jest.fn(),
        release: jest.fn(),
      } as unknown as InboundTurnService,
      voice: voice as unknown as VoiceService,
    });

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
      inboundTurnId: 'turn-correction',
    });

    expect(voice.synthesize).not.toHaveBeenCalled();
    const request = harness.engine.respond.mock.calls[0][0] as {
      customerMessage: string;
    };
    expect(request.customerMessage).toContain('Quiero diez productos');
    expect(request.customerMessage).toContain('No, quise decir 15 productos');
    expect(
      request.customerMessage.indexOf('Quiero diez productos'),
    ).toBeLessThan(
      request.customerMessage.indexOf('No, quise decir 15 productos'),
    );
  });

  it('asks to resend an untranscribable audio without calling Nous', async () => {
    const harness = setupProcessHarness({
      hermesResponse: { response: 'No debe generarse' },
    });
    const turns = {
      claim: jest.fn().mockResolvedValue({
        id: 'turn-audio',
        lastMessageId: 'inbound-recovery',
        processingToken: 'claim-token',
      }),
      messages: jest.fn().mockResolvedValue([
        {
          id: 'inbound-recovery',
          wamid: 'wamid.audio',
          type: 'AUDIO',
          content: '[Audio]',
          createdAt: new Date(),
          rawPayload: { audio: { id: 'media-inbound' } },
        },
      ]),
      complete: jest.fn(),
      release: jest.fn(),
      findOpen: jest.fn(),
    };
    const voice = {
      transcribe: jest.fn().mockRejectedValue(new Error('STT failed')),
    };
    Object.assign(harness.service, {
      inboundTurns: turns as unknown as InboundTurnService,
      voice: voice as unknown as VoiceService,
    });

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
      inboundTurnId: 'turn-audio',
    });

    expect(harness.engine.respond).not.toHaveBeenCalled();
    expect(harness.deliveries.prepareBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKind: 'SYSTEM_NOTICE',
        parts: [
          expect.objectContaining({
            metadata: expect.objectContaining({
              action: 'AUDIO_TRANSCRIPTION_FAILED',
            }),
          }),
        ],
      }),
    );
  });

  it('does not describe a missing STT provider as an unclear recording', async () => {
    const harness = setupProcessHarness({
      hermesResponse: { response: 'No debe generarse' },
    });
    Object.assign(harness.service, {
      inboundTurns: {
        claim: jest.fn().mockResolvedValue({
          id: 'turn-audio',
          lastMessageId: 'inbound-recovery',
          processingToken: 'claim-token',
        }),
        messages: jest.fn().mockResolvedValue([
          {
            id: 'inbound-recovery',
            wamid: 'wamid.audio',
            type: 'AUDIO',
            content: '[Audio]',
            createdAt: new Date(),
            rawPayload: { audio: { id: 'media-inbound' } },
          },
        ]),
        complete: jest.fn(),
        release: jest.fn(),
      } as unknown as InboundTurnService,
      voice: {
        transcribe: jest
          .fn()
          .mockRejectedValue(new VoiceProcessingError('STT_NOT_CONFIGURED')),
      } as unknown as VoiceService,
    });
    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
      inboundTurnId: 'turn-audio',
    });
    const prepared = harness.deliveries.prepareBatch.mock.calls[0][0] as {
      parts: Array<{ content: string; metadata: { reasonCode?: string } }>;
    };
    expect(prepared.parts[0].content).toContain(
      'No puedo procesar notas de voz',
    );
    expect(prepared.parts[0].content).not.toContain('escuchar bien');
    expect(prepared.parts[0].metadata.reasonCode).toBe('STT_NOT_CONFIGURED');
    expect(harness.engine.respond).not.toHaveBeenCalled();
  });

  it('logs safe ElevenLabs failure diagnostics while preserving the audio fallback', async () => {
    const harness = setupProcessHarness({
      hermesResponse: { response: 'No debe generarse' },
    });
    const warn = jest.spyOn(
      (harness.service as unknown as { logger: Logger }).logger,
      'warn',
    );
    const failure = new VoiceProcessingError('STT_PROVIDER_FAILED', {
      provider: 'elevenlabs',
      modelId: 'scribe_v2',
      mimeType: 'audio/ogg',
      audioBytes: 31415,
      providerHttpStatus: 422,
      providerErrorCode: 'invalid_audio',
      providerMessage: 'El proveedor rechazó el formato.',
      transportCode: 'ERR_BAD_REQUEST',
      transportMessage: 'Request failed with status code 422',
      requestId: 'eleven-request-1',
      failureKind: 'HTTP',
    });
    Object.assign(harness.service, {
      inboundTurns: {
        claim: jest.fn().mockResolvedValue({
          id: 'turn-audio',
          lastMessageId: 'inbound-recovery',
          processingToken: 'claim-token',
        }),
        messages: jest.fn().mockResolvedValue([
          {
            id: 'inbound-recovery',
            wamid: 'wamid.audio',
            type: 'AUDIO',
            content: '[Audio]',
            createdAt: new Date(),
            rawPayload: { audio: { id: 'media-inbound' } },
          },
        ]),
        complete: jest.fn(),
        release: jest.fn(),
      } as unknown as InboundTurnService,
      voice: {
        transcribe: jest.fn().mockRejectedValue(failure),
      } as unknown as VoiceService,
    });

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
      inboundTurnId: 'turn-audio',
    });

    const event = warn.mock.calls
      .map(([message]) => JSON.parse(message as string) as { event?: string })
      .find((entry) => entry.event === 'audio_transcription_failed');
    expect(event).toEqual({
      event: 'audio_transcription_failed',
      conversationId: 'conversation-1',
      inboundMessageId: 'inbound-recovery',
      reasonCode: 'STT_PROVIDER_FAILED',
      provider: 'elevenlabs',
      modelId: 'scribe_v2',
      mimeType: 'audio/ogg',
      audioBytes: 31415,
      providerHttpStatus: 422,
      providerErrorCode: 'invalid_audio',
      providerMessage: 'El proveedor rechazó el formato.',
      transportCode: 'ERR_BAD_REQUEST',
      transportMessage: 'Request failed with status code 422',
      requestId: 'eleven-request-1',
      failureKind: 'HTTP',
    });
    expect(harness.engine.respond).not.toHaveBeenCalled();
  });

  it('sanitizes untrusted voice diagnostics at the logging boundary', async () => {
    const harness = setupProcessHarness({
      hermesResponse: { response: 'No debe generarse' },
    });
    const warn = jest.spyOn(
      (harness.service as unknown as { logger: Logger }).logger,
      'warn',
    );
    const failure = new VoiceProcessingError('STT_PROVIDER_FAILED', {
      provider: 'elevenlabs',
      modelId: 'scribe_v2?token=model-secret',
      mimeType: 'audio/ogg; token=mime-secret',
      audioBytes: 31415,
      providerHttpStatus: 422,
      providerErrorCode: 'invalid_audio',
      providerMessage:
        'Proveedor rechazó https://provider.example/error?signature=provider-secret',
      transportCode: 'ERR_BAD_REQUEST',
      transportMessage: '{"api_key":"transport-secret"}',
      requestId: 'request-1?token=request-secret',
      failureKind: 'HTTP',
    });
    Object.assign(harness.service, {
      inboundTurns: {
        claim: jest.fn().mockResolvedValue({
          id: 'turn-audio',
          lastMessageId: 'inbound-recovery',
          processingToken: 'claim-token',
        }),
        messages: jest.fn().mockResolvedValue([
          {
            id: 'inbound-recovery',
            wamid: 'wamid.audio',
            type: 'AUDIO',
            content: '[Audio]',
            createdAt: new Date(),
            rawPayload: { audio: { id: 'media-inbound' } },
          },
        ]),
        complete: jest.fn(),
        release: jest.fn(),
      } as unknown as InboundTurnService,
      voice: {
        transcribe: jest.fn().mockRejectedValue(failure),
      } as unknown as VoiceService,
    });

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
      inboundTurnId: 'turn-audio',
    });

    const event = warn.mock.calls
      .map(
        ([message]) => JSON.parse(message as string) as Record<string, unknown>,
      )
      .find((entry) => entry.event === 'audio_transcription_failed');
    expect(event).toEqual(
      expect.objectContaining({
        provider: 'elevenlabs',
        modelId: null,
        mimeType: 'audio/ogg',
        audioBytes: 31415,
        providerHttpStatus: 422,
        providerErrorCode: 'invalid_audio',
        transportCode: 'ERR_BAD_REQUEST',
        requestId: null,
        failureKind: 'HTTP',
      }),
    );
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('model-secret');
    expect(serialized).not.toContain('mime-secret');
    expect(serialized).not.toContain('provider-secret');
    expect(serialized).not.toContain('transport-secret');
    expect(serialized).not.toContain('request-secret');
    expect(serialized).not.toContain('provider.example');
    expect(serialized).toContain('[redacted]');
  });

  it('resumes a prepared batch before quota or inference', async () => {
    const harness = setupProcessHarness({
      hermesResponse: { response: 'respuesta', detectedIntent: 'info_general' },
    });
    harness.deliveries.recoverBatch.mockResolvedValue({
      handled: true,
      confirmed: 1,
      terminal: true,
    });

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });

    expect(harness.guard.consumeAiQuota).not.toHaveBeenCalled();
    expect(harness.engine.respond).not.toHaveBeenCalled();
    expect(harness.meta.sendTextMessage).not.toHaveBeenCalled();
  });

  it('prepares all generated parts and delegates delivery once', async () => {
    const harness = setupProcessHarness({
      hermesResponse: {
        response: `${'a'.repeat(500)}. ${'b'.repeat(500)}`,
        detectedIntent: 'info_general',
      },
    });
    harness.deliveries.deliverPreparedBatch.mockResolvedValue({
      handled: true,
      confirmed: 2,
      terminal: true,
    });

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });

    expect(harness.deliveries.prepareBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKind: 'HERMES_REPLY',
        sourceMessageId: 'inbound-recovery',
        sender: 'HERMES',
        parts: [
          expect.objectContaining({ partIndex: 0 }),
          expect.objectContaining({ partIndex: 1 }),
        ],
      }),
    );
    expect(harness.deliveries.deliverPreparedBatch).toHaveBeenCalledWith(
      'inbound-recovery',
    );
    expect(harness.meta.sendTextMessage).not.toHaveBeenCalled();
  });

  it('sends Nous conversational parts in order without duplicating their joined text', async () => {
    (authority.snapshot as jest.Mock).mockResolvedValueOnce({
      market: CommercialMarket.EC,
      marketSource: 'CURRENT',
      relevantServiceCodes: ['LANDING_PAGE', 'WEBSITE', 'ONLINE_STORE'],
      offers: [
        testOffer('Landing Básica', '250.00', 'LANDING_PAGE'),
        testOffer('Plan de Lanzamiento', '360.00', 'WEBSITE'),
        testOffer('Tienda de Lanzamiento', '550.00', 'ONLINE_STORE'),
      ],
      needsMarketClarification: false,
    });
    const harness = setupProcessHarness({
      inboundContent:
        'Tengo lavadoras para promocionar servicios y zapatos para vender por internet. ¿Cuánto cuesta y cuánto tarda?',
      hermesResponse: { response: 'placeholder' },
    });
    harness.engine.respond.mockResolvedValue({
      replyText:
        'Para las lavadoras, Landing Básica USD $250 o Plan de Lanzamiento USD $360. Para los zapatos, Tienda de Lanzamiento USD $550. El plazo debe confirmarse según el alcance.',
      replyParts: [
        'Para las lavadoras, Landing Básica USD $250 o Plan de Lanzamiento USD $360.',
        'Para los zapatos, Tienda de Lanzamiento USD $550.',
        'El plazo debe confirmarse según el alcance.',
      ],
      proposedActions: [{ type: 'none' }],
      engine: 'nous_hermes',
      providerModel: 'hermes-agent',
      traceId: 'inbound-recovery',
    });
    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });
    const sent = harness.meta.sendTextMessage.mock.calls.map(
      (call) => call[1] as string,
    );
    expect(sent).toEqual([
      'Para las lavadoras, Landing Básica USD $250 o Plan de Lanzamiento USD $360.',
      'Para los zapatos, Tienda de Lanzamiento USD $550.',
      'El plazo debe confirmarse según el alcance.',
    ]);
    expect(harness.deliveries.prepareBatch).toHaveBeenCalledTimes(1);
  });

  it('does not persist lead state when the delivery is suppressed', async () => {
    const harness = setupProcessHarness({
      hermesResponse: { response: 'respuesta', detectedIntent: 'info_general' },
    });
    harness.deliveries.deliverPreparedBatch.mockResolvedValue({
      handled: true,
      confirmed: 0,
      terminal: true,
      reasonCode: 'NEWER_INBOUND',
    });

    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });

    expect(
      harness.leads.recordCommercialProfileFromConversation,
    ).not.toHaveBeenCalled();
  });

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
    const prepared = harness.deliveries.prepareBatch.mock.calls[0][0];
    const customerCopy = prepared.parts[0].content as string;
    expect(customerCopy).toContain(
      'Ya dejé registrado el caso para revisarlo y continuar por este mismo chat',
    );
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
    expect(
      harness.deliveries.prepareBatch.mock.calls[0][0].parts[0].content,
    ).toContain(
      'Permítame consultar este punto con el equipo. Le confirmaremos por este mismo chat',
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

  it('keeps a valid Nous reply and persists only evidence-backed profile fields', async () => {
    const harness = setupProcessHarness({
      inboundContent: 'Necesito un sitio web para mi negocio',
      hermesResponse: { response: 'Claro, puedo ayudarle con su sitio web.' },
    });
    harness.engine.respond.mockResolvedValue({
      replyText: 'Claro, puedo ayudarle con su sitio web.',
      proposedActions: [{ type: 'none' }],
      engine: 'nous_hermes',
      providerModel: 'hermes-agent',
      traceId: 'inbound-recovery',
      business: { commercialProfile: { need: 'sitio web', budget: '$9999' } },
      proposalEvidence: { need: 'sitio web', budget: 'presupuesto $9999' },
    });
    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });
    expect(
      harness.deliveries.prepareBatch.mock.calls[0][0].parts[0].content,
    ).toBe('Claro, puedo ayudarle con su sitio web.');
    expect(
      harness.leads.recordCommercialProfileFromConversation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ need: 'sitio web' }),
      }),
    );
    expect(
      harness.leads.recordCommercialProfileFromConversation.mock.calls[0][0]
        .profile.budget,
    ).toBeUndefined();
  });

  it('executes an evidence-backed quote proposal without inserting an unasked price', async () => {
    const harness = setupProcessHarness({
      inboundContent: 'Quiero una cotización para mi sitio web',
      hermesResponse: {
        response: 'Podemos preparar una valoración para su sitio web.',
      },
    });
    harness.engine.respond.mockResolvedValue({
      replyText: 'Podemos preparar una valoración para su sitio web.',
      proposedActions: [{ type: 'propose_quote_task', summary: 'Sitio web' }],
      engine: 'nous_hermes',
      providerModel: 'hermes-agent',
      traceId: 'inbound-recovery',
      business: { decision: 'Quiero una cotización' },
    });
    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });
    expect(harness.tasks.requestQuote).toHaveBeenCalledTimes(1);
    expect(
      harness.deliveries.prepareBatch.mock.calls[0][0].parts[0].content,
    ).not.toMatch(/USD|\$/);
    expect(
      harness.deliveries.prepareBatch.mock.calls[0][0].parts[0].content,
    ).toContain('Podemos preparar una valoración para su sitio web.');
  });

  it('repairs an unauthorized Nous price while retaining the valid answer', async () => {
    const harness = setupProcessHarness({
      inboundContent: 'Quiero un sitio web',
      hermesResponse: {
        response: 'El sitio web puede mostrar sus servicios. Cuesta USD $9999.',
      },
    });
    harness.engine.respond.mockResolvedValue({
      replyText: 'El sitio web puede mostrar sus servicios. Cuesta USD $9999.',
      proposedActions: [{ type: 'none' }],
      engine: 'nous_hermes',
      providerModel: 'hermes-agent',
      traceId: 'inbound-recovery',
    });
    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });
    const content = harness.deliveries.prepareBatch.mock.calls[0][0].parts[0]
      .content as string;
    expect(content).toContain('El sitio web puede mostrar sus servicios.');
    expect(content).not.toContain('9999');
  });

  it('runs a complete synthetic inbound through Nous JSON, CRM validation and delivery', async () => {
    const harness = setupProcessHarness({
      inboundContent: 'Necesito un sitio web para mi negocio',
      hermesResponse: { response: 'Consulta sintética' },
    });
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        model: 'hermes-agent',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                replyText: 'Podemos ayudarle con su sitio web.',
                detectedIntent: 'consulta_servicio',
                commercialProfilePatch: { need: 'sitio web' },
                fieldEvidence: { need: 'sitio web' },
                proposedNextAction: { type: 'none' },
              }),
            },
          },
        ],
      },
    });
    const transport = new NousHermesTransport(
      {
        get: jest.fn((_key: string, fallback?: unknown) => fallback),
      } as unknown as ConfigService,
      new AgentOutputValidator(),
      { read: jest.fn().mockResolvedValue('synthetic-secret') },
    );
    harness.engine.respond.mockImplementation((input) =>
      transport.execute(input),
    );
    try {
      await harness.service.process({
        conversationId: 'conversation-1',
        contactId: 'contact-1',
        inboundMessageId: 'inbound-recovery',
      });
      expect(post).toHaveBeenCalledTimes(1);
      expect(
        harness.deliveries.prepareBatch.mock.calls[0][0].parts[0].content,
      ).toBe('Podemos ayudarle con su sitio web.');
      expect(harness.deliveries.deliverPreparedBatch).toHaveBeenCalledTimes(1);
      expect(
        harness.leads.recordCommercialProfileFromConversation,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          profile: expect.objectContaining({ need: 'sitio web' }),
        }),
      );
    } finally {
      post.mockRestore();
    }
  });

  it('lets Nous request an existing callback task for an affirmative call request', async () => {
    const harness = setupProcessHarness({
      inboundContent: 'Llámame mañana',
      hermesResponse: {
        response:
          'He registrado su solicitud de llamada, pendiente de confirmación.',
      },
    });
    harness.engine.selectedEngine.mockReturnValue('nous_hermes');
    harness.engine.respond.mockResolvedValue({
      replyText:
        'He registrado su solicitud de llamada, pendiente de confirmación.',
      proposedActions: [{ type: 'request_callback' }],
      engine: 'nous_hermes',
      providerModel: 'hermes-agent',
      traceId: 'inbound-recovery',
      business: { decision: 'Llámame' },
    });
    await harness.service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-recovery',
    });
    expect(harness.tasks.requestCallback).toHaveBeenCalledTimes(1);
    expect(
      harness.deliveries.prepareBatch.mock.calls[0][0].parts[0].content,
    ).toContain('pendiente de confirmación');
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
      authority,
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
      authority,
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
      authority,
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
      selectedEngine: jest.fn().mockReturnValue('gemini_direct'),
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
      authority,
      { consumeAiQuota: jest.fn() } as unknown as ConversationGuardService,
      { add: jest.fn() } as unknown as Queue,
      passthroughDeliveries(meta),
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
      authority,
      {} as ConversationGuardService,
      { add: jest.fn() } as unknown as Queue,
      passthroughDeliveries(meta),
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

  it('creates a commercial handoff for a callback request before confirming it', async () => {
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
      selectedEngine: jest.fn().mockReturnValue('gemini_direct'),
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
    const deliveries = passthroughDeliveries(meta);
    const handoffs = {
      create: jest.fn().mockResolvedValue({ id: 'handoff-1' }),
    };
    const service = new AutoReplyService(
      { get: jest.fn() } as unknown as ConfigService,
      prisma,
      meta,
      engine,
      handoffs as unknown as HandoffService,
      leads,
      tasks,
      new CommercialPolicyService(),
      authority,
      guard,
      { add: jest.fn() } as unknown as Queue,
      deliveries,
    );

    await service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-call',
    });

    expect(handoffs.create).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conversation-1' }),
      undefined,
      { sourceMessageId: 'inbound-call', callRequested: true },
    );
    expect(
      (deliveries.prepareBatch as jest.Mock).mock.calls[0][0].parts[0].content,
    ).toContain('este mismo número de WhatsApp');
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
      authority,
      { consumeAiQuota: jest.fn() } as unknown as ConversationGuardService,
      { add: jest.fn() } as unknown as Queue,
      passthroughDeliveries(
        meta,
        (prisma as unknown as { message: { create: jest.Mock } }).message
          .create,
      ),
    );

    await service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-human',
    });

    expect(callOrder).toEqual(['handoff', 'send', 'persist']);
  });

  it('does not confirm advisor contact when the CRM transaction fails', async () => {
    const harness = setupProcessHarness({
      inboundContent: '¿Me puede hacer contactar con algún asesor?',
      hermesResponse: { response: 'Un asesor lo contactará.' },
    });
    harness.handoffs.create.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await expect(
      harness.service.process({
        conversationId: 'conversation-1',
        contactId: 'contact-1',
        inboundMessageId: 'inbound-recovery',
      }),
    ).rejects.toThrow('database unavailable');
    expect(harness.deliveries.prepareBatch).not.toHaveBeenCalled();
    expect(harness.engine.respond).not.toHaveBeenCalled();
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
    const deliveries = passthroughDeliveries(meta);
    const service = new AutoReplyService(
      { get: jest.fn() } as unknown as ConfigService,
      prisma,
      meta,
      engine,
      { create: jest.fn() } as unknown as HandoffService,
      leads,
      tasks,
      new CommercialPolicyService(),
      authority,
      {
        consumeAiQuota: jest.fn().mockResolvedValue(true),
        inspectGeneratedResponse: jest
          .fn()
          .mockReturnValue({ action: 'ALLOW' }),
      } as unknown as ConversationGuardService,
      { add: jest.fn() } as unknown as Queue,
      deliveries,
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
    expect(
      (deliveries.prepareBatch as jest.Mock).mock.calls[0][0].parts[0].content,
    ).toContain('He registrado una solicitud de cotización');
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
    const deliveries = passthroughDeliveries(meta, messageCreate);
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
      authority,
      {
        consumeAiQuota: jest.fn().mockResolvedValue(true),
        inspectGeneratedResponse: jest
          .fn()
          .mockReturnValue({ action: 'ALLOW' }),
      } as unknown as ConversationGuardService,
      { add: jest.fn() } as unknown as Queue,
      deliveries,
    );

    await service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-long',
    });

    const sentParts = (
      (deliveries.prepareBatch as jest.Mock).mock.calls[0][0].parts as Array<{
        content: string;
      }>
    ).map((part) => part.content);
    expect(sentParts.length).toBeLessThanOrEqual(9);
    expect(messageCreate).toHaveBeenCalledTimes(sentParts.length);
    expect(sentParts.every((part) => part.length <= 1000)).toBe(true);
    expect(sentParts.join(' ')).toBe(longResponse);
  });
});
