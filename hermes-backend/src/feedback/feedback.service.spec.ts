import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  FeedbackRating,
  FeedbackReasonCode,
  MessageDirection,
  MessageSender,
  Prisma,
  UserRole,
} from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';

describe('Feedback de respuestas de Hermes', () => {
  const prisma = {
    message: { findFirst: jest.fn() },
    conversation: { findUnique: jest.fn() },
    conversationFeedback: {
      findUnique: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
    },
  };
  const service = new FeedbackService(prisma as unknown as PrismaService);
  const dto = {
    conversationId: '00000000-0000-4000-8000-000000000001',
    messageId: '00000000-0000-4000-8000-000000000002',
    rating: FeedbackRating.BAD,
    reasonCode: FeedbackReasonCode.REPETITION,
    suggestedReply: 'Una pregunta concreta',
    requestKey: '00000000-0000-4000-8000-000000000003',
  };
  const userId = 'operator-1';

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.conversationFeedback.findUnique.mockResolvedValue(null);
    prisma.message.findFirst.mockResolvedValue({ id: dto.messageId });
    prisma.conversationFeedback.create.mockResolvedValue({
      id: 'feedback-1',
      ...dto,
      userId,
    });
  });

  it('vincula un motivo a un outbound confirmado de Hermes de la conversación exacta', async () => {
    const result = await service.create(dto, userId);
    expect(result).toMatchObject({
      messageId: dto.messageId,
      userId,
      rating: FeedbackRating.BAD,
    });
    expect(prisma.message.findFirst).toHaveBeenCalledWith({
      where: {
        id: dto.messageId,
        conversationId: dto.conversationId,
        direction: MessageDirection.OUTBOUND,
        sender: MessageSender.HERMES,
        wamid: { not: null },
      },
      select: { id: true },
    });
    expect(prisma.conversationFeedback.create).toHaveBeenCalledTimes(1);
  });

  it('devuelve el mismo registro al reintentar la misma clave', async () => {
    const existing = { ...dto, userId, id: 'feedback-1' };
    prisma.conversationFeedback.findUnique.mockResolvedValue(existing);
    await expect(service.create(dto, userId)).resolves.toEqual(existing);
    expect(prisma.conversationFeedback.create).not.toHaveBeenCalled();
  });

  it('rechaza reutilizar una clave con otro mensaje u operador', async () => {
    prisma.conversationFeedback.findUnique.mockResolvedValue({
      ...dto,
      userId: 'other',
      id: 'feedback-1',
    });
    await expect(service.create(dto, userId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.conversationFeedback.create).not.toHaveBeenCalled();
  });

  it('rechaza mensajes no confirmados, ajenos o que no son de Hermes', async () => {
    prisma.message.findFirst.mockResolvedValue(null);
    await expect(service.create(dto, userId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.conversationFeedback.create).not.toHaveBeenCalled();
  });

  it('exige motivo para feedback negativo y evita corrección en feedback útil', async () => {
    await expect(
      service.create({ ...dto, reasonCode: undefined }, userId),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create({ ...dto, rating: FeedbackRating.GOOD }, userId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('resuelve una carrera de reintento con la restricción única', async () => {
    prisma.conversationFeedback.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '5.22.0',
      }),
    );
    prisma.conversationFeedback.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...dto, userId, id: 'feedback-1' });
    await expect(service.create(dto, userId)).resolves.toMatchObject({
      id: 'feedback-1',
    });
  });

  it('impide una segunda valoración del mismo operador al chocar la unicidad', async () => {
    prisma.conversationFeedback.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '5.22.0',
      }),
    );
    await expect(service.create(dto, userId)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('resume volumen y motivos sin incluir el texto de los mensajes', async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: dto.conversationId,
    });
    prisma.conversationFeedback.findMany.mockResolvedValue([
      { id: '1', rating: FeedbackRating.GOOD, reasonCode: null },
      {
        id: '2',
        rating: FeedbackRating.BAD,
        reasonCode: FeedbackReasonCode.REPETITION,
      },
      {
        id: '3',
        rating: FeedbackRating.BAD,
        reasonCode: FeedbackReasonCode.REPETITION,
      },
    ]);
    await expect(
      service.forConversation(dto.conversationId),
    ).resolves.toMatchObject({
      summary: { total: 3, good: 1, bad: 2, reasons: { REPETITION: 2 } },
    });
    expect(prisma.conversationFeedback.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversationId: dto.conversationId },
      }),
    );
  });

  it('protege la ruta con JWT y solo roles operativos', () => {
    expect(Reflect.getMetadata(ROLES_KEY, FeedbackController)).toEqual([
      UserRole.ADMIN,
      UserRole.SALES_AGENT,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, FeedbackController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
  });
});
