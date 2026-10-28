import {
  projectAttribution,
  projectCrmMessage,
  projectCrmConversationRecord,
  originConversationWhere,
  readAttributions,
} from './attribution-crm';
import { PrismaService } from '../prisma/prisma.service';

describe('CRM Meta attribution contract', () => {
  it('keeps unknown distinct from an explicitly verified organic post', () => {
    expect(projectAttribution({ pilotOrigin: 'organic' }).origin).toBe(
      'unknown',
    );
    expect(
      projectAttribution({
        pilotOrigin: 'organic',
        pilotOriginEvidence: 'meta_referral_post',
      }).origin,
    ).toBe('organic');
    expect(
      projectAttribution({
        pilotOrigin: 'meta_ad',
        pilotOriginEvidence: 'meta_referral_ad',
        pilotAd: { sourceId: 'ad-1', ctwaClidPresent: true },
      }),
    ).toEqual({
      origin: 'meta_ad',
      evidence: 'meta_referral_ad',
      initialAdSourceId: 'ad-1',
      ctwaClidPresent: true,
      laterAdReferences: [],
    });
  });

  it('does not serialize raw click IDs or private engine metadata in a CRM message', () => {
    const result = projectCrmMessage({
      id: 'm1',
      conversationId: 'c1',
      sender: 'CONTACT',
      content: 'Hola',
      rawPayload: { referral: { ctwa_clid: 'private-click-id' } },
      metadata: {
        pilotOrigin: 'meta_ad',
        pilotOriginEvidence: 'meta_referral_ad',
        pilotAd: { sourceId: 'ad-1', ctwaClidPresent: true },
        nousResult: 'secret',
      },
    });
    expect(JSON.stringify(result)).not.toContain('private-click-id');
    expect(JSON.stringify(result)).not.toContain('nousResult');
    expect(result).toMatchObject({
      id: 'm1',
      content: 'Hola',
      attribution: { origin: 'meta_ad', initialAdSourceId: 'ad-1' },
    });
  });

  it('projects conversation mutation responses without private engine metadata', () => {
    const result = projectCrmConversationRecord({
      id: 'c1',
      status: 'CLOSED',
      metadata: { pilotEngine: 'private', pilotOrigin: 'unknown' },
      contact: { id: 'ct1', password: 'secret' },
    });
    expect(JSON.stringify(result)).not.toMatch(/pilotEngine|password/);
    expect(result).toMatchObject({
      id: 'c1',
      status: 'CLOSED',
      attribution: { origin: 'unknown' },
    });
  });

  it('builds a SQL-side filter for each supported origin', () => {
    expect(originConversationWhere('meta_ad')).toBeTruthy();
    expect(originConversationWhere('organic')).toBeTruthy();
    expect(originConversationWhere('unknown')).toBeTruthy();
  });

  it('shows a later ad referral without changing the initial origin', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'later-1',
          conversationId: 'c1',
          createdAt: new Date('2026-10-28T10:00:00Z'),
          sourceId: 'ad-9',
          ctwaClidPresent: true,
        },
      ]),
    } as unknown as PrismaService;
    const result = await readAttributions(prisma, [
      {
        id: 'c1',
        metadata: {
          pilotOrigin: 'unknown',
          pilotOriginEvidence: 'insufficient',
        },
      },
    ]);
    expect(result.get('c1')).toMatchObject({
      origin: 'unknown',
      laterAdReferences: [
        { messageId: 'later-1', sourceId: 'ad-9', ctwaClidPresent: true },
      ],
    });
    expect(JSON.stringify(result.get('c1'))).not.toContain('ctwa_clid');
  });
});
