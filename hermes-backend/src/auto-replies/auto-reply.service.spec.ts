import { ConfigService } from '@nestjs/config';
import { ConversationStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { AutoReplyService } from './auto-reply.service';
import { PrismaService } from '../prisma/prisma.service';
import { MetaService } from '../meta/meta.service';
import { HermesService } from '../hermes/hermes.service';
import { HandoffService } from '../handoff/handoff.service';
import { LeadsService } from '../leads/leads.service';
import { ConversationGuardService } from '../conversation-guard/conversation-guard.service';

describe('AutoReplyService', () => {
  it('does not answer an older message when the customer wrote again', async () => {
    const prisma = {
      message: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'inbound-1',
          conversationId: 'conversation-1',
          contactId: 'contact-1',
          content: 'Hola',
        }),
        findFirst: jest.fn().mockResolvedValue({ id: 'inbound-2' }),
      },
      conversation: {
        findUnique: jest.fn().mockResolvedValue({
          status: ConversationStatus.ACTIVE,
          contact: { name: 'Ana', waId: '593991234567' },
        }),
      },
    } as unknown as PrismaService;
    const meta = { sendTextMessage: jest.fn() } as unknown as MetaService;
    const hermes = { generateResponse: jest.fn() } as unknown as HermesService;
    const service = new AutoReplyService(
      { get: jest.fn() } as unknown as ConfigService,
      prisma,
      meta,
      hermes,
      { create: jest.fn() } as unknown as HandoffService,
      { qualifyFromConversation: jest.fn() } as unknown as LeadsService,
      { consumeAiQuota: jest.fn() } as unknown as ConversationGuardService,
      { add: jest.fn() } as unknown as Queue,
    );

    await service.process({
      conversationId: 'conversation-1',
      contactId: 'contact-1',
      inboundMessageId: 'inbound-1',
    });

    expect(hermes.generateResponse).not.toHaveBeenCalled();
    expect(meta.sendTextMessage).not.toHaveBeenCalled();
  });
});
