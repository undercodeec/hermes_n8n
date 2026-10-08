import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FeedbackRating,
  MessageDirection,
  MessageSender,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateFeedbackDto } from './dto/create-feedback.dto';

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  private normalize(dto: CreateFeedbackDto) {
    const suggestedReply = dto.suggestedReply?.trim() || null;
    const reasonCode = dto.reasonCode ?? null;
    if (dto.rating === FeedbackRating.BAD && !reasonCode) {
      throw new BadRequestException('El feedback negativo requiere un motivo');
    }
    if (dto.rating === FeedbackRating.GOOD && (reasonCode || suggestedReply)) {
      throw new BadRequestException(
        'Una respuesta útil no admite motivo negativo ni corrección',
      );
    }
    return { reasonCode, suggestedReply };
  }

  private sameRequest(
    existing: {
      conversationId: string;
      messageId: string;
      userId: string;
      rating: FeedbackRating;
      reasonCode: string | null;
      suggestedReply: string | null;
      requestKey: string;
    },
    dto: CreateFeedbackDto,
    userId: string,
    normalized: { reasonCode: string | null; suggestedReply: string | null },
  ) {
    return (
      existing.requestKey === dto.requestKey &&
      existing.conversationId === dto.conversationId &&
      existing.messageId === dto.messageId &&
      existing.userId === userId &&
      existing.rating === dto.rating &&
      existing.reasonCode === normalized.reasonCode &&
      existing.suggestedReply === normalized.suggestedReply
    );
  }

  async create(dto: CreateFeedbackDto, userId: string) {
    const normalized = this.normalize(dto);
    const prior = await this.prisma.conversationFeedback.findUnique({
      where: { requestKey: dto.requestKey },
    });
    if (prior) {
      if (this.sameRequest(prior, dto, userId, normalized)) return prior;
      throw new ConflictException(
        'La clave de solicitud ya pertenece a otro feedback',
      );
    }

    const message = await this.prisma.message.findFirst({
      where: {
        id: dto.messageId,
        conversationId: dto.conversationId,
        direction: MessageDirection.OUTBOUND,
        sender: MessageSender.HERMES,
        wamid: { not: null },
      },
      select: { id: true },
    });
    if (!message) {
      throw new NotFoundException(
        'No hay una respuesta enviada por Hermes con ese mensaje y conversación',
      );
    }

    try {
      return await this.prisma.conversationFeedback.create({
        data: {
          conversationId: dto.conversationId,
          messageId: dto.messageId,
          userId,
          rating: dto.rating,
          reasonCode: normalized.reasonCode,
          suggestedReply: normalized.suggestedReply,
          requestKey: dto.requestKey,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const duplicate = await this.prisma.conversationFeedback.findUnique({
          where: { requestKey: dto.requestKey },
        });
        if (duplicate && this.sameRequest(duplicate, dto, userId, normalized)) {
          return duplicate;
        }
        throw new ConflictException(
          'Este operador ya valoró el mensaje o la clave está en uso',
        );
      }
      throw error;
    }
  }

  async forConversation(conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true },
    });
    if (!conversation)
      throw new NotFoundException('Conversación no encontrada');

    const data = await this.prisma.conversationFeedback.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        messageId: true,
        userId: true,
        rating: true,
        reasonCode: true,
        suggestedReply: true,
        createdAt: true,
        user: { select: { name: true } },
      },
    });
    const reasons: Record<string, number> = {};
    for (const item of data) {
      if (item.reasonCode) {
        reasons[item.reasonCode] = (reasons[item.reasonCode] ?? 0) + 1;
      }
    }
    return {
      data,
      summary: {
        total: data.length,
        good: data.filter((item) => item.rating === FeedbackRating.GOOD).length,
        bad: data.filter((item) => item.rating === FeedbackRating.BAD).length,
        reasons,
      },
    };
  }
}
