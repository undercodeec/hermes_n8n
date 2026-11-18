import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConversationStatus,
  HandoffStatus,
  MarketingConsentStatus,
  MessageDirection,
  MessageSender,
  MessageType,
  MobileReplyStatus,
  Prisma,
  UserRole,
} from '@prisma/client';
import { createHash } from 'crypto';
import { MetaService } from '../meta/meta.service';
import { whatsappReplyWindow } from '../meta/whatsapp-service-window';
import { PrismaService } from '../prisma/prisma.service';
import { MobileReplyDto } from './dto/mobile-reply.dto';

type Actor = { id: string; sessionId: string };
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class MobileReplyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaService,
    private readonly config: ConfigService,
  ) {}

  private validId(id: string | undefined): string {
    if (typeof id !== 'string' || !UUID.test(id))
      throw new BadRequestException('Idempotency-Key debe ser un UUID');
    return id.toLowerCase();
  }

  private publicStatus(operation: {
    operationId: string;
    status: MobileReplyStatus;
    messageId: string | null;
    wamid: string | null;
    createdAt: Date;
    dispatchStartedAt: Date | null;
    confirmedAt: Date | null;
    ambiguousAt: Date | null;
  }) {
    return {
      operationId: operation.operationId,
      status: operation.status,
      messageId: operation.messageId,
      wamid: operation.wamid,
      createdAt: operation.createdAt,
      dispatchStartedAt: operation.dispatchStartedAt,
      confirmedAt: operation.confirmedAt,
      ambiguousAt: operation.ambiguousAt,
      // A committed DISPATCHING may have reached Meta even after a crash.
      retryable: operation.status === MobileReplyStatus.PREPARED,
    };
  }

  async status(conversationId: string, operationId: string, actor: Actor) {
    const id = this.validId(operationId);
    const record = await this.prisma.mobileReplyOperation.findUnique({
      where: { operationId: id },
    });
    if (
      !record ||
      record.conversationId !== conversationId ||
      record.userId !== actor.id
    )
      throw new NotFoundException('Operación no encontrada');
    return this.publicStatus(record);
  }

  private async authorize(
    tx: Prisma.TransactionClient,
    conversationId: string,
    actor: Actor,
  ) {
    // Guard validates the JWT; lock/recheck account and session here too, so a
    // concurrent revocation or handoff change cannot commit ahead of the claim.
    const users = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "users" WHERE "id" = ${actor.id} FOR SHARE`;
    if (!users.length) throw new UnauthorizedException();
    const user = await tx.user.findUnique({
      where: { id: actor.id },
      select: { isActive: true, role: true, email: true },
    });
    const operatorEmail = this.config
      .get<string>('CRM_OPERATOR_EMAIL', 'gerencia@undercodeec.com')
      .trim()
      .toLowerCase();
    if (
      !user?.isActive ||
      user.role !== UserRole.ADMIN ||
      user.email.trim().toLowerCase() !== operatorEmail
    )
      throw new UnauthorizedException('Operador móvil no autorizado');
    const sessions = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "mobile_sessions" WHERE "id" = ${actor.sessionId}
      AND "userId" = ${actor.id} AND "revokedAt" IS NULL
      AND "expiresAt" > clock_timestamp() FOR SHARE`;
    if (!sessions.length)
      throw new UnauthorizedException('Sesión móvil vencida o revocada');

    // Shared with the web takeover/resolution and conversation status paths.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${conversationId}))`;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "conversations" WHERE "id" = ${conversationId} FOR SHARE`;
    if (!rows.length) throw new NotFoundException('Conversación no encontrada');
    const conversation = await tx.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: true },
    });
    if (!conversation)
      throw new NotFoundException('Conversación no encontrada');
    if (conversation.status !== ConversationStatus.HANDED_OFF)
      throw new ConflictException({ code: 'HUMAN_HANDOFF_REQUIRED' });
    const handoff = await tx.humanHandoff.findFirst({
      where: {
        conversationId,
        status: HandoffStatus.IN_PROGRESS,
        assignedAgentId: actor.id,
      },
      select: { id: true },
    });
    if (!handoff)
      throw new ConflictException({ code: 'HUMAN_HANDOFF_REQUIRED' });
    const contacts = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "contacts" WHERE "id" = ${conversation.contactId} FOR SHARE`;
    // Read AFTER acquiring the row lock (a concurrent opt-out may have
    // committed while the conversation/contact relation was being loaded).
    const contact = await tx.contact.findUnique({
      where: { id: conversation.contactId },
    });
    if (
      !contacts.length ||
      !contact ||
      contact.marketingConsentStatus === MarketingConsentStatus.OPTED_OUT ||
      contact.marketingOptOutAt !== null
    )
      throw new ForbiddenException({ code: 'CONTACT_OPTED_OUT' });
    if (conversation.channel.toLowerCase() !== 'whatsapp' || !contact.waId)
      throw new ConflictException({ code: 'WHATSAPP_CONTACT_REQUIRED' });
    const lastInbound = await tx.message.findFirst({
      where: {
        conversationId,
        sender: MessageSender.CONTACT,
        direction: MessageDirection.INBOUND,
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (!whatsappReplyWindow(lastInbound?.createdAt ?? null).isOpen)
      throw new BadRequestException({ code: 'WHATSAPP_TEMPLATE_REQUIRED' });
    return { conversation, waId: contact.waId };
  }

  async reply(
    conversationId: string,
    headerId: string | undefined,
    dto: MobileReplyDto,
    actor: Actor,
  ) {
    const operationId = this.validId(headerId);
    if (this.validId(dto.operationId) !== operationId)
      throw new ConflictException({ code: 'OPERATION_ID_MISMATCH' });
    if (
      typeof dto.content !== 'string' ||
      !dto.content.trim() ||
      dto.content.length > 4096
    )
      throw new BadRequestException('Contenido inválido');
    // Same intent is bound to exact bytes, conversation and authenticated actor.
    const contentHash = createHash('sha256')
      .update(JSON.stringify([conversationId, actor.id, dto.content]))
      .digest('hex');
    const existing = await this.prisma.mobileReplyOperation.findUnique({
      where: { operationId },
    });
    if (existing) {
      if (existing.userId !== actor.id)
        throw new NotFoundException('Operación no encontrada');
      if (
        existing.contentHash !== contentHash ||
        existing.conversationId !== conversationId
      )
        throw new ConflictException({ code: 'OPERATION_CONTENT_MISMATCH' });
      if (existing.status !== MobileReplyStatus.PREPARED)
        return this.publicStatus(existing);
    }
    // Default off: only a reviewed deployment with explicit opt-in may dispatch.
    if (this.config.get<string>('MOBILE_REPLY_ENABLED') !== 'true')
      throw new ServiceUnavailableException({ code: 'MOBILE_REPLY_DISABLED' });

    if (!existing) {
      // Serialize concurrent first requests by UUID BEFORE insertion. Never
      // overwrite an existing operation, including ones for another actor.
      const prepared = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${operationId}))`;
        const previous = await tx.mobileReplyOperation.findUnique({
          where: { operationId },
        });
        if (previous) return previous;
        await this.authorize(tx, conversationId, actor);
        return tx.mobileReplyOperation.create({
          data: { operationId, conversationId, userId: actor.id, contentHash },
        });
      });
      if (prepared.userId !== actor.id)
        throw new NotFoundException('Operación no encontrada');
      if (
        prepared.contentHash !== contentHash ||
        prepared.conversationId !== conversationId
      )
        throw new ConflictException({ code: 'OPERATION_CONTENT_MISMATCH' });
      if (prepared.status !== MobileReplyStatus.PREPARED)
        return this.publicStatus(prepared);
    }

    // A separate COMMITTED transaction reserves the only permitted Meta attempt.
    // No network I/O or Meta call is allowed inside a Prisma transaction.
    const claim = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${operationId}))`;
      const operation = await tx.mobileReplyOperation.findUnique({
        where: { operationId },
      });
      if (!operation || operation.userId !== actor.id)
        throw new NotFoundException('Operación no encontrada');
      if (
        operation.contentHash !== contentHash ||
        operation.conversationId !== conversationId
      )
        throw new ConflictException({ code: 'OPERATION_CONTENT_MISMATCH' });
      if (operation.status !== MobileReplyStatus.PREPARED)
        return { operation, waId: null };
      const conversation = await this.authorize(tx, conversationId, actor);
      const updated = await tx.mobileReplyOperation.updateMany({
        where: { operationId, status: MobileReplyStatus.PREPARED },
        data: {
          status: MobileReplyStatus.DISPATCHING,
          dispatchStartedAt: new Date(),
        },
      });
      if (updated.count !== 1)
        throw new ConflictException({ code: 'REPLY_CLAIM_LOST' });
      return {
        operation: await tx.mobileReplyOperation.findUniqueOrThrow({
          where: { operationId },
        }),
        waId: conversation.waId,
      };
    });
    if (!claim.waId) return this.publicStatus(claim.operation);

    let wamid: string | undefined;
    try {
      const sent = await this.meta.sendTextMessage(claim.waId, dto.content);
      wamid = sent?.messages?.[0]?.id;
    } catch {
      // Network failure is indistinguishable from Meta accepting a request.
    }
    if (!wamid) {
      await this.markAmbiguous(operationId);
      return this.status(conversationId, operationId, actor);
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${operationId}))`;
        const operation = await tx.mobileReplyOperation.findUniqueOrThrow({
          where: { operationId },
        });
        if (operation.status !== MobileReplyStatus.DISPATCHING) return;
        const conversation = await tx.conversation.findUniqueOrThrow({
          where: { id: conversationId },
        });
        const message = await tx.message.create({
          data: {
            conversationId,
            contactId: conversation.contactId,
            direction: MessageDirection.OUTBOUND,
            sender: MessageSender.HUMAN,
            sentByUserId: actor.id,
            type: MessageType.TEXT,
            content: dto.content,
            wamid,
            metadata: { source: 'crm_mobile', operationId },
          },
        });
        await tx.conversation.update({
          where: { id: conversationId },
          data: { updatedAt: new Date() },
        });
        await tx.auditLog.create({
          data: {
            userId: actor.id,
            action: 'MOBILE_HUMAN_MESSAGE_SENT',
            entity: 'conversations',
            entityId: conversationId,
            changes: { operationId, messageId: message.id, wamid },
          },
        });
        await tx.mobileReplyOperation.update({
          where: { operationId },
          data: {
            status: MobileReplyStatus.CONFIRMED,
            confirmedAt: new Date(),
            messageId: message.id,
            wamid,
          },
        });
      });
    } catch {
      // No retry after a successful Meta response, even when the DB commit fails.
      // DISPATCHING remains a durable unknown outcome for manual reconciliation.
      await this.markAmbiguous(operationId).catch(() => undefined);
    }
    return this.status(conversationId, operationId, actor);
  }

  private async markAmbiguous(operationId: string) {
    await this.prisma.mobileReplyOperation.updateMany({
      where: { operationId, status: MobileReplyStatus.DISPATCHING },
      data: { status: MobileReplyStatus.AMBIGUOUS, ambiguousAt: new Date() },
    });
  }
}
