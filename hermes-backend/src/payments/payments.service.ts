import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  BankAccount,
  LeadStage,
  MessageDirection,
  MessageSender,
  MessageType,
  TaskStatus,
  TaskType,
  TransferPaymentStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LeadsService } from '../leads/leads.service';
import { AutomatedDeliveryService } from '../automated-deliveries/automated-delivery.service';
import { BankAccountDto, UpdateBankAccountDto } from './dto/bank-account.dto';
import {
  ApproveTransferDto,
  RejectTransferDto,
} from './dto/transfer-decision.dto';
import { TransferIntentPolicy } from './transfer-intent.policy';

const OPEN_STATUSES: TransferPaymentStatus[] = [
  TransferPaymentStatus.INSTRUCTIONS_PREPARED,
  TransferPaymentStatus.INSTRUCTIONS_SENT,
  TransferPaymentStatus.PROOF_RECEIVED,
  TransferPaymentStatus.UNDER_REVIEW,
];
const REVIEW_STATUSES: TransferPaymentStatus[] = [
  TransferPaymentStatus.PROOF_RECEIVED,
  TransferPaymentStatus.UNDER_REVIEW,
];
const INSTRUCTION_STATUSES: TransferPaymentStatus[] = [
  TransferPaymentStatus.INSTRUCTIONS_PREPARED,
  TransferPaymentStatus.INSTRUCTIONS_SENT,
];
const PROOF_TYPES: MessageType[] = [MessageType.IMAGE, MessageType.DOCUMENT];
const REQUEST_STAGES: LeadStage[] = [
  LeadStage.QUALIFIED,
  LeadStage.PROPOSAL,
  LeadStage.NEGOTIATION,
  LeadStage.PAYMENT_PENDING,
];

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly policy: TransferIntentPolicy,
    private readonly deliveries: AutomatedDeliveryService,
    private readonly leads: LeadsService,
  ) {}

  private enabled() {
    return this.config.get<string>('PAYMENTS_TRANSFER_ENABLED') === 'true';
  }

  private reviewSlaHours(): number {
    const configured = Number(
      this.config.get<string>('PAYMENTS_REVIEW_SLA_HOURS'),
    );
    return Number.isFinite(configured) && configured > 0 ? configured : 24;
  }

  private encryptionKey(): Buffer {
    const value = this.config.get<string>(
      'PAYMENTS_ACCOUNT_ENCRYPTION_KEY',
      '',
    );
    const key = /^[a-f0-9]{64}$/i.test(value)
      ? Buffer.from(value, 'hex')
      : Buffer.from(value, 'base64');
    if (key.length !== 32)
      throw new ServiceUnavailableException(
        'Clave de cuentas bancarias no configurada',
      );
    return key;
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`;
  }

  private decrypt(value: string): string {
    const [iv, tag, data] = value
      .split('.')
      .map((part) => Buffer.from(part, 'base64'));
    if (!iv || !tag || !data)
      throw new ServiceUnavailableException('Cuenta cifrada inválida');
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      'utf8',
    );
  }

  private safeAccount(account: BankAccount) {
    const safe = {
      ...account,
      accountNumberMasked: `••••${account.accountNumberLast4}`,
    };
    delete (safe as Partial<BankAccount>).accountNumberEncrypted;
    return safe;
  }

  private safeTransfer<T extends { bankAccountSnapshot: unknown }>(
    transfer: T,
  ): Omit<T, 'bankAccountSnapshot'> {
    const safe = { ...transfer };
    delete (safe as Partial<T>).bankAccountSnapshot;
    return safe;
  }

  async listAccounts() {
    return (
      await this.prisma.bankAccount.findMany({
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      })
    ).map((account) => this.safeAccount(account));
  }

  async createAccount(dto: BankAccountDto, userId: string) {
    const account = await this.prisma.bankAccount.create({
      data: {
        label: dto.label.trim(),
        bankName: dto.bankName.trim(),
        accountHolder: dto.accountHolder.trim(),
        holderIdentification: dto.holderIdentification?.trim(),
        accountType: dto.accountType,
        accountNumberEncrypted: this.encrypt(dto.accountNumber),
        accountNumberLast4: dto.accountNumber.replace(/\D/g, '').slice(-4),
        currency: dto.currency,
        instructions: dto.instructions?.trim(),
        priority: dto.priority ?? 0,
        isActive: dto.isActive ?? true,
        createdByUserId: userId,
        updatedByUserId: userId,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        userId,
        action: 'BANK_ACCOUNT_CREATED',
        entity: 'bank_accounts',
        entityId: account.id,
      },
    });
    return this.safeAccount(account);
  }

  async updateAccount(id: string, dto: UpdateBankAccountDto, userId: string) {
    const account = await this.prisma.bankAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundException('Cuenta bancaria no encontrada');
    const { accountNumber, ...rest } = dto;
    const updated = await this.prisma.bankAccount.update({
      where: { id },
      data: {
        ...rest,
        updatedByUserId: userId,
        ...(accountNumber
          ? {
              accountNumberEncrypted: this.encrypt(accountNumber),
              accountNumberLast4: accountNumber.replace(/\D/g, '').slice(-4),
            }
          : {}),
      },
    });
    await this.prisma.auditLog.create({
      data: {
        userId,
        action:
          dto.isActive === false
            ? 'BANK_ACCOUNT_DEACTIVATED'
            : 'BANK_ACCOUNT_UPDATED',
        entity: 'bank_accounts',
        entityId: id,
      },
    });
    return this.safeAccount(updated);
  }

  async byConversation(conversationId: string) {
    const transfer = await this.prisma.transferPayment.findFirst({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      include: {
        proofMessages: {
          orderBy: { receivedAt: 'asc' },
          select: { messageId: true, receivedAt: true },
        },
      },
    });
    if (!transfer) return null;
    return this.safeTransfer(transfer);
  }

  async getTransfer(id: string) {
    const transfer = await this.prisma.transferPayment.findUnique({
      where: { id },
      include: {
        proofMessages: {
          orderBy: { receivedAt: 'asc' },
          select: { messageId: true, receivedAt: true },
        },
      },
    });
    if (!transfer) throw new NotFoundException('Transferencia no encontrada');
    // The snapshot contains account data and must not be returned in a general read.
    return this.safeTransfer(transfer);
  }

  async maybeSendInstructions(params: {
    conversationId: string;
    contactId: string;
    sourceMessageId: string;
    text: string;
  }): Promise<boolean> {
    if (!this.enabled()) return false;
    const lead = await this.prisma.lead.findFirst({
      where: {
        conversationId: params.conversationId,
        contactId: params.contactId,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!lead) return false;
    const currency = lead.commercialCurrency || 'USD';
    const account = await this.prisma.bankAccount.findFirst({
      where: { isActive: true, currency },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
    const amount = Number(lead.proposalValue || 0);
    const priorApproved = await this.prisma.transferPayment.count({
      where: { leadId: lead.id, status: TransferPaymentStatus.APPROVED },
    });
    const decision = this.policy.analyze(params.text, {
      service: lead.serviceRequested || lead.productOfInterest,
      amount,
      leadOpen: REQUEST_STAGES.includes(lead.stage),
      hasApprovedTransfer: priorApproved > 0,
      hasActiveAccount: Boolean(account),
    });
    if (!decision.approved || !account) return false;
    const existing = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.conversationId}))`;
      const open = await tx.transferPayment.findFirst({
        where: {
          conversationId: params.conversationId,
          status: { in: OPEN_STATUSES },
        },
      });
      if (open) return open;
      const transfer = await tx.transferPayment.create({
        data: {
          leadId: lead.id,
          conversationId: params.conversationId,
          contactId: params.contactId,
          bankAccountId: account.id,
          bankAccountSnapshot: {
            bankName: account.bankName,
            accountHolder: account.accountHolder,
            holderIdentification: account.holderIdentification,
            accountType: account.accountType,
            accountNumberEncrypted: account.accountNumberEncrypted,
            currency,
            instructions: account.instructions,
          },
          amountExpected: amount,
          currency,
          sourceMessageId: params.sourceMessageId,
        },
      });
      await tx.lead.update({
        where: { id: lead.id },
        data: { stage: LeadStage.PAYMENT_PENDING, score: 100 },
      });
      await tx.auditLog.create({
        data: {
          action: 'TRANSFER_INSTRUCTIONS_PREPARED',
          entity: 'transfer_payments',
          entityId: transfer.id,
          changes: {
            sourceMessageId: params.sourceMessageId,
            policyVersion: decision.policyVersion,
            reason: decision.reason,
          },
        },
      });
      return transfer;
    });
    const deliverySourceId =
      existing.status === TransferPaymentStatus.INSTRUCTIONS_PREPARED
        ? existing.sourceMessageId
        : params.sourceMessageId;
    const snapshot = existing.bankAccountSnapshot as Record<string, string>;
    const content = `Puedes realizar la transferencia con estos datos:\n\nBanco: ${snapshot.bankName}\nTitular: ${snapshot.accountHolder}\nTipo de cuenta: ${snapshot.accountType}\nCuenta: ${this.decrypt(snapshot.accountNumberEncrypted)}\nMoneda: ${snapshot.currency}${snapshot.holderIdentification ? `\nIdentificación: ${snapshot.holderIdentification}` : ''}${snapshot.instructions ? `\nReferencia: ${snapshot.instructions}` : ''}\n\nCuando la realices, envíanos por este chat el comprobante para validarlo.`;
    await this.deliveries.prepareBatch({
      deliveryKind: 'SYSTEM_NOTICE',
      conversationId: params.conversationId,
      contactId: params.contactId,
      sourceMessageId: deliverySourceId,
      sender: 'SYSTEM',
      allowHandedOff: false,
      parts: [
        {
          partIndex: 0,
          content,
          metadata: {
            action: 'TRANSFER_INSTRUCTIONS',
            transferPaymentId: existing.id,
          },
        },
      ],
    });
    const delivered =
      await this.deliveries.deliverPreparedBatch(deliverySourceId);
    if (delivered.confirmed > 0)
      await this.reconcileInstruction(existing.sourceMessageId);
    return true;
  }

  async reconcileInstruction(sourceMessageId: string): Promise<void> {
    const payment = await this.prisma.transferPayment.findUnique({
      where: { sourceMessageId },
    });
    if (!payment || payment.instructionsMessageId) return;
    const outbound = await this.prisma.automatedDelivery.findFirst({
      where: { sourceMessageId, deliveryKind: 'SYSTEM_NOTICE', partIndex: 0 },
      select: { outboundMessageId: true },
    });
    if (!outbound?.outboundMessageId) return;
    await this.prisma.$transaction(async (tx) => {
      const prepared = await tx.transferPayment.updateMany({
        where: {
          id: payment.id,
          instructionsMessageId: null,
          status: TransferPaymentStatus.INSTRUCTIONS_PREPARED,
        },
        data: {
          instructionsMessageId: outbound.outboundMessageId,
          status: TransferPaymentStatus.INSTRUCTIONS_SENT,
        },
      });
      const other = prepared.count
        ? { count: 0 }
        : await tx.transferPayment.updateMany({
            where: { id: payment.id, instructionsMessageId: null },
            data: { instructionsMessageId: outbound.outboundMessageId },
          });
      if (prepared.count || other.count)
        await tx.auditLog.create({
          data: {
            action: 'TRANSFER_INSTRUCTIONS_SENT',
            entity: 'transfer_payments',
            entityId: payment.id,
            changes: {
              sourceMessageId,
              instructionsMessageId: outbound.outboundMessageId,
            },
          },
        });
    });
  }

  async maybeReplyWithStatus(params: {
    conversationId: string;
    contactId: string;
    sourceMessageId: string;
    text: string;
  }): Promise<boolean> {
    if (!this.enabled()) return false;
    const text = params.text
      .toLocaleLowerCase('es')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (
      !/(comprobante|transferencia|pago)/.test(text) ||
      !/(recib|aprob|valid|confirm|estado)/.test(text)
    )
      return false;
    const payment = await this.prisma.transferPayment.findFirst({
      where: {
        conversationId: params.conversationId,
        contactId: params.contactId,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) return false;
    const content =
      payment.status === TransferPaymentStatus.APPROVED
        ? 'Tu transferencia fue confirmada por nuestro equipo.'
        : payment.status === TransferPaymentStatus.REJECTED
          ? 'El comprobante no fue aprobado. Un asesor puede ayudarte a revisar el motivo y los siguientes pasos.'
          : REVIEW_STATUSES.includes(payment.status)
            ? 'Recibimos tu comprobante y sigue en validación. Te confirmaremos cuando el equipo termine la revisión.'
            : payment.status === TransferPaymentStatus.INSTRUCTIONS_PREPARED
              ? 'Estamos preparando los datos de transferencia. Te avisaremos por este chat cuando estén disponibles.'
              : 'Todavía no tenemos un comprobante registrado para esta transferencia. Puedes enviarlo por este chat.';
    await this.deliveries.prepareBatch({
      deliveryKind: 'SYSTEM_NOTICE',
      conversationId: params.conversationId,
      contactId: params.contactId,
      sourceMessageId: params.sourceMessageId,
      sender: 'SYSTEM',
      allowHandedOff: false,
      parts: [
        { partIndex: 0, content, metadata: { action: 'TRANSFER_STATUS' } },
      ],
    });
    await this.deliveries.deliverPreparedBatch(params.sourceMessageId);
    return true;
  }

  async detectProof(messageId: string): Promise<boolean> {
    if (!this.enabled()) return false;
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        conversationId: true,
        contactId: true,
        type: true,
        direction: true,
        sender: true,
        rawPayload: true,
      },
    });
    if (
      !message ||
      message.direction !== MessageDirection.INBOUND ||
      message.sender !== MessageSender.CONTACT ||
      !PROOF_TYPES.includes(message.type)
    )
      return false;
    const payload =
      message.rawPayload &&
      typeof message.rawPayload === 'object' &&
      !Array.isArray(message.rawPayload)
        ? (message.rawPayload as Record<string, unknown>)
        : null;
    const media = payload?.[message.type.toLowerCase()];
    const declaredMime =
      media && typeof media === 'object' && !Array.isArray(media)
        ? (media as Record<string, unknown>).mime_type
        : null;
    if (
      message.type === MessageType.DOCUMENT &&
      declaredMime !== 'application/pdf'
    )
      return false;
    if (
      message.type === MessageType.IMAGE &&
      !['image/jpeg', 'image/png'].includes(String(declaredMime))
    )
      return false;
    const transfer = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${message.conversationId}))`;
      const payment = await tx.transferPayment.findFirst({
        where: {
          conversationId: message.conversationId,
          contactId: message.contactId,
          status: { in: OPEN_STATUSES },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!payment) return null;
      const recorded = await tx.transferPaymentProofMessage.findUnique({
        where: { messageId },
      });
      if (recorded) return payment;
      await tx.transferPaymentProofMessage.upsert({
        where: { messageId },
        create: { messageId, transferPaymentId: payment.id },
        update: {},
      });
      if (INSTRUCTION_STATUSES.includes(payment.status)) {
        await tx.transferPayment.update({
          where: { id: payment.id },
          data: {
            status: TransferPaymentStatus.PROOF_RECEIVED,
            proofReceivedAt: new Date(),
          },
        });
        await tx.lead.update({
          where: { id: payment.leadId },
          data: { stage: LeadStage.PAYMENT_REVIEW },
        });
      }
      const task = await tx.task.findFirst({
        where: {
          conversationId: message.conversationId,
          type: TaskType.PAYMENT_VERIFICATION,
          status: { in: [TaskStatus.PENDING, TaskStatus.IN_PROGRESS] },
        },
      });
      if (!task)
        await tx.task.create({
          data: {
            leadId: payment.leadId,
            conversationId: message.conversationId,
            type: TaskType.PAYMENT_VERIFICATION,
            title: 'Validar comprobante de transferencia',
            description:
              'Abrir el chat Inbox de esta conversación para revisar el comprobante.',
            dueAt: new Date(Date.now() + this.reviewSlaHours() * 3_600_000),
            metadata: {
              transferPaymentId: payment.id,
              latestProofMessageId: messageId,
            },
          },
        });
      else
        await tx.task.update({
          where: { id: task.id },
          data: {
            metadata: {
              transferPaymentId: payment.id,
              latestProofMessageId: messageId,
            },
          },
        });
      await tx.auditLog.create({
        data: {
          action: 'TRANSFER_PROOF_RECEIVED',
          entity: 'transfer_payments',
          entityId: payment.id,
          changes: { messageId },
        },
      });
      return payment;
    });
    if (!transfer) return false;
    await this.deliveries.prepareBatch({
      deliveryKind: 'SYSTEM_NOTICE',
      conversationId: message.conversationId,
      contactId: message.contactId,
      sourceMessageId: messageId,
      sender: 'SYSTEM',
      allowHandedOff: false,
      parts: [
        {
          partIndex: 0,
          content:
            'Recibimos tu comprobante. Nuestro equipo lo validará y se comunicará contigo apenas esté confirmado.',
          metadata: { action: 'TRANSFER_PROOF_RECEIVED' },
        },
      ],
    });
    await this.deliveries.deliverPreparedBatch(messageId);
    return true;
  }

  async startReview(id: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const transfer = await tx.transferPayment.findUnique({ where: { id } });
      if (!transfer) throw new NotFoundException('Transferencia no encontrada');
      if (!REVIEW_STATUSES.includes(transfer.status))
        throw new ConflictException('Transferencia no pendiente de revisión');
      const updated = await tx.transferPayment.update({
        where: { id },
        data: {
          status: TransferPaymentStatus.UNDER_REVIEW,
          reviewStartedAt: transfer.reviewStartedAt || new Date(),
        },
      });
      await tx.task.updateMany({
        where: {
          conversationId: transfer.conversationId,
          type: TaskType.PAYMENT_VERIFICATION,
          status: TaskStatus.PENDING,
        },
        data: { status: TaskStatus.IN_PROGRESS, assignedUserId: userId },
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: 'TRANSFER_REVIEW_STARTED',
          entity: 'transfer_payments',
          entityId: id,
        },
      });
      return this.safeTransfer(updated);
    });
  }

  async approve(id: string, dto: ApproveTransferDto, userId: string) {
    if (!dto.contractReference?.trim())
      throw new BadRequestException('Referencia de contrato obligatoria');
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const payment = await tx.transferPayment.findUnique({ where: { id } });
      if (!payment) throw new NotFoundException('Transferencia no encontrada');
      if (
        payment.status !== dto.expectedStatus ||
        !REVIEW_STATUSES.includes(payment.status)
      )
        throw new ConflictException('Estado de transferencia cambió');
      const proof = await tx.transferPaymentProofMessage.findFirst({
        where: { transferPaymentId: id, messageId: dto.reviewedProofMessageId },
        include: { message: { select: { conversationId: true } } },
      });
      if (!proof || proof.message.conversationId !== payment.conversationId)
        throw new BadRequestException('Comprobante ajeno a la conversación');
      const lead = await tx.lead.findUnique({ where: { id: payment.leadId } });
      if (!lead || lead.stage !== LeadStage.PAYMENT_REVIEW)
        throw new ConflictException('Etapa del lead cambió');
      const updatedLead = await tx.lead.update({
        where: { id: lead.id },
        data: {
          stage: LeadStage.WON,
          wonAt: new Date(),
          contractedAmount: payment.amountExpected,
          revenueReceived: payment.amountExpected,
          commercialCurrency: payment.currency,
          contractReference: dto.contractReference.trim(),
        },
      });
      await this.leads.recordWonMilestone(
        tx,
        updatedLead,
        userId,
        'TRANSFER_APPROVAL',
      );
      const updated = await tx.transferPayment.update({
        where: { id },
        data: {
          status: TransferPaymentStatus.APPROVED,
          approvedAt: new Date(),
          approvedByUserId: userId,
          reviewedProofMessageId: dto.reviewedProofMessageId,
          reviewNote: dto.reviewNote?.trim(),
        },
      });
      await tx.task.updateMany({
        where: {
          conversationId: payment.conversationId,
          type: TaskType.PAYMENT_VERIFICATION,
          status: { in: [TaskStatus.PENDING, TaskStatus.IN_PROGRESS] },
        },
        data: { status: TaskStatus.COMPLETED, completedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: 'TRANSFER_APPROVED',
          entity: 'transfer_payments',
          entityId: id,
          changes: {
            reviewedProofMessageId: dto.reviewedProofMessageId,
            leadId: lead.id,
          },
        },
      });
      return updated;
    });
    await this.sendDecisionNotice(
      updated,
      'Tu transferencia fue confirmada por nuestro equipo. Gracias por confiar en nosotros.',
    );
    return this.safeTransfer(updated);
  }

  async reject(id: string, dto: RejectTransferDto, userId: string) {
    if (!dto.reviewNote?.trim())
      throw new BadRequestException('Motivo obligatorio');
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const payment = await tx.transferPayment.findUnique({ where: { id } });
      if (!payment) throw new NotFoundException('Transferencia no encontrada');
      if (
        payment.status !== dto.expectedStatus ||
        !REVIEW_STATUSES.includes(payment.status)
      )
        throw new ConflictException('Estado de transferencia cambió');
      const updated = await tx.transferPayment.update({
        where: { id },
        data: {
          status: TransferPaymentStatus.REJECTED,
          rejectedAt: new Date(),
          rejectedByUserId: userId,
          reviewNote: dto.reviewNote.trim(),
        },
      });
      await tx.lead.update({
        where: { id: payment.leadId },
        data: { stage: LeadStage.PAYMENT_PENDING },
      });
      await tx.task.updateMany({
        where: {
          conversationId: payment.conversationId,
          type: TaskType.PAYMENT_VERIFICATION,
          status: { in: [TaskStatus.PENDING, TaskStatus.IN_PROGRESS] },
        },
        data: { status: TaskStatus.COMPLETED, completedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: 'TRANSFER_REJECTED',
          entity: 'transfer_payments',
          entityId: id,
          changes: { reason: dto.reviewNote.trim() },
        },
      });
      return updated;
    });
    await this.sendDecisionNotice(
      updated,
      'No pudimos validar el comprobante enviado. Un asesor revisará contigo el motivo y los siguientes pasos.',
    );
    return this.safeTransfer(updated);
  }

  private async sendDecisionNotice(
    payment: {
      id: string;
      conversationId: string;
      contactId: string;
      sourceMessageId: string;
    },
    content: string,
  ) {
    try {
      const latestProof =
        await this.prisma.transferPaymentProofMessage.findFirst({
          where: { transferPaymentId: payment.id },
          orderBy: { receivedAt: 'desc' },
          select: { messageId: true },
        });
      const sourceMessageId = latestProof?.messageId || payment.sourceMessageId;
      await this.deliveries.prepareBatch({
        deliveryKind: 'SYSTEM_NOTICE',
        conversationId: payment.conversationId,
        contactId: payment.contactId,
        sourceMessageId,
        sender: 'SYSTEM',
        allowHandedOff: false,
        parts: [
          {
            partIndex: 1,
            content,
            metadata: {
              action: 'TRANSFER_DECISION',
              transferPaymentId: payment.id,
            },
          },
        ],
      });
      await this.deliveries.deliverPreparedBatch(sourceMessageId);
    } catch (error) {
      this.logger.warn(
        `Transfer decision saved, WhatsApp notice pending for ${payment.id}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }
}
