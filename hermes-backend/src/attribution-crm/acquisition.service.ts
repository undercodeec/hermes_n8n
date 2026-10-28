import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CrmOrigin } from './attribution-crm';

type MetricKey =
  | 'newConversations'
  | 'inboundMessages'
  | 'laterAdReferralMessages'
  | 'qualifiedLeadsVerified'
  | 'contractsWonVerified'
  | 'contractsLostVerified'
  | 'nousRequests';
const KEYS: MetricKey[] = [
  'newConversations',
  'inboundMessages',
  'laterAdReferralMessages',
  'qualifiedLeadsVerified',
  'contractsWonVerified',
  'contractsLostVerified',
  'nousRequests',
];
const ORIGINS: CrmOrigin[] = ['meta_ad', 'organic', 'unknown'];
const GUAYAQUIL_UTC_OFFSET_MS = 5 * 60 * 60 * 1000;
type Metrics = Record<MetricKey, number>;
type Row = Record<MetricKey, bigint> & {
  day: string;
  origin: CrmOrigin;
  adSourceId: string | null;
};

function emptyMetrics(): Metrics {
  return Object.fromEntries(KEYS.map((key) => [key, 0])) as Metrics;
}

function addMetrics(target: Metrics, row: Metrics | Row): void {
  for (const key of KEYS) target[key] += Number(row[key] || 0);
}

function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function todayInGuayaquil(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Guayaquil',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

@Injectable()
export class AcquisitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async summary(from?: string, to?: string) {
    const today = todayInGuayaquil();
    const end = to || today;
    if (!validDay(end))
      throw new BadRequestException('Rango de fechas inválido');
    const start =
      from ||
      new Date(Date.parse(`${end}T00:00:00.000Z`) - 29 * 86400000)
        .toISOString()
        .slice(0, 10);
    if (!validDay(start) || !validDay(end))
      throw new BadRequestException('Rango de fechas inválido');
    const startDayUtc = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T00:00:00.000Z`);
    const days =
      Math.round((endDate.getTime() - startDayUtc.getTime()) / 86400000) + 1;
    if (days < 1 || days > 366)
      throw new BadRequestException('El rango debe tener entre 1 y 366 días');
    const fromDate = new Date(startDayUtc.getTime() + GUAYAQUIL_UTC_OFFSET_MS);
    const toExclusive = new Date(
      endDate.getTime() + 86400000 + GUAYAQUIL_UTC_OFFSET_MS,
    );
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      WITH pilot AS (
        SELECT id, ("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Guayaquil')::date AS day,
          CASE WHEN metadata->>'pilotOrigin' = 'meta_ad'
                      AND metadata->>'pilotOriginEvidence' IN ('meta_referral_ad','meta_ctwa_clid') THEN 'meta_ad'
               WHEN metadata->>'pilotOrigin' = 'organic'
                      AND metadata->>'pilotOriginEvidence' = 'meta_referral_post' THEN 'organic'
               ELSE 'unknown' END AS origin,
          CASE WHEN metadata->>'pilotOrigin' = 'meta_ad'
                      AND metadata->>'pilotOriginEvidence' IN ('meta_referral_ad','meta_ctwa_clid')
               THEN NULLIF(metadata #>> '{pilotAd,sourceId}', '') ELSE NULL END AS ad_source_id
        FROM conversations WHERE channel = 'whatsapp'
          AND "createdAt" >= ${fromDate} AND "createdAt" < ${toExclusive}
      ), inbound_rows AS (
        SELECT m."conversationId", m.metadata,
          ROW_NUMBER() OVER (PARTITION BY m."conversationId" ORDER BY m."createdAt", m.id) AS message_number
        FROM messages m JOIN pilot p ON p.id = m."conversationId"
        WHERE m.direction = 'INBOUND'
      ), inbound AS (
        SELECT "conversationId", COUNT(*) AS inbound_messages,
          COUNT(*) FILTER (WHERE message_number > 1 AND metadata->>'pilotOrigin' = 'meta_ad') AS later_refs
        FROM inbound_rows GROUP BY "conversationId"
      ), verified AS (
        SELECT l."conversationId",
          COUNT(DISTINCT e."leadId") FILTER (WHERE e."eventType" = 'LEAD_QUALIFIED') AS qualified,
          COUNT(DISTINCT e."leadId") FILTER (WHERE e."eventType" = 'CONTRACT_WON') AS won,
          COUNT(DISTINCT e."leadId") FILTER (WHERE e."eventType" = 'CONTRACT_LOST') AS lost
        FROM leads l JOIN advertising_conversions e ON e."leadId" = l.id
        JOIN pilot p ON p.id = l."conversationId"
        WHERE e.verified = TRUE AND e."invalidatedAt" IS NULL
        GROUP BY l."conversationId"
      ), requests AS (
        SELECT t."conversationId", COUNT(*) AS requests
        FROM inbound_turns t JOIN pilot p ON p.id = t."conversationId"
        WHERE t."generationEngine" = 'nous_hermes_normal' AND t."providerDispatchReservedAt" IS NOT NULL
        GROUP BY t."conversationId"
      )
      SELECT to_char(p.day, 'YYYY-MM-DD') AS day, p.origin, p.ad_source_id AS "adSourceId",
        COUNT(*) AS "newConversations",
        COALESCE(SUM(i.inbound_messages), 0) AS "inboundMessages",
        COALESCE(SUM(i.later_refs), 0) AS "laterAdReferralMessages",
        COALESCE(SUM(v.qualified), 0) AS "qualifiedLeadsVerified",
        COALESCE(SUM(v.won), 0) AS "contractsWonVerified",
        COALESCE(SUM(v.lost), 0) AS "contractsLostVerified",
        COALESCE(SUM(r.requests), 0) AS "nousRequests"
      FROM pilot p
      LEFT JOIN inbound i ON i."conversationId" = p.id
      LEFT JOIN verified v ON v."conversationId" = p.id
      LEFT JOIN requests r ON r."conversationId" = p.id
      GROUP BY p.day, p.origin, p.ad_source_id
      ORDER BY p.day, p.origin, p.ad_source_id
    `);
    const totals = emptyMetrics();
    const byOrigin = new Map(ORIGINS.map((origin) => [origin, emptyMetrics()]));
    const byAd = new Map<string, Metrics>();
    const daily = new Map<
      string,
      {
        date: string;
        meta_ad: number;
        organic: number;
        unknown: number;
        total: number;
      }
    >();
    for (let index = 0; index < days; index++) {
      const date = new Date(startDayUtc.getTime() + index * 86400000)
        .toISOString()
        .slice(0, 10);
      daily.set(date, { date, meta_ad: 0, organic: 0, unknown: 0, total: 0 });
    }
    for (const row of rows) {
      const origin = ORIGINS.includes(row.origin) ? row.origin : 'unknown';
      addMetrics(totals, row);
      addMetrics(byOrigin.get(origin)!, row);
      const point = daily.get(row.day);
      if (point) {
        point[origin] += Number(row.newConversations);
        point.total += Number(row.newConversations);
      }
      if (origin === 'meta_ad' && row.adSourceId) {
        if (!byAd.has(row.adSourceId)) byAd.set(row.adSourceId, emptyMetrics());
        addMetrics(byAd.get(row.adSourceId)!, row);
      }
    }
    const estimate = Number(
      this.config.get<string>('NOUS_PILOT_ESTIMATED_USD_PER_REQUEST'),
    );
    const estimatedUsd =
      Number.isFinite(estimate) &&
      estimate >= 0 &&
      this.config.get<string>('NOUS_PILOT_ESTIMATED_USD_PER_REQUEST') !==
        undefined
        ? Number((totals.nousRequests * estimate).toFixed(6))
        : null;
    return {
      range: { from: start, to: end },
      totals: { ...totals, estimatedUsd, billedUsd: null },
      byOrigin: ORIGINS.map((origin) => ({ origin, ...byOrigin.get(origin)! })),
      daily: [...daily.values()],
      byAd: [...byAd]
        .map(([sourceId, metrics]) => ({ sourceId, ...metrics }))
        .sort((left, right) => right.newConversations - left.newConversations),
      sources: {
        origin: 'Hermes WhatsApp referral',
        commercial: 'Hermes verified events',
        adsSpend: null,
      },
    };
  }
}
