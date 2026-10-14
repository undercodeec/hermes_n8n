import { LearningItemStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { effectiveEvidence } from './learning-evidence-support';

export type LearningSource =
  | 'contact'
  | 'conversation'
  | 'message'
  | 'feedback'
  | 'review';

/** The supported source deletion boundary. Uncontrolled SQL/Prisma deletes
 * cannot write an audit entry, but read and approve guards still fail closed. */
export async function deleteLearningSource(
  prisma: PrismaService,
  source: LearningSource,
  id: string,
) {
  return prisma.$transaction(
    async (tx) => {
      const where: Prisma.LearningEvidenceWhereInput =
        source === 'contact'
          ? { conversation: { is: { contactId: id } } }
          : source === 'conversation'
            ? { conversationId: id }
            : source === 'message'
              ? {
                  OR: [
                    { messageId: id },
                    { feedback: { is: { messageId: id } } },
                    { review: { is: { sourceMessageId: id } } },
                  ],
                }
              : source === 'feedback'
                ? {
                    OR: [
                      { feedbackId: id },
                      { review: { is: { feedbackId: id } } },
                    ],
                  }
                : { reviewId: id };
      const affected = await tx.learningEvidence.findMany({
        where,
        select: { learningItemId: true },
        distinct: ['learningItemId'],
      });
      const itemIds = affected.map((entry) => entry.learningItemId).sort();
      for (const itemId of itemIds) {
        await tx.$queryRaw`SELECT 1 AS one FROM pg_advisory_xact_lock(hashtext('learning-item-evidence'), hashtext(${itemId}))`;
      }
      const deleted =
        source === 'contact'
          ? await tx.contact.delete({ where: { id } })
          : source === 'conversation'
            ? await tx.conversation.delete({ where: { id } })
            : source === 'message'
              ? await tx.message.delete({ where: { id } })
              : source === 'feedback'
                ? await tx.conversationFeedback.delete({ where: { id } })
                : await tx.conversationReview.delete({ where: { id } });
      for (const itemId of itemIds) {
        const remaining = await tx.learningEvidence.count({
          where: { learningItemId: itemId, ...effectiveEvidence },
        });
        if (remaining > 0) continue;
        const item = await tx.learningItem.findUnique({
          where: { id: itemId },
          select: { status: true },
        });
        if (
          !item ||
          (item.status !== LearningItemStatus.PROPOSED &&
            item.status !== LearningItemStatus.ACTIVE)
        )
          continue;
        const next =
          item.status === LearningItemStatus.ACTIVE
            ? LearningItemStatus.RETIRED
            : LearningItemStatus.REJECTED;
        const changed = await tx.learningItem.updateMany({
          where: { id: itemId, status: item.status },
          data: { status: next },
        });
        if (changed.count !== 1) continue;
        await tx.auditLog.create({
          data: {
            action: 'LEARNING_AUTOMATIC_EVIDENCE_LOSS',
            entity: 'learning_items',
            entityId: itemId,
            changes: {
              reason: 'automatic evidence loss',
              sourceType: source,
              before: item.status,
              after: next,
            },
          },
        });
      }
      return deleted;
    },
    { timeout: 30_000 },
  );
}
