/* eslint-disable @typescript-eslint/unbound-method */
import { ConfigService } from '@nestjs/config';
import {
  LeadStage,
  MessageDirection,
  MessageSender,
  MessageType,
  TransferPaymentStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LeadsService } from '../leads/leads.service';
import { AutomatedDeliveryService } from '../automated-deliveries/automated-delivery.service';
import { PaymentsService } from './payments.service';
import { TransferIntentPolicy } from './transfer-intent.policy';

describe('PaymentsService', () => {
  const message = {
    id: 'proof-1',
    conversationId: 'conversation-1',
    contactId: 'contact-1',
    type: MessageType.IMAGE,
    direction: MessageDirection.INBOUND,
    sender: MessageSender.CONTACT,
    rawPayload: { image: { id: 'media-1', mime_type: 'image/jpeg' } },
  };
  const transfer = {
    id: 'transfer-1',
    conversationId: 'conversation-1',
    contactId: 'contact-1',
    leadId: 'lead-1',
    status: TransferPaymentStatus.INSTRUCTIONS_SENT,
    amountExpected: 1200,
    currency: 'USD',
    sourceMessageId: 'request-1',
  };
  const tx = {
    $executeRaw: jest.fn(),
    transferPayment: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    transferPaymentProofMessage: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      upsert: jest.fn(),
    },
    lead: { findUnique: jest.fn(), update: jest.fn() },
    task: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    message: { findUnique: jest.fn() },
    transferPayment: { findUnique: jest.fn() },
    automatedDelivery: { findFirst: jest.fn() },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  } as unknown as PrismaService;
  const config = {
    get: jest.fn((key: string) =>
      key === 'PAYMENTS_TRANSFER_ENABLED' ? 'true' : '',
    ),
  } as unknown as ConfigService;
  const deliveries = {
    prepareBatch: jest.fn(),
    deliverPreparedBatch: jest.fn().mockResolvedValue({ confirmed: 1 }),
  } as unknown as AutomatedDeliveryService;
  const leads = { recordWonMilestone: jest.fn() } as unknown as LeadsService;
  const service = new PaymentsService(
    prisma,
    config,
    new TransferIntentPolicy(),
    deliveries,
    leads,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.message.findUnique as jest.Mock).mockResolvedValue(message);
    tx.transferPayment.findFirst.mockResolvedValue(transfer);
    tx.transferPaymentProofMessage.findUnique.mockResolvedValue(null);
    tx.task.findFirst.mockResolvedValue(null);
    tx.transferPaymentProofMessage.upsert.mockResolvedValue({
      messageId: message.id,
    });
  });

  it('asocia una imagen de la conversación y crea una sola tarea sin acceder a media', async () => {
    expect(await service.detectProof(message.id)).toBe(true);
    expect(tx.transferPaymentProofMessage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: message.id },
        create: { messageId: message.id, transferPaymentId: transfer.id },
      }),
    );
    expect(tx.task.create).toHaveBeenCalledTimes(1);
    expect(tx.lead.update).toHaveBeenCalledWith({
      where: { id: transfer.leadId },
      data: { stage: LeadStage.PAYMENT_REVIEW },
    });
    expect(deliveries.prepareBatch).toHaveBeenCalledTimes(1);
  });

  it('no duplica tarea ni auditoría al repetir el webhook', async () => {
    tx.transferPaymentProofMessage.findUnique.mockResolvedValue({
      messageId: message.id,
    });
    expect(await service.detectProof(message.id)).toBe(true);
    expect(tx.transferPaymentProofMessage.upsert).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('no asocia documentos que no sean PDF', async () => {
    (prisma.message.findUnique as jest.Mock).mockResolvedValue({
      ...message,
      type: MessageType.DOCUMENT,
      rawPayload: { document: { mime_type: 'application/msword' } },
    });
    expect(await service.detectProof(message.id)).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('confirma instrucciones recuperadas sin retroceder un pago ya en revisión', async () => {
    (prisma.transferPayment.findUnique as jest.Mock).mockResolvedValue({
      ...transfer,
      status: TransferPaymentStatus.PROOF_RECEIVED,
      instructionsMessageId: null,
    });
    (prisma.automatedDelivery.findFirst as jest.Mock).mockResolvedValue({
      outboundMessageId: 'outbound-1',
    });
    tx.transferPayment.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    await service.reconcileInstruction(transfer.sourceMessageId);
    expect(tx.transferPayment.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: { instructionsMessageId: 'outbound-1' },
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('rechaza aprobación con comprobante de otra conversación', async () => {
    tx.transferPayment.findUnique.mockResolvedValue({
      ...transfer,
      status: TransferPaymentStatus.PROOF_RECEIVED,
    });
    tx.transferPaymentProofMessage.findFirst.mockResolvedValue({
      message: { conversationId: 'other-conversation' },
    });
    await expect(
      service.approve(
        transfer.id,
        {
          expectedStatus: TransferPaymentStatus.PROOF_RECEIVED,
          reviewedProofMessageId: message.id,
          contractReference: 'contract-1',
        },
        'admin-1',
      ),
    ).rejects.toThrow('Comprobante ajeno');
    expect(tx.lead.update).not.toHaveBeenCalled();
  });
});
