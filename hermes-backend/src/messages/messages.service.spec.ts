import { PrismaService } from '../prisma/prisma.service';
import { MessagesService } from './messages.service';

describe('MessagesService CRM response', () => {
  it('never returns raw Meta payloads from the alternate message endpoint', async () => {
    const prisma = {
      message: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'm1',
            content: 'Hola',
            rawPayload: { referral: { ctwa_clid: 'secret-click' } },
            metadata: { nousResult: 'secret' },
          },
        ]),
        count: jest.fn().mockResolvedValue(1),
        findUnique: jest.fn().mockResolvedValue({
          id: 'm1',
          rawPayload: { referral: { ctwa_clid: 'secret-click' } },
        }),
      },
    } as unknown as PrismaService;
    const service = new MessagesService(prisma);
    const list = await service.findByConversation('c1');
    const detail = await service.findOne('m1');
    expect(JSON.stringify([list, detail])).not.toContain('secret-click');
    expect(JSON.stringify(list)).not.toContain('nousResult');
  });
});
