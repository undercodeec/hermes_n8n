import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHmac, randomBytes } from 'crypto';
import {
  AdvertisingAttributionStatus,
  AdvertisingConsentChoice,
  AdvertisingEventType,
  AdvertisingProvider,
  AdvertisingSyncStatus,
  LeadStage,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateContactIntentDto,
  RecordCommercialEventDto,
  UpsertConversionMappingDto,
  UpdateAdvertisingIntegrationDto,
} from './dto/advertising.dto';
import {
  ADVERTISING_QUEUE,
  ADVERTISING_REFERENCE_PATTERN,
  AdvertisingSyncJobData,
} from './advertising.constants';

const OPERATOR_EVENTS = new Set<AdvertisingEventType>([
  AdvertisingEventType.MEETING_CONFIRMED,
  AdvertisingEventType.PROPOSAL_SENT,
  AdvertisingEventType.CONTRACT_WON,
  AdvertisingEventType.CONTRACT_LOST,
]);

@Injectable()
export class AdvertisingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectQueue(ADVERTISING_QUEUE)
    private readonly queue: Queue<AdvertisingSyncJobData>,
  ) {}

  async createContactIntent(dto: CreateContactIntentDto) {
    const reference = this.generateReference();
    const ttlMinutes = Math.min(
      43_200,
      Math.max(
        5,
        Number(
          this.config.get('AD_ATTRIBUTION_REFERENCE_TTL_MINUTES') || 10080,
        ),
      ),
    );
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
    const touch = await this.prisma.advertisingTouch.create({
      data: {
        referenceHash: this.hashReference(reference),
        referenceLast4: reference.slice(-4),
        expiresAt,
        gclid: dto.gclid,
        gbraid: dto.gbraid,
        wbraid: dto.wbraid,
        utmSource: dto.utmSource,
        utmMedium: dto.utmMedium,
        utmCampaign: dto.utmCampaign,
        utmContent: dto.utmContent,
        utmTerm: dto.utmTerm,
        landingPage: this.cleanLandingPage(dto.landingPage),
        visitedAt: dto.visitedAt ? new Date(dto.visitedAt) : new Date(),
        adStorage: dto.consent.adStorage,
        analyticsStorage: dto.consent.analyticsStorage,
        adUserData: dto.consent.adUserData,
        adPersonalization: dto.consent.adPersonalization,
        consentSource: dto.consent.source,
        consentRecordedAt: new Date(dto.consent.recordedAt),
      },
    });

    await this.prisma.advertisingConversion.create({
      data: {
        idempotencyKey: `whatsapp-click:${touch.id}`,
        eventType: AdvertisingEventType.WHATSAPP_CLICK,
        touchId: touch.id,
        occurredAt: new Date(),
        source: 'UNDERCODE_CONTACT_INTENT',
        verified: false,
      },
    });

    return {
      reference,
      expiresAt,
      messageSuffix: `Referencia: ${reference}`,
    };
  }

  extractReference(message?: string | null): string | undefined {
    if (!message) return undefined;
    return message.match(ADVERTISING_REFERENCE_PATTERN)?.[0];
  }

  async claimReference(params: {
    messageContent?: string | null;
    contactId: string;
    conversationId: string;
    inboundMessageId: string;
  }): Promise<{
    status: 'confirmed' | 'missing' | 'invalid' | 'expired' | 'used';
  }> {
    const reference = this.extractReference(params.messageContent);
    if (!reference) return { status: 'missing' };
    const referenceHash = this.hashReference(reference);

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${referenceHash}))`;
      const alreadyProcessed = await tx.advertisingAttribution.findUnique({
        where: { inboundMessageId: params.inboundMessageId },
      });
      if (alreadyProcessed) return { status: 'confirmed' as const };

      const touch = await tx.advertisingTouch.findUnique({
        where: { referenceHash },
      });
      if (!touch) return { status: 'invalid' as const };
      if (touch.expiresAt.getTime() <= Date.now()) {
        return { status: 'expired' as const };
      }
      if (touch.useCount >= touch.maxUses) return { status: 'used' as const };

      const lead = await tx.lead.findUnique({
        where: { conversationId: params.conversationId },
        select: { id: true },
      });
      const attributedAt = new Date();
      const attribution = await tx.advertisingAttribution.create({
        data: {
          touchId: touch.id,
          contactId: params.contactId,
          leadId: lead?.id,
          conversationId: params.conversationId,
          inboundMessageId: params.inboundMessageId,
          status: AdvertisingAttributionStatus.CONFIRMED,
          attributedAt,
        },
      });
      await tx.advertisingTouch.update({
        where: { id: touch.id },
        data: { useCount: { increment: 1 }, consumedAt: attributedAt },
      });

      if (lead) {
        const existing = await tx.advertisingConversion.findUnique({
          where: {
            leadId_eventType: {
              leadId: lead.id,
              eventType: AdvertisingEventType.CONVERSATION_STARTED,
            },
          },
        });
        if (!existing) {
          await tx.advertisingConversion.create({
            data: {
              idempotencyKey: `conversation-started:${lead.id}`,
              eventType: AdvertisingEventType.CONVERSATION_STARTED,
              attributionId: attribution.id,
              touchId: touch.id,
              contactId: params.contactId,
              leadId: lead.id,
              occurredAt: attributedAt,
              source: 'WHATSAPP_WEBHOOK',
              verified: true,
            },
          });
        }
      }
      return { status: 'confirmed' as const };
    });
  }

  async recordOperatorEvent(
    leadId: string,
    dto: RecordCommercialEventDto,
    userId: string,
  ) {
    if (!OPERATOR_EVENTS.has(dto.eventType)) {
      throw new BadRequestException(
        'This event is produced by the attribution or qualification flow',
      );
    }
    if (
      dto.eventType === AdvertisingEventType.CONTRACT_WON &&
      (!dto.commercialReference || dto.value === undefined || !dto.currency)
    ) {
      throw new BadRequestException(
        'CONTRACT_WON requires value, currency and a commercial reference',
      );
    }
    return this.recordLeadEvent({
      leadId,
      eventType: dto.eventType,
      occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
      value: dto.value,
      revenueReceived: dto.revenueReceived,
      currency: dto.currency,
      commercialReference: dto.commercialReference,
      serviceRequested: dto.serviceRequested,
      source: 'CRM_OPERATOR',
      verified: true,
      verifiedByUserId: userId,
    });
  }

  async recordQualifiedLead(leadId: string, occurredAt = new Date()) {
    return this.recordLeadEvent({
      leadId,
      eventType: AdvertisingEventType.LEAD_QUALIFIED,
      occurredAt,
      source: 'CRM_QUALIFICATION_RULES',
      verified: true,
    });
  }

  private async recordLeadEvent(params: {
    leadId: string;
    eventType: AdvertisingEventType;
    occurredAt: Date;
    source: string;
    verified: boolean;
    verifiedByUserId?: string;
    value?: number;
    revenueReceived?: number;
    currency?: string;
    commercialReference?: string;
    serviceRequested?: string;
  }) {
    const conversion = await this.prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findUnique({
        where: { id: params.leadId },
        select: { id: true, contactId: true },
      });
      if (!lead) throw new NotFoundException('Lead not found');

      const attribution = await tx.advertisingAttribution.findFirst({
        where: {
          leadId: params.leadId,
          status: AdvertisingAttributionStatus.CONFIRMED,
        },
        orderBy: { attributedAt: 'asc' },
        select: { id: true, touchId: true },
      });
      const existing = await tx.advertisingConversion.findUnique({
        where: {
          leadId_eventType: {
            leadId: params.leadId,
            eventType: params.eventType,
          },
        },
      });
      const data = {
        occurredAt: params.occurredAt,
        source: params.source,
        verified: params.verified,
        verifiedByUserId: params.verifiedByUserId,
        value:
          params.value === undefined
            ? undefined
            : new Prisma.Decimal(params.value),
        currency: params.currency,
        commercialReference: params.commercialReference,
      };
      const saved = existing
        ? await tx.advertisingConversion.update({
            where: { id: existing.id },
            data,
          })
        : await tx.advertisingConversion.create({
            data: {
              ...data,
              idempotencyKey: `lead:${params.leadId}:${params.eventType}`,
              eventType: params.eventType,
              attributionId: attribution?.id,
              touchId: attribution?.touchId,
              contactId: lead.contactId,
              leadId: params.leadId,
            },
          });

      const leadUpdate: Prisma.LeadUpdateInput = {};
      if (params.serviceRequested)
        leadUpdate.serviceRequested = params.serviceRequested;
      if (
        params.eventType === AdvertisingEventType.PROPOSAL_SENT &&
        params.value !== undefined
      ) {
        leadUpdate.proposalValue = new Prisma.Decimal(params.value);
      }
      if (params.eventType === AdvertisingEventType.CONTRACT_WON) {
        leadUpdate.contractedAmount = new Prisma.Decimal(params.value!);
        if (params.revenueReceived !== undefined) {
          leadUpdate.revenueReceived = new Prisma.Decimal(
            params.revenueReceived,
          );
        }
        leadUpdate.commercialCurrency = params.currency;
        leadUpdate.contractReference = params.commercialReference;
        leadUpdate.commercialOwnerId = params.verifiedByUserId;
        leadUpdate.stage = LeadStage.WON;
        leadUpdate.wonAt = params.occurredAt;
      }
      if (params.eventType === AdvertisingEventType.CONTRACT_LOST) {
        leadUpdate.stage = LeadStage.LOST;
        leadUpdate.lostAt = params.occurredAt;
        if (params.commercialReference) {
          leadUpdate.lostReason = params.commercialReference;
        }
      }
      if (Object.keys(leadUpdate).length) {
        await tx.lead.update({
          where: { id: params.leadId },
          data: leadUpdate,
        });
      }
      await tx.auditLog.create({
        data: {
          userId: params.verifiedByUserId,
          action: existing
            ? 'ADVERTISING_EVENT_CORRECTED'
            : 'ADVERTISING_EVENT_RECORDED',
          entity: 'advertising_conversions',
          entityId: saved.id,
          changes: {
            eventType: params.eventType,
            occurredAt: params.occurredAt.toISOString(),
            verified: params.verified,
          },
        },
      });
      return saved;
    });

    await this.prepareSync(conversion.id);
    return conversion;
  }

  async upsertMapping(dto: UpsertConversionMappingDto) {
    const integration = await this.ensureIntegration();
    return this.prisma.advertisingConversionMapping.upsert({
      where: { eventType: dto.eventType },
      create: { ...dto, integrationId: integration.id },
      update: {
        conversionActionId: dto.conversionActionId,
        exportEnabled: dto.exportEnabled,
        isPrimary: dto.isPrimary,
      },
    });
  }

  async updateIntegration(dto: UpdateAdvertisingIntegrationDto) {
    return this.prisma.advertisingIntegration.upsert({
      where: { provider: AdvertisingProvider.GOOGLE_ADS },
      create: {
        provider: AdvertisingProvider.GOOGLE_ADS,
        ...dto,
      },
      update: dto,
    });
  }

  async listMappings() {
    return this.prisma.advertisingConversionMapping.findMany({
      orderBy: { eventType: 'asc' },
    });
  }

  async prepareSync(conversionId: string) {
    const conversion = await this.prisma.advertisingConversion.findUnique({
      where: { id: conversionId },
      include: { touch: true },
    });
    if (!conversion?.leadId || !conversion.touch || !conversion.verified)
      return;
    const mapping = await this.prisma.advertisingConversionMapping.findUnique({
      where: { eventType: conversion.eventType },
      include: { integration: true },
    });
    if (!mapping?.exportEnabled || !mapping.integration.conversionSyncEnabled)
      return;
    if (conversion.touch.adUserData !== AdvertisingConsentChoice.GRANTED)
      return;

    const enabled =
      this.config.get<string>('ADVERTISING_GOOGLE_SYNC_ENABLED') === 'true';
    const syncJob = await this.prisma.advertisingSyncJob.upsert({
      where: { conversionId },
      create: {
        conversionId,
        status: enabled
          ? AdvertisingSyncStatus.QUEUED
          : AdvertisingSyncStatus.PENDING,
        validateOnly:
          this.config.get<string>('ADVERTISING_GOOGLE_SEND_ENABLED') !== 'true',
      },
      update: {},
    });
    if (enabled) {
      await this.queue.add(
        'conversion',
        { syncJobId: syncJob.id },
        { jobId: syncJob.id },
      );
    }
  }

  async revokeContact(contactId: string, reason: string, userId: string) {
    const attributions = await this.prisma.advertisingAttribution.findMany({
      where: { contactId },
      select: { id: true, touchId: true },
    });
    const touchIds = [...new Set(attributions.map((item) => item.touchId))];
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.advertisingAttribution.updateMany({
        where: { contactId },
        data: {
          status: AdvertisingAttributionStatus.REVOKED,
          revokedAt: now,
          revocationReason: reason,
        },
      }),
      this.prisma.advertisingTouch.updateMany({
        where: { id: { in: touchIds } },
        data: {
          adUserData: AdvertisingConsentChoice.DENIED,
          adPersonalization: AdvertisingConsentChoice.DENIED,
          consentRecordedAt: now,
          consentSource: 'CRM_REVOCATION',
        },
      }),
      this.prisma.advertisingSyncJob.updateMany({
        where: { conversion: { contactId } },
        data: { status: AdvertisingSyncStatus.CANCELLED },
      }),
      this.prisma.auditLog.create({
        data: {
          userId,
          action: 'ADVERTISING_CONSENT_REVOKED',
          entity: 'contacts',
          entityId: contactId,
          changes: { reason },
        },
      }),
    ]);
    return { revoked: attributions.length, cancelledExports: true };
  }

  async getLeadHistory(leadId: string) {
    return this.prisma.advertisingConversion.findMany({
      where: { leadId },
      orderBy: { occurredAt: 'asc' },
      include: {
        attribution: { include: { touch: true } },
        syncJob: true,
      },
    });
  }

  async getDashboard(from?: Date, to?: Date) {
    const occurredAt = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    };
    const metricDate = occurredAt;
    const [conversions, metrics, integration] = await Promise.all([
      this.prisma.advertisingConversion.findMany({
        where: {
          occurredAt,
          OR: [{ touchId: { not: null } }, { attributionId: { not: null } }],
        },
        select: { eventType: true, value: true, currency: true },
      }),
      this.prisma.advertisingDailyMetric.findMany({
        where: { metricDate },
      }),
      this.prisma.advertisingIntegration.findUnique({
        where: { provider: AdvertisingProvider.GOOGLE_ADS },
      }),
    ]);
    const count = (type: AdvertisingEventType) =>
      conversions.filter((item) => item.eventType === type).length;
    const costMicros = metrics.reduce((sum, item) => sum + item.costMicros, 0n);
    const spend = metrics.length ? Number(costMicros) / 1_000_000 : null;
    const conversations = count(AdvertisingEventType.CONVERSATION_STARTED);
    const qualified = count(AdvertisingEventType.LEAD_QUALIFIED);
    const contracts = count(AdvertisingEventType.CONTRACT_WON);
    const contractedRevenue = conversions
      .filter((item) => item.eventType === AdvertisingEventType.CONTRACT_WON)
      .reduce((sum, item) => sum + Number(item.value || 0), 0);
    const ratio = (denominator: number) =>
      spend === null || denominator === 0 ? null : spend / denominator;
    return {
      connectionStatus:
        integration?.metricsSyncEnabled && metrics.length
          ? 'CONNECTED'
          : 'PENDING_CONNECTION',
      verified: {
        conversations,
        qualifiedLeads: qualified,
        meetings: count(AdvertisingEventType.MEETING_CONFIRMED),
        proposals: count(AdvertisingEventType.PROPOSAL_SENT),
        wonContracts: contracts,
        contractedRevenue,
      },
      advertising: metrics.length
        ? {
            spend,
            currency: metrics[0].currency,
            impressions: metrics.reduce(
              (sum, item) => sum + Number(item.impressions),
              0,
            ),
            clicks: metrics.reduce((sum, item) => sum + Number(item.clicks), 0),
          }
        : null,
      calculated: {
        costPerConversation: ratio(conversations),
        costPerQualifiedLead: ratio(qualified),
        costPerContract: ratio(contracts),
        contractedRevenueOnSpend:
          spend && spend > 0 ? contractedRevenue / spend : null,
        estimatedMargin: null,
      },
    };
  }

  async getIntegrationStatus() {
    const integration = await this.ensureIntegration();
    const [mappings, syncCounts] = await Promise.all([
      this.listMappings(),
      this.prisma.advertisingSyncJob.groupBy({
        by: ['status'],
        _count: { id: true },
      }),
    ]);
    return {
      ...integration,
      credentialsConfigured: Boolean(
        this.config.get('GOOGLE_APPLICATION_CREDENTIALS') ||
        this.config.get('GOOGLE_CLOUD_PROJECT'),
      ),
      realSendsEnabled:
        this.config.get<string>('ADVERTISING_GOOGLE_SEND_ENABLED') === 'true',
      mappings,
      syncCounts,
    };
  }

  async ensureIntegration() {
    return this.prisma.advertisingIntegration.upsert({
      where: { provider: AdvertisingProvider.GOOGLE_ADS },
      create: {
        provider: AdvertisingProvider.GOOGLE_ADS,
        accountId: this.config.get('GOOGLE_ADS_CUSTOMER_ID'),
        loginAccountId: this.config.get('GOOGLE_ADS_LOGIN_CUSTOMER_ID'),
        accountCurrency: this.config.get('GOOGLE_ADS_CURRENCY'),
        accountTimeZone: this.config.get('GOOGLE_ADS_TIME_ZONE'),
      },
      update: {},
    });
  }

  private generateReference(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bytes = randomBytes(14);
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of bytes) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5 && output.length < 22) {
        output += alphabet[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    return `UC-${output}`;
  }

  private cleanLandingPage(value?: string): string | undefined {
    if (!value) return undefined;
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  private hashReference(reference: string): string {
    const pepper = this.config.get<string>(
      'AD_ATTRIBUTION_REFERENCE_PEPPER',
      '',
    );
    if (pepper.length < 32) {
      throw new Error(
        'AD_ATTRIBUTION_REFERENCE_PEPPER must be at least 32 characters',
      );
    }
    return createHmac('sha256', pepper).update(reference).digest('hex');
  }
}
