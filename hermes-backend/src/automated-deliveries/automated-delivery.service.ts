import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  AutomatedDelivery,
  AutomatedDeliveryStatus,
  ConversationStatus,
  HandoffStatus,
  MarketingConsentStatus,
  MessageDirection,
  MessageType,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { MetaSendError, MetaService } from '../meta/meta.service';
import { whatsappReplyWindow } from '../meta/whatsapp-service-window';
import { PrismaService } from '../prisma/prisma.service';
import {
  AutomatedDeliveryBatchResult,
  PrepareAutomatedDeliveryBatch,
} from './automated-delivery.types';

const CLAIM_LEASE_MS = 60_000;
const RECOVERY_INTERVAL_MS = 15_000;
const OPEN_HANDOFF_STATUSES: HandoffStatus[] = [
  HandoffStatus.PENDING,
  HandoffStatus.ASSIGNED,
  HandoffStatus.IN_PROGRESS,
];
const TERMINAL_STATUSES: AutomatedDeliveryStatus[] = [
  AutomatedDeliveryStatus.CONFIRMED,
  AutomatedDeliveryStatus.REJECTED,
  AutomatedDeliveryStatus.AMBIGUOUS,
  AutomatedDeliveryStatus.SUPPRESSED,
];

type ClaimResult =
  | {
      claimed: true;
      operation: AutomatedDelivery;
      waId: string;
      claimToken: string;
    }
  | { claimed: false; terminal: boolean; reasonCode: string };

@Injectable()
export class AutomatedDeliveryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AutomatedDeliveryService.name);
  private recoveryTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaService,
  ) {}

  async prepareBatch(input: PrepareAutomatedDeliveryBatch): Promise<void> {
    for (const part of input.parts) {
      const operationKey = `${input.sourceMessageId}:${input.deliveryKind}:${part.partIndex}`;
      await this.prisma.automatedDelivery.upsert({
        where: { operationKey },
        create: {
          operationKey,
          deliveryKind: input.deliveryKind,
          partIndex: part.partIndex,
          conversationId: input.conversationId,
          contactId: input.contactId,
          sourceMessageId: input.sourceMessageId,
          sender: input.sender,
          content: part.content,
          allowHandedOff: input.allowHandedOff,
          metadata: part.metadata as Prisma.InputJsonValue | undefined,
        },
        update: {},
      });
    }
  }

  async recoverBatch(
    sourceMessageId: string,
  ): Promise<AutomatedDeliveryBatchResult | null> {
    const rows = await this.prisma.automatedDelivery.findMany({
      where: { sourceMessageId },
      orderBy: { partIndex: 'asc' },
    });
    if (!rows.length) return null;
    const result = await this.deliverPreparedBatch(sourceMessageId);
    return { ...result, handled: true };
  }

  async deliverPreparedBatch(
    sourceMessageId: string,
  ): Promise<AutomatedDeliveryBatchResult> {
    const operations = await this.prisma.automatedDelivery.findMany({
      where: { sourceMessageId },
      orderBy: { partIndex: 'asc' },
    });
    if (!operations.length) {
      return { handled: false, confirmed: 0, terminal: false };
    }

    let confirmed = operations.filter(
      (row) => row.status === AutomatedDeliveryStatus.CONFIRMED,
    ).length;

    for (const operation of operations) {
      if (operation.status === AutomatedDeliveryStatus.CONFIRMED) continue;
      if (TERMINAL_STATUSES.includes(operation.status)) {
        return {
          handled: true,
          confirmed,
          terminal: true,
          reasonCode: operation.reasonCode || operation.status,
        };
      }
      if (
        operation.status === AutomatedDeliveryStatus.DISPATCHING &&
        operation.claimExpiresAt &&
        operation.claimExpiresAt.getTime() > Date.now()
      ) {
        return {
          handled: true,
          confirmed,
          terminal: false,
          reasonCode: 'DELIVERY_IN_PROGRESS',
        };
      }

      const claim = await this.claim(operation);
      if (!claim.claimed) {
        return {
          handled: true,
          confirmed,
          terminal: claim.terminal,
          reasonCode: claim.reasonCode,
        };
      }

      try {
        const response = await this.meta.sendTextMessage(
          claim.waId,
          claim.operation.content,
        );
        const wamid = response.messages[0].id;
        await this.confirm(claim.operation, claim.claimToken, wamid);
        confirmed += 1;
      } catch (error) {
        const result = await this.handleDispatchFailure(
          claim.operation,
          claim.claimToken,
          error,
        );
        if (result.retry) throw error;
        return {
          handled: true,
          confirmed,
          terminal: true,
          reasonCode: result.reasonCode,
        };
      }
    }

    return { handled: true, confirmed, terminal: true };
  }

  async recoverExpiredClaims(now = new Date()): Promise<number> {
    const result = await this.prisma.automatedDelivery.updateMany({
      where: {
        status: AutomatedDeliveryStatus.DISPATCHING,
        claimExpiresAt: { lt: now },
      },
      data: {
        status: AutomatedDeliveryStatus.AMBIGUOUS,
        ambiguousAt: now,
        reasonCode: 'CLAIM_EXPIRED',
        claimToken: null,
        claimExpiresAt: null,
      },
    });
    return result.count;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.recoverExpiredClaims();
    this.recoveryTimer = setInterval(() => {
      void this.recoverExpiredClaims().catch((error: unknown) => {
        this.logger.error(
          `No se pudieron recuperar claims vencidos: ${this.safeError(error)}`,
        );
      });
    }, RECOVERY_INTERVAL_MS);
    this.recoveryTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  private async claim(operation: AutomatedDelivery): Promise<ClaimResult> {
    const now = new Date();
    const claimToken = randomUUID();
    const claimExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${operation.operationKey}))`;
      const current = await tx.automatedDelivery.findUnique({
        where: { id: operation.id },
      });
      if (!current) {
        return {
          claimed: false,
          terminal: true,
          reasonCode: 'DELIVERY_MISSING',
        };
      }
      if (current.status !== AutomatedDeliveryStatus.PREPARED) {
        return {
          claimed: false,
          terminal: TERMINAL_STATUSES.includes(current.status),
          reasonCode:
            current.reasonCode ||
            (current.status === AutomatedDeliveryStatus.DISPATCHING
              ? 'DELIVERY_IN_PROGRESS'
              : current.status),
        };
      }

      const [conversation, contact, handoff, sourceMessage, latestInbound] =
        await Promise.all([
          tx.conversation.findUnique({ where: { id: current.conversationId } }),
          tx.contact.findUnique({ where: { id: current.contactId } }),
          tx.humanHandoff.findFirst({
            where: {
              conversationId: current.conversationId,
              status: { in: OPEN_HANDOFF_STATUSES },
            },
          }),
          tx.message.findUnique({ where: { id: current.sourceMessageId } }),
          tx.message.findFirst({
            where: {
              conversationId: current.conversationId,
              direction: MessageDirection.INBOUND,
            },
            orderBy: { createdAt: 'desc' },
          }),
        ]);

      const reasonCode = this.ineligibilityReason({
        current,
        conversation,
        contact,
        handoff,
        sourceMessage,
        latestInbound,
        now,
      });
      if (reasonCode) {
        await tx.automatedDelivery.updateMany({
          where: {
            id: current.id,
            status: AutomatedDeliveryStatus.PREPARED,
            claimToken: null,
          },
          data: {
            status: AutomatedDeliveryStatus.SUPPRESSED,
            suppressedAt: now,
            reasonCode,
          },
        });
        return { claimed: false, terminal: true, reasonCode };
      }

      const claimed = await tx.automatedDelivery.updateMany({
        where: {
          id: current.id,
          status: AutomatedDeliveryStatus.PREPARED,
          claimToken: null,
        },
        data: {
          status: AutomatedDeliveryStatus.DISPATCHING,
          claimToken,
          claimExpiresAt,
          dispatchStartedAt: now,
          attempts: { increment: 1 },
        },
      });
      if (claimed.count !== 1) {
        return {
          claimed: false,
          terminal: false,
          reasonCode: 'DELIVERY_IN_PROGRESS',
        };
      }
      return {
        claimed: true,
        operation: current,
        waId: contact!.waId,
        claimToken,
      };
    });
  }

  private ineligibilityReason(input: {
    current: AutomatedDelivery;
    conversation: { status: ConversationStatus } | null;
    contact: { marketingConsentStatus: MarketingConsentStatus } | null;
    handoff: { id: string } | null;
    sourceMessage: {
      id: string;
      createdAt: Date;
      rawPayload: Prisma.JsonValue;
    } | null;
    latestInbound: {
      id: string;
      createdAt: Date;
      rawPayload: Prisma.JsonValue;
    } | null;
    now: Date;
  }): string | null {
    const {
      current,
      conversation,
      contact,
      handoff,
      sourceMessage,
      latestInbound,
      now,
    } = input;
    if (!conversation || !contact || !sourceMessage || !latestInbound) {
      return 'DELIVERY_CONTEXT_MISSING';
    }
    const sourceAt = this.providerTimestamp(sourceMessage);
    const latestAt = this.providerTimestamp(latestInbound);
    if (
      latestInbound.id !== sourceMessage.id &&
      latestAt.getTime() > sourceAt.getTime()
    ) {
      return 'NEWER_INBOUND';
    }
    if (contact.marketingConsentStatus === MarketingConsentStatus.OPTED_OUT) {
      return 'CONTACT_OPTED_OUT';
    }
    if (handoff && !current.allowHandedOff) return 'HANDOFF_ACTIVE';
    const active = conversation.status === ConversationStatus.ACTIVE;
    const allowedTransition =
      current.allowHandedOff &&
      conversation.status === ConversationStatus.HANDED_OFF;
    if (!active && !allowedTransition) return 'CONVERSATION_NOT_ACTIVE';
    if (!whatsappReplyWindow(latestAt, now).isOpen) {
      return 'WHATSAPP_TEMPLATE_REQUIRED';
    }
    return null;
  }

  private providerTimestamp(message: {
    createdAt: Date;
    rawPayload: Prisma.JsonValue;
  }): Date {
    const raw = message.rawPayload;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const timestamp = raw.timestamp;
      if (typeof timestamp === 'string' || typeof timestamp === 'number') {
        const numeric = Number(timestamp);
        if (Number.isFinite(numeric) && numeric > 0) {
          const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
          const parsed = new Date(millis);
          if (!Number.isNaN(parsed.getTime())) return parsed;
        }
      }
    }
    return message.createdAt;
  }

  private async confirm(
    operation: AutomatedDelivery,
    claimToken: string,
    wamid: string,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.automatedDelivery.findUnique({
        where: { id: operation.id },
      });
      if (
        !current ||
        current.status !== AutomatedDeliveryStatus.DISPATCHING ||
        current.claimToken !== claimToken
      ) {
        throw new Error('delivery claim ownership lost');
      }
      const message = await tx.message.create({
        data: {
          conversationId: operation.conversationId,
          contactId: operation.contactId,
          direction: MessageDirection.OUTBOUND,
          sender: operation.sender,
          type: MessageType.TEXT,
          content: operation.content,
          wamid,
          metadata: operation.metadata ?? undefined,
        },
      });
      await tx.automatedDelivery.update({
        where: { id: operation.id },
        data: {
          status: AutomatedDeliveryStatus.CONFIRMED,
          outboundMessageId: message.id,
          wamid,
          confirmedAt: now,
          claimToken: null,
          claimExpiresAt: null,
          reasonCode: null,
        },
      });
    });
  }

  private async handleDispatchFailure(
    operation: AutomatedDelivery,
    claimToken: string,
    error: unknown,
  ): Promise<{ retry: boolean; reasonCode: string }> {
    const now = new Date();
    const metaError = error instanceof MetaSendError ? error : null;
    if (metaError?.retryable && metaError.providerStatus === 429) {
      await this.prisma.automatedDelivery.updateMany({
        where: {
          id: operation.id,
          status: AutomatedDeliveryStatus.DISPATCHING,
          claimToken,
        },
        data: {
          status: AutomatedDeliveryStatus.PREPARED,
          claimToken: null,
          claimExpiresAt: null,
          reasonCode: metaError.safeCode,
        },
      });
      return { retry: true, reasonCode: metaError.safeCode };
    }

    const rejected = metaError?.outcome === 'DEFINITIVE_REJECTION';
    const status = rejected
      ? AutomatedDeliveryStatus.REJECTED
      : AutomatedDeliveryStatus.AMBIGUOUS;
    const reasonCode = metaError?.safeCode || 'UNEXPECTED_DISPATCH_FAILURE';
    await this.prisma.automatedDelivery.updateMany({
      where: {
        id: operation.id,
        status: AutomatedDeliveryStatus.DISPATCHING,
        claimToken,
      },
      data: {
        status,
        ...(rejected ? { rejectedAt: now } : { ambiguousAt: now }),
        reasonCode,
        claimToken: null,
        claimExpiresAt: null,
      },
    });
    this.logger.error(`Entrega ${status}: ${reasonCode}`);
    return { retry: false, reasonCode };
  }

  private safeError(error: unknown): string {
    return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
  }
}
