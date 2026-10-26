import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LearningItemStatus, LearningRiskLevel } from '@prisma/client';
import axios from 'axios';
import { Queue } from 'bullmq';
import { DirectGeminiEngine } from '../conversation-engine/direct-gemini.engine';
import { AgentOutputValidator } from '../conversation-engine/agent-output.validator';
import { NousHermesTransport } from '../conversation-engine/nous-hermes.transport';
import { InboundTurnService } from '../auto-replies/inbound-turn.service';
import type { ConversationTurnInput } from '../conversation-engine/conversation-engine.types';
import { HermesService } from '../hermes/hermes.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationReviewService } from './conversation-review.service';
import { LearningRetrievalService } from './learning-retrieval.service';
import { ReviewCanaryPolicy } from './review-canary.policy';
import { ReviewModelService } from './review-model.service';
import type { ReviewJobData } from './learning.constants';

const safeId = '123e4567-e89b-42d3-a456-426614174000';
const unsafeText = 'Ofrecer descuento del 30%';

function inputFor(customerMessage: string): ConversationTurnInput {
  return {
    conversationId: 'conversation-synthetic',
    inboundMessageId: 'inbound-synthetic',
    normalNousClaim: {
      turnId: 'turn-synthetic',
      processingToken: 'token-synthetic',
    },
    customerMessage,
    approvedContext: {
      recentMessages: [{ role: 'assistant', text: 'Contexto previo' }],
      approvedKnowledge: ['Plan autorizado por CRM'],
      commercialSnapshot: {
        market: 'EC',
        marketSource: 'PROFILE',
        relevantServiceCodes: ['WEBSITE'],
        offers: [],
        needsMarketClarification: false,
      },
      handoffActive: false,
      contactName: 'Cliente',
    },
  };
}

function shadowFor(customerMessage: string) {
  const rows = [
    {
      id: safeId,
      version: 2,
      kind: 'STYLE',
      trigger: 'consulta sobre servicio',
      guidance: 'Responder primero la pregunta actual',
      status: LearningItemStatus.ACTIVE,
      riskLevel: LearningRiskLevel.LOW,
      validUntil: new Date(Date.now() + 86400_000),
      createdAt: new Date('2026-10-15T12:00:00Z'),
      serviceCode: null,
      market: null,
      evidence: [{ id: 'evidence-synthetic' }],
    },
    {
      id: 'unsafe-commercial',
      version: 1,
      kind: 'STYLE',
      trigger: 'consulta sobre servicio',
      guidance: unsafeText,
      status: LearningItemStatus.ACTIVE,
      riskLevel: LearningRiskLevel.LOW,
      validUntil: new Date(Date.now() + 86400_000),
      createdAt: new Date('2026-10-15T12:00:00Z'),
      serviceCode: null,
      market: null,
      evidence: [{ id: 'evidence-synthetic' }],
    },
  ];
  const prisma = {
    learningItem: {
      findMany: jest.fn().mockResolvedValue(rows),
      create: jest.fn(),
    },
    conversationReview: { create: jest.fn() },
    learningEvidence: { create: jest.fn() },
  };
  const config = new ConfigService({
    LEARNING_SHADOW_ENABLED: 'true',
    LEARNING_RETRIEVAL_ENABLED: 'false',
  });
  const retrieval = new LearningRetrievalService(
    prisma as unknown as PrismaService,
    config,
  );
  const review = new ConversationReviewService(
    prisma as unknown as PrismaService,
    config,
    {} as ReviewModelService,
    {} as Queue<ReviewJobData>,
    {} as ReviewCanaryPolicy,
    retrieval,
  );
  return {
    async observe(engine: string) {
      await review.recordShadowMatches({
        conversationId: 'conversation-synthetic',
        inboundMessageId: 'inbound-synthetic',
        customerMessage,
        serviceCode: 'WEBSITE',
        market: 'EC',
        engine,
        approvedKnowledge: ['Plan autorizado por CRM'],
      });
    },
    prisma,
  };
}

describe('F3 shadow engine request oracle (offline)', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['informational', 'Consulta sobre servicio'],
    ['price', 'Consulta sobre servicio y precio'],
    ['payment', 'Consulta sobre servicio y pago'],
    ['handoff', 'Consulta sobre servicio y atención humana'],
  ])('Gemini request and output parity for %s', async (_scenario, message) => {
    const config = new ConfigService({
      HERMES_API_KEY: 'synthetic-key',
      HERMES_MODEL: 'gemini-test',
      HERMES_API_URL:
        'https://generativelanguage.googleapis.com/v1beta/openai/',
      HERMES_STRUCTURED_OUTPUT: 'true',
    });
    const prisma = {
      knowledgeDocument: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([]) },
      salesPlaybook: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const hermes = new HermesService(config, prisma);
    const post = jest.fn().mockResolvedValue({
      data: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                response: 'Con gusto le ayudo.',
                detectedIntent: 'info_general',
                nextAction: 'sin_accion',
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      },
    });
    (
      hermes as unknown as { httpClient: { post: typeof post } }
    ).httpClient.post = post;
    const engine = new DirectGeminiEngine(hermes);
    const turn = inputFor(message);
    const control = await engine.respond(turn);
    const payloadControl = (post.mock.calls as Array<[string, unknown]>)[0][1];
    const providerCallsBeforeShadow = post.mock.calls.length;
    const shadow = shadowFor(message);
    const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    await shadow.observe('gemini_direct');
    const shadowEvent = logs.mock.calls
      .map(([value]) => String(value))
      .find((value) => value.includes('learning_shadow_retrieval'))!;
    logs.mockRestore();
    expect(post).toHaveBeenCalledTimes(providerCallsBeforeShadow);
    const observed = await engine.respond(turn);
    expect(post).toHaveBeenCalledTimes(providerCallsBeforeShadow * 2);
    expect(
      JSON.stringify((post.mock.calls as Array<[string, unknown]>)[1][1]),
    ).toBe(JSON.stringify(payloadControl));
    expect(observed.replyText).toBe(control.replyText);
    expect(observed.learningExposed).toBeUndefined();
    expect(shadowEvent).not.toMatch(
      /Responder primero|Ofrecer descuento|Consulta sobre servicio/,
    );
    expect(shadowEvent).toContain(safeId);
    expect(shadowEvent).not.toContain('unsafe-commercial');
    expect(JSON.stringify(payloadControl)).not.toMatch(
      /123e4567|unsafe-commercial|Responder primero|Ofrecer descuento|approvedLearning/,
    );
    expect(shadow.prisma.learningItem.create).not.toHaveBeenCalled();
  });

  it.each([
    ['informational', 'Consulta sobre servicio'],
    ['price', 'Consulta sobre servicio y precio'],
    ['payment', 'Consulta sobre servicio y pago'],
    ['handoff', 'Consulta sobre servicio y atención humana'],
  ])('Nous request and output parity for %s', async (_scenario, message) => {
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        model: 'hermes-agent',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({ replyText: 'Con gusto le ayudo.' }),
            },
          },
        ],
      },
    });
    const transport = new NousHermesTransport(
      new ConfigService({}),
      new AgentOutputValidator(),
      {
        read: jest.fn().mockResolvedValue('synthetic-key'),
      },
      {
        reserveNousDispatch: jest.fn().mockResolvedValue(true),
      } as unknown as InboundTurnService,
    );
    const turn = inputFor(message);
    const control = await transport.execute(turn);
    const payloadControl = post.mock.calls[0][1];
    const providerCallsBeforeShadow = post.mock.calls.length;
    const shadow = shadowFor(message);
    const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    await shadow.observe('nous_hermes');
    const shadowEvent = logs.mock.calls
      .map(([value]) => String(value))
      .find((value) => value.includes('learning_shadow_retrieval'))!;
    logs.mockRestore();
    expect(post).toHaveBeenCalledTimes(providerCallsBeforeShadow);
    const observed = await transport.execute(turn);
    expect(post).toHaveBeenCalledTimes(providerCallsBeforeShadow * 2);
    expect(JSON.stringify(post.mock.calls[1][1])).toBe(
      JSON.stringify(payloadControl),
    );
    expect(observed.replyText).toBe(control.replyText);
    expect(observed.learningExposed).toBeUndefined();
    expect(shadowEvent).not.toMatch(
      /Responder primero|Ofrecer descuento|Consulta sobre servicio/,
    );
    expect(shadowEvent).toContain(safeId);
    expect(shadowEvent).not.toContain('unsafe-commercial');
    expect(JSON.stringify(payloadControl)).not.toMatch(
      /123e4567|unsafe-commercial|Responder primero|Ofrecer descuento|approvedLearning/,
    );
    expect(shadow.prisma.learningItem.create).not.toHaveBeenCalled();
  });
});
