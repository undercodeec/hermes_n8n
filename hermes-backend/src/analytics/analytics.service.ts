import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MessageDirection, ConversationStatus } from '@prisma/client';

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Distribución del funnel de leads por etapa
   */
  async getFunnelDistribution() {
    const stages = await this.prisma.lead.groupBy({
      by: ['stage'],
      _count: { id: true },
    });
    return stages.map((s) => ({ stage: s.stage, count: s._count.id }));
  }

  /**
   * Métricas de conversaciones
   */
  async getConversationMetrics(fromDate?: Date, toDate?: Date) {
    const dateFilter = this.buildDateFilter(fromDate, toDate);

    const [total, active, handedOff, closed] = await Promise.all([
      this.prisma.conversation.count({ where: { createdAt: dateFilter } }),
      this.prisma.conversation.count({ where: { status: ConversationStatus.ACTIVE, createdAt: dateFilter } }),
      this.prisma.conversation.count({ where: { status: ConversationStatus.HANDED_OFF, createdAt: dateFilter } }),
      this.prisma.conversation.count({ where: { status: ConversationStatus.CLOSED, createdAt: dateFilter } }),
    ]);

    const handoffRate = total > 0 ? (handedOff / total) * 100 : 0;
    const resolvedByAI = total > 0 ? ((total - handedOff) / total) * 100 : 0;

    return {
      total,
      active,
      handedOff,
      closed,
      handoffRate: Math.round(handoffRate * 100) / 100,
      resolvedByAIRate: Math.round(resolvedByAI * 100) / 100,
    };
  }

  /**
   * Tiempo medio de primera respuesta
   */
  async getAverageResponseTime(fromDate?: Date, toDate?: Date) {
    const messages = await this.prisma.message.findMany({
      where: {
        direction: MessageDirection.OUTBOUND,
        latencyMs: { not: null },
        createdAt: this.buildDateFilter(fromDate, toDate),
      },
      select: { latencyMs: true },
    });

    if (messages.length === 0) return { averageMs: 0, count: 0 };

    const totalMs = messages.reduce((sum, m) => sum + (m.latencyMs || 0), 0);
    return {
      averageMs: Math.round(totalMs / messages.length),
      count: messages.length,
    };
  }

  /**
   * Costos por conversación
   */
  async getCostMetrics(fromDate?: Date, toDate?: Date) {
    const messages = await this.prisma.message.findMany({
      where: {
        direction: MessageDirection.OUTBOUND,
        costEstimate: { not: null },
        createdAt: this.buildDateFilter(fromDate, toDate),
      },
      select: { costEstimate: true, conversationId: true },
    });

    const totalCost = messages.reduce((sum, m) => sum + (m.costEstimate || 0), 0);
    const conversationIds = new Set(messages.map((m) => m.conversationId));
    const avgCostPerConversation = conversationIds.size > 0 ? totalCost / conversationIds.size : 0;

    return {
      totalCost: Math.round(totalCost * 10000) / 10000,
      totalMessages: messages.length,
      uniqueConversations: conversationIds.size,
      avgCostPerConversation: Math.round(avgCostPerConversation * 10000) / 10000,
    };
  }

  /**
   * Rendimiento por campaña
   */
  async getCampaignPerformance() {
    const sources = await this.prisma.campaignSource.findMany({
      include: {
        _count: { select: { leads: true } },
        leads: { select: { stage: true } },
        adsMetadata: { select: { spend: true, impressions: true, clicks: true } },
      },
    });

    return sources.map((source) => {
      const totalLeads = source._count.leads;
      const wonLeads = source.leads.filter((l) => l.stage === 'WON').length;
      const totalSpend = source.adsMetadata.reduce((sum, a) => sum + (a.spend || 0), 0);
      const costPerLead = totalLeads > 0 ? totalSpend / totalLeads : 0;

      return {
        id: source.id,
        utmSource: source.utmSource,
        utmCampaign: source.utmCampaign,
        utmMedium: source.utmMedium,
        totalLeads,
        wonLeads,
        conversionRate: totalLeads > 0 ? Math.round((wonLeads / totalLeads) * 10000) / 100 : 0,
        totalSpend: Math.round(totalSpend * 100) / 100,
        costPerLead: Math.round(costPerLead * 100) / 100,
      };
    });
  }

  private buildDateFilter(fromDate?: Date, toDate?: Date) {
    if (!fromDate && !toDate) return undefined;
    const filter: any = {};
    if (fromDate) filter.gte = fromDate;
    if (toDate) filter.lte = toDate;
    return filter;
  }
}
