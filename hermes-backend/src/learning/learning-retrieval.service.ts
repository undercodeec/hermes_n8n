import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LearningItemStatus, LearningRiskLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { effectiveEvidence } from './learning-evidence-support';
import { validateCandidateSafety } from './review-candidate-safety';

export type ApprovedLearning = {
  id: string;
  version: number;
  kind: string;
  trigger: string;
  guidance: string;
  serviceCode?: string;
  market?: string;
};

type Candidate = ApprovedLearning & {
  hasEffectiveEvidence: boolean;
  status: LearningItemStatus;
  riskLevel: LearningRiskLevel;
  validUntil: Date | null;
  createdAt: Date;
};

export type LearningSelectionContext = {
  customerMessage: string;
  serviceCode?: string;
  market?: string;
  approvedKnowledge: string[];
  now: Date;
};

/** The existing Nous context allocates 40% to approved commercial knowledge. */
export function learningContentBudget(
  maximumContextCharacters: number,
  approvedKnowledge: string[],
): number {
  const commercial = approvedKnowledge
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20)
    .join('\n');
  return Math.max(
    0,
    Math.floor(maximumContextCharacters * 0.4) - commercial.length,
  );
}

export function learningItemSafe(
  item: Pick<
    Candidate,
    'kind' | 'trigger' | 'guidance' | 'serviceCode' | 'market'
  >,
): boolean {
  try {
    validateCandidateSafety(item);
  } catch {
    return false;
  }
  const text = `${item.trigger} ${item.guidance}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  // Defense in depth for context leakage and instructions that must never become policy.
  if (
    /\b(?:ignora|omite|desobedece|sobrescribe|reemplaza|ignore|override|disregard)\b.{0,65}\b(?:reglas|instrucciones|sistema|politica|prompt|anteriores|rules|instructions|system|previous)\b|\b(?:system|developer)\s*:/i.test(
      text,
    )
  )
    return false;
  if (
    /\b(?:se llama|mi nombre es|empresa|compania|negocio de|presupuesto|equipo de|usuarios exactos|prefiere|preferencia de|instrucciones del cliente)\b/i.test(
      text,
    )
  )
    return false;
  if (
    /\b(?:modificar|cambiar|anular|omitir|saltarse|evitar)\b.{0,55}\b(?:handoff|derivacion|transferencia humana|price\s*list|product|politica comercial)\b/i.test(
      text,
    )
  )
    return false;
  if (
    /\b(?:reservar|agendar|confirmar reunion|prometer disponibilidad|garantizar disponibilidad|crear devolucion|politica de devolucion)\b/i.test(
      text,
    )
  )
    return false;
  // Commercial claims are checked by the shared F2 validator above. Unknown
  // affirmative commercial instructions are excluded rather than reconciled.
  if (
    /\b(?:precio|tarifa|moneda|descuento|pago|cobro|plazo|entrega|disponibilidad|devolucion|garantia|reserva|reunion)\b/.test(
      text,
    ) &&
    !/\b(?:consultar|verificar|validar|confirmar con|remitir|escalar|no inventar|no prometer|no afirmar|no ofrecer|no aplicar|evitar prometer|usar el catalogo vigente)\b/.test(
      text,
    )
  )
    return false;
  return true;
}

function words(text: string): Set<string> {
  return new Set(text.toLocaleLowerCase('es').match(/[\p{L}]{4,}/gu) || []);
}

/** Pure, total-order selector shared by shadow and live retrieval. */
export function selectApprovedLearning(
  candidates: Candidate[],
  context: LearningSelectionContext,
  maximumContextCharacters: number,
): ApprovedLearning[] {
  const messageWords = words(context.customerMessage);
  const ranked = candidates
    .flatMap((item) => {
      if (
        item.status !== LearningItemStatus.ACTIVE ||
        !item.hasEffectiveEvidence ||
        item.riskLevel === LearningRiskLevel.HIGH ||
        !item.validUntil ||
        item.validUntil <= context.now ||
        (item.serviceCode && item.serviceCode !== context.serviceCode) ||
        (item.market && item.market !== context.market) ||
        !learningItemSafe(item)
      )
        return [];
      const score = [...words(item.trigger)].filter((word) =>
        messageWords.has(word),
      ).length;
      if (!score) return [];
      return [
        {
          item,
          score,
          specificity:
            Number(Boolean(item.serviceCode)) + Number(Boolean(item.market)),
        },
      ];
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.specificity - a.specificity ||
        b.item.createdAt.getTime() - a.item.createdAt.getTime() ||
        b.item.version - a.item.version ||
        a.item.id.localeCompare(b.item.id),
    );
  const selected: ApprovedLearning[] = [];
  const budget = learningContentBudget(
    maximumContextCharacters,
    context.approvedKnowledge,
  );
  for (const { item } of ranked) {
    const safe: ApprovedLearning = {
      id: item.id,
      version: item.version,
      kind: item.kind,
      trigger: item.trigger,
      guidance: item.guidance,
      ...(item.serviceCode ? { serviceCode: item.serviceCode } : {}),
      ...(item.market ? { market: item.market } : {}),
    };
    if (JSON.stringify([...selected, safe]).length > budget) continue;
    selected.push(safe);
    if (selected.length === 3) break;
  }
  return selected;
}

@Injectable()
export class LearningRetrievalService {
  private readonly logger = new Logger(LearningRetrievalService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async select(
    context: Omit<LearningSelectionContext, 'now'>,
  ): Promise<ApprovedLearning[]> {
    const started = Date.now();
    let phase: 'DB_ERROR' | 'SELECTOR_ERROR' = 'DB_ERROR';
    try {
      const now = new Date();
      const candidates = await this.prisma.learningItem.findMany({
        where: {
          status: LearningItemStatus.ACTIVE,
          riskLevel: { not: LearningRiskLevel.HIGH },
          validUntil: { gt: now },
          evidence: { some: effectiveEvidence },
          AND: [
            {
              OR: [
                { serviceCode: null },
                ...(context.serviceCode
                  ? [{ serviceCode: context.serviceCode }]
                  : []),
              ],
            },
            {
              OR: [
                { market: null },
                ...(context.market ? [{ market: context.market }] : []),
              ],
            },
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: 100,
        select: {
          id: true,
          version: true,
          kind: true,
          trigger: true,
          guidance: true,
          serviceCode: true,
          market: true,
          status: true,
          riskLevel: true,
          validUntil: true,
          createdAt: true,
          evidence: { where: effectiveEvidence, select: { id: true }, take: 1 },
        },
      });
      const configured = Number(
        this.config.get<string>('NOUS_HERMES_CONTEXT_MAX_CHARS', '12000'),
      );
      phase = 'SELECTOR_ERROR';
      const maxChars =
        Number.isSafeInteger(configured) && configured > 0 ? configured : 12000;
      const selected = selectApprovedLearning(
        candidates.map((item) => ({
          ...item,
          hasEffectiveEvidence: item.evidence.length > 0,
          serviceCode: item.serviceCode ?? undefined,
          market: item.market ?? undefined,
        })),
        { ...context, now },
        maxChars,
      );
      this.logger.log(
        JSON.stringify({
          event: 'learning_retrieval',
          consideredCount: candidates.length,
          selectedCount: selected.length,
          elapsedMs: Date.now() - started,
        }),
      );
      return selected;
    } catch {
      this.logger.warn(
        JSON.stringify({
          event: 'learning_retrieval',
          fallbackReason: phase,
          elapsedMs: Date.now() - started,
        }),
      );
      return [];
    }
  }
}
