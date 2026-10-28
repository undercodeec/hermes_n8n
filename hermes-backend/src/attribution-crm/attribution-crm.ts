import { Prisma } from '@prisma/client';
import { safeStoredIncident } from '../hermes/hermes-diagnostics';
import { PrismaService } from '../prisma/prisma.service';

export type CrmOrigin = 'meta_ad' | 'organic' | 'unknown';
export type CrmAttribution = {
  origin: CrmOrigin;
  evidence: string;
  initialAdSourceId: string | null;
  ctwaClidPresent: boolean;
  laterAdReferences: Array<{
    messageId: string;
    occurredAt: Date;
    sourceId: string | null;
    ctwaClidPresent: boolean;
  }>;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeSourceId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    ? value
    : null;
}

export function projectAttribution(metadata: unknown): CrmAttribution {
  const value = object(metadata);
  const evidence = value?.pilotOriginEvidence;
  const origin: CrmOrigin =
    value?.pilotOrigin === 'meta_ad' &&
    (evidence === 'meta_referral_ad' || evidence === 'meta_ctwa_clid')
      ? 'meta_ad'
      : value?.pilotOrigin === 'organic' && evidence === 'meta_referral_post'
        ? 'organic'
        : 'unknown';
  const ad = object(value?.pilotAd);
  return {
    origin,
    evidence: origin === 'unknown' ? 'insufficient' : String(evidence),
    initialAdSourceId: origin === 'meta_ad' ? safeSourceId(ad?.sourceId) : null,
    ctwaClidPresent: origin === 'meta_ad' && ad?.ctwaClidPresent === true,
    laterAdReferences: [],
  };
}

export function originConversationWhere(
  origin?: CrmOrigin,
): Prisma.ConversationWhereInput {
  const ad: Prisma.ConversationWhereInput = {
    metadata: { path: ['pilotOrigin'], equals: 'meta_ad' },
    AND: [
      {
        OR: [
          {
            metadata: {
              path: ['pilotOriginEvidence'],
              equals: 'meta_referral_ad',
            },
          },
          {
            metadata: {
              path: ['pilotOriginEvidence'],
              equals: 'meta_ctwa_clid',
            },
          },
        ],
      },
    ],
  };
  const organic: Prisma.ConversationWhereInput = {
    AND: [
      { metadata: { path: ['pilotOrigin'], equals: 'organic' } },
      {
        metadata: {
          path: ['pilotOriginEvidence'],
          equals: 'meta_referral_post',
        },
      },
    ],
  };
  if (origin === 'meta_ad') return ad;
  if (origin === 'organic') return organic;
  if (origin === 'unknown')
    return {
      OR: [
        { metadata: { path: ['pilotOrigin'], equals: Prisma.DbNull } },
        { metadata: { path: ['pilotOriginEvidence'], equals: Prisma.DbNull } },
        { NOT: { OR: [ad, organic] } },
      ],
    };
  return {};
}

export function projectCrmMessage<T extends object>(message: T) {
  const row = message as Record<string, unknown>;
  const metadata = object(row.metadata);
  const safeMetadata: Record<string, unknown> = {};
  if (metadata?.hermesIncident) {
    safeMetadata.hermesIncident = safeStoredIncident(metadata.hermesIncident);
  }
  const attribution =
    metadata?.pilotOrigin === 'meta_ad' ? projectAttribution(metadata) : null;
  if (attribution) {
    safeMetadata.pilotOrigin = attribution.origin;
    safeMetadata.pilotOriginEvidence = attribution.evidence;
    safeMetadata.pilotAd = {
      ...(attribution.initialAdSourceId
        ? { sourceId: attribution.initialAdSourceId }
        : {}),
      ...(attribution.ctwaClidPresent ? { ctwaClidPresent: true } : {}),
    };
  }
  return {
    id: row.id,
    conversationId: row.conversationId,
    contactId: row.contactId,
    direction: row.direction,
    sender: row.sender,
    sentByUserId: row.sentByUserId,
    sentByUser: row.sentByUser,
    type: row.type,
    content: row.content,
    wamid: row.wamid,
    createdAt: row.createdAt,
    metadata: safeMetadata,
    attribution,
  };
}

export function projectCrmContact(value: unknown) {
  const row = object(value);
  if (!row) return null;
  return {
    id: row.id,
    waId: row.waId,
    phone: row.phone,
    name: row.name,
    email: row.email,
    company: row.company,
    position: row.position,
    notes: row.notes,
    marketingConsentStatus: row.marketingConsentStatus,
  };
}

export function projectCrmLead<T extends object>(
  lead: T,
  attribution?: CrmAttribution,
) {
  const row = lead as Record<string, unknown>;
  const conversation = object(row.conversation);
  const tasks = Array.isArray(row.tasks) ? row.tasks : undefined;
  const auditLogs = Array.isArray(row.auditLogs) ? row.auditLogs : undefined;
  return {
    id: row.id,
    contactId: row.contactId,
    conversationId: row.conversationId,
    stage: row.stage,
    score: row.score,
    productOfInterest: row.productOfInterest,
    estimatedBudget: row.estimatedBudget,
    serviceRequested: row.serviceRequested,
    proposalValue: row.proposalValue,
    contractedAmount: row.contractedAmount,
    revenueReceived: row.revenueReceived,
    commercialCurrency: row.commercialCurrency,
    contractReference: row.contractReference,
    nextAction: row.nextAction,
    lastObjection: row.lastObjection,
    closeProbability: row.closeProbability,
    lostReason: row.lostReason,
    wonAt: row.wonAt,
    lostAt: row.lostAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    contact: projectCrmContact(row.contact),
    attribution: attribution ?? projectAttribution(conversation?.metadata),
    ...(conversation
      ? {
          conversation: {
            id: conversation.id,
            status: conversation.status,
            channel: conversation.channel,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
            state: projectCrmState(conversation.state),
            messages: Array.isArray(conversation.messages)
              ? conversation.messages.map((message) =>
                  projectCrmMessage(message),
                )
              : undefined,
            handoffs: Array.isArray(conversation.handoffs)
              ? conversation.handoffs.map((item) => {
                  const handoff = object(item);
                  return handoff
                    ? {
                        id: handoff.id,
                        status: handoff.status,
                        reason: handoff.reason,
                        reasonDetail: handoff.reasonDetail,
                        createdAt: handoff.createdAt,
                        assignedAgent: projectCrmUser(handoff.assignedAgent),
                      }
                    : null;
                })
              : undefined,
          },
        }
      : {}),
    ...(tasks
      ? {
          tasks: tasks.map((item) => {
            const task = object(item);
            return task
              ? {
                  id: task.id,
                  type: task.type,
                  title: task.title,
                  description: task.description,
                  status: task.status,
                  dueAt: task.dueAt,
                  createdAt: task.createdAt,
                }
              : null;
          }),
        }
      : {}),
    ...(auditLogs
      ? {
          auditLogs: auditLogs.map((item) => {
            const log = object(item);
            return log
              ? {
                  id: log.id,
                  action: log.action,
                  createdAt: log.createdAt,
                  user: projectCrmUser(log.user),
                }
              : null;
          }),
        }
      : {}),
  };
}

export function projectCrmUser(value: unknown) {
  const row = object(value);
  return row
    ? { id: row.id, name: row.name, email: row.email, role: row.role }
    : null;
}

export function projectCrmState(value: unknown) {
  const row = object(value);
  return row
    ? {
        id: row.id,
        conversationId: row.conversationId,
        summary: row.summary,
        detectedIntent: row.detectedIntent,
        nextSuggestedAction: row.nextSuggestedAction,
        detectedRisks: row.detectedRisks,
        closeScore: row.closeScore,
        leadStage: row.leadStage,
        lastObjection: row.lastObjection,
        updatedAt: row.updatedAt,
      }
    : null;
}

export function projectCrmHandoff<T extends object>(handoff: T) {
  const row = handoff as Record<string, unknown>;
  const conversation = object(row.conversation);
  return {
    id: row.id,
    conversationId: row.conversationId,
    reason: row.reason,
    reasonDetail: row.reasonDetail,
    status: row.status,
    assignedAgentId: row.assignedAgentId,
    resolution: row.resolution,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    assignedAgent: projectCrmUser(row.assignedAgent),
    ...(conversation
      ? {
          conversation: {
            id: conversation.id,
            status: conversation.status,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
            contact: projectCrmContact(conversation.contact),
            state: projectCrmState(conversation.state),
            lead: conversation.lead ? projectCrmLead(conversation.lead) : null,
            messages: Array.isArray(conversation.messages)
              ? conversation.messages.map((message) =>
                  projectCrmMessage(message),
                )
              : undefined,
          },
        }
      : {}),
  };
}

export function projectCrmConversationRecord<T extends object>(
  conversation: T,
) {
  const row = conversation as Record<string, unknown>;
  return {
    id: row.id,
    contactId: row.contactId,
    status: row.status,
    channel: row.channel,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    contact: projectCrmContact(row.contact),
    attribution: projectAttribution(row.metadata),
  };
}

export async function readAttributions(
  prisma: PrismaService,
  conversations: Array<{ id: string; metadata: unknown }>,
): Promise<Map<string, CrmAttribution>> {
  const result = new Map(
    conversations.map((conversation) => [
      conversation.id,
      projectAttribution(conversation.metadata),
    ]),
  );
  if (!conversations.length) return result;
  const ids = conversations.map((conversation) => conversation.id);
  const references = await prisma.$queryRaw<
    Array<{
      id: string;
      conversationId: string;
      createdAt: Date;
      sourceId: string | null;
      ctwaClidPresent: boolean;
    }>
  >(Prisma.sql`
    SELECT id, "conversationId", "createdAt",
           NULLIF(metadata #>> '{pilotAd,sourceId}', '') AS "sourceId",
           COALESCE((metadata #>> '{pilotAd,ctwaClidPresent}')::boolean, false) AS "ctwaClidPresent"
    FROM (
      SELECT id, "conversationId", "createdAt", metadata,
             ROW_NUMBER() OVER (PARTITION BY "conversationId" ORDER BY "createdAt", id) AS message_number
      FROM messages
      WHERE "conversationId" IN (${Prisma.join(ids)}) AND direction = 'INBOUND'
    ) inbound
    WHERE message_number > 1 AND metadata->>'pilotOrigin' = 'meta_ad'
    ORDER BY "createdAt", id
  `);
  for (const reference of references) {
    const attribution = result.get(reference.conversationId);
    if (!attribution) continue;
    attribution.laterAdReferences.push({
      messageId: reference.id,
      occurredAt: reference.createdAt,
      sourceId: safeSourceId(reference.sourceId),
      ctwaClidPresent: reference.ctwaClidPresent === true,
    });
  }
  return result;
}
