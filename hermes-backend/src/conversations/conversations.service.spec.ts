/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { MessageSender } from '@prisma/client';
import { MetaService } from '../meta/meta.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationsService } from './conversations.service';

describe('ConversationsService', () => {
  const tx = {
    message: { create: jest.fn() },
    conversation: { update: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    conversation: { findUnique: jest.fn() },
    message: { findFirst: jest.fn() },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  } as unknown as PrismaService;
  const meta = { sendTextMessage: jest.fn() } as unknown as MetaService;
  const service = new ConversationsService(prisma, meta);

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.conversation.findUnique as unknown as jest.Mock).mockResolvedValue({
      id: 'conversation-1',
      contactId: 'contact-1',
      contact: { waId: '593999999999' },
    });
  });

  it('rechaza texto libre fuera de la ventana de 24 horas', async () => {
    (prisma.message.findFirst as unknown as jest.Mock).mockResolvedValue({
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    await expect(
      service.reply('conversation-1', { content: 'Hola' }, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(meta.sendTextMessage).not.toHaveBeenCalled();
  });

  it('registra un mensaje humano y su auditoría dentro de la ventana', async () => {
    (prisma.message.findFirst as unknown as jest.Mock).mockResolvedValue({
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    (meta.sendTextMessage as jest.Mock).mockResolvedValue({
      messages: [{ id: 'wamid-1' }],
    });
    tx.message.create.mockResolvedValue({ id: 'message-1' });

    await service.reply(
      'conversation-1',
      { content: 'Te ayudo con tu cotización' },
      'user-1',
    );

    expect(tx.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sender: MessageSender.HUMAN,
          sentByUserId: 'user-1',
          wamid: 'wamid-1',
        }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'HUMAN_MESSAGE_SENT' }),
      }),
    );
  });

  it('no registra como enviado un mensaje que Meta no confirmó', async () => {
    (prisma.message.findFirst as unknown as jest.Mock).mockResolvedValue({
      createdAt: new Date(),
    });
    (meta.sendTextMessage as jest.Mock).mockResolvedValue(null);

    await expect(
      service.reply('conversation-1', { content: 'Hola' }, 'user-1'),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(tx.message.create).not.toHaveBeenCalled();
  });
});
