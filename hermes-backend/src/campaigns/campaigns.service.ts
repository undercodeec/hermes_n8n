import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CampaignRecipientStatus,
  CampaignStatus,
  MarketingConsentStatus,
  Prisma,
} from '@prisma/client';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { MetaService } from '../meta/meta.service';
import { CreateCampaignSourceDto } from './dto/create-campaign-source.dto';
import { CreateAdsMetadataDto } from './dto/create-ads-metadata.dto';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { CampaignContactImportRowDto } from './dto/import-campaign-contacts.dto';
import {
  CAMPAIGN_IMPORT_MAX_ROWS,
  CAMPAIGN_QUEUE,
} from './campaigns.constants';
import { normalizeConsent, normalizeE164Phone } from './phone-normalizer';

export interface CampaignJobData {
  campaignId: string;
  recipientId: string;
}
type Operator = { id: string };

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly meta: MetaService,
    @InjectQueue(CAMPAIGN_QUEUE) private readonly queue: Queue<CampaignJobData>,
  ) {}

  async createSource(dto: CreateCampaignSourceDto) {
    return this.prisma.campaignSource.create({ data: dto });
  }
  async findAllSources(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.campaignSource.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { leads: true } } },
      }),
      this.prisma.campaignSource.count(),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }
  async findOneSource(id: string) {
    const source = await this.prisma.campaignSource.findUnique({
      where: { id },
      include: { leads: true, adsMetadata: true },
    });
    if (!source) throw new NotFoundException('Fuente de campaña no encontrada');
    return source;
  }
  async createAdsMetadata(dto: CreateAdsMetadataDto) {
    return this.prisma.adsMetadata.create({
      data: dto,
      include: { campaignSource: true },
    });
  }
  async findAllAdsMetadata(campaignSourceId?: string) {
    return this.prisma.adsMetadata.findMany({
      where: campaignSourceId ? { campaignSourceId } : {},
      orderBy: { createdAt: 'desc' },
      include: { campaignSource: true },
    });
  }

  async getTemplates() {
    return this.meta.getApprovedMessageTemplates();
  }

  async createCampaign(dto: CreateCampaignDto, operator: Operator) {
    this.assertSafeHeader(dto.headerVideoMediaId, dto.headerVideoUrl);
    const campaign = await this.prisma.campaign.create({
      data: { ...dto, createdByUserId: operator.id },
    });
    await this.audit(operator.id, 'CAMPAIGN_CREATED', campaign.id, {
      name: campaign.name,
    });
    return campaign;
  }

  async findAll(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.campaign.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { recipients: true } } },
      }),
      this.prisma.campaign.count(),
    ]);
    return {
      data: await Promise.all(
        data.map((campaign) => this.withMetrics(campaign)),
      ),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string) {
    const campaign = await this.prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException('Campaña no encontrada');
    return this.withMetrics(campaign);
  }

  async findRecipients(id: string, page = 1, limit = 20) {
    await this.requireCampaign(id);
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.campaignRecipient.findMany({
        where: { campaignId: id },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { contact: { select: { name: true } } },
      }),
      this.prisma.campaignRecipient.count({ where: { campaignId: id } }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /** The browser previews CSV, but this is the authoritative validation/import. */
  async importContacts(
    id: string,
    rows: CampaignContactImportRowDto[],
    operator: Operator,
  ) {
    if (rows.length > CAMPAIGN_IMPORT_MAX_ROWS)
      throw new BadRequestException('El lote excede el límite permitido');
    const campaign = await this.requireCampaign(id);
    const editableStates: CampaignStatus[] = [
      CampaignStatus.DRAFT,
      CampaignStatus.READY,
      CampaignStatus.PAUSED,
    ];
    if (!editableStates.includes(campaign.status))
      throw new BadRequestException(
        'La campaña no admite nuevos destinatarios en su estado actual',
      );
    const seen = new Set<string>();
    const summary = {
      total: rows.length,
      valid: 0,
      invalid: 0,
      duplicates: 0,
      withoutConsent: 0,
      eligible: 0,
      imported: 0,
    };
    for (const row of rows) {
      const phone = normalizeE164Phone(row.telefono);
      if (!phone) {
        summary.invalid++;
        continue;
      }
      if (seen.has(phone)) {
        summary.duplicates++;
        continue;
      }
      seen.add(phone);
      summary.valid++;
      if (normalizeConsent(row.consentimiento) !== 'OPTED_IN') {
        summary.withoutConsent++;
        continue;
      }
      const existing = await this.prisma.contact.findUnique({
        where: { waId: phone },
      });
      const contact = existing
        ? await this.prisma.contact.update({
            where: { id: existing.id },
            data: {
              name: row.nombre.trim(),
              phone,
              ...(existing.marketingConsentStatus ===
              MarketingConsentStatus.OPTED_OUT
                ? {}
                : {
                    marketingConsentStatus: MarketingConsentStatus.OPTED_IN,
                    marketingConsentAt: new Date(),
                    marketingConsentSource: 'csv_import',
                  }),
            },
          })
        : await this.prisma.contact.create({
            data: {
              waId: phone,
              phone,
              name: row.nombre.trim(),
              marketingConsentStatus: MarketingConsentStatus.OPTED_IN,
              marketingConsentAt: new Date(),
              marketingConsentSource: 'csv_import',
            },
          });
      // An explicit prior opt-out wins over a CSV row. Importing never creates a lead.
      if (contact.marketingConsentStatus !== MarketingConsentStatus.OPTED_IN) {
        summary.withoutConsent++;
        continue;
      }
      await this.prisma.campaignRecipient.upsert({
        where: {
          campaignId_contactId: { campaignId: id, contactId: contact.id },
        },
        update: {},
        create: {
          campaignId: id,
          contactId: contact.id,
          phone,
          status: CampaignRecipientStatus.PENDING,
        },
      });
      summary.eligible++;
      summary.imported++;
    }
    const totalRecipients = await this.prisma.campaignRecipient.count({
      where: { campaignId: id },
    });
    await this.prisma.campaign.update({
      where: { id },
      data: { totalRecipients, status: CampaignStatus.READY },
    });
    await this.audit(operator.id, 'CAMPAIGN_CONTACTS_IMPORTED', id, {
      imported: summary.imported,
    });
    return summary;
  }

  async start(id: string, operator: Operator) {
    this.assertCampaignsEnabled();
    const campaign = await this.requireCampaign(id);
    const startableStates: CampaignStatus[] = [
      CampaignStatus.DRAFT,
      CampaignStatus.READY,
      CampaignStatus.PAUSED,
    ];
    if (!startableStates.includes(campaign.status))
      throw new BadRequestException(
        'La campaña no se puede iniciar en su estado actual',
      );
    const recipients = await this.prisma.campaignRecipient.findMany({
      where: {
        campaignId: id,
        status: {
          in: [CampaignRecipientStatus.PENDING, CampaignRecipientStatus.QUEUED],
        },
      },
      include: { contact: { select: { marketingConsentStatus: true } } },
    });
    if (!recipients.length)
      throw new BadRequestException(
        'La campaña no tiene destinatarios pendientes',
      );
    await this.prisma.$transaction(async (tx) => {
      await tx.campaign.update({
        where: { id },
        data: {
          status: CampaignStatus.RUNNING,
          startedAt: campaign.startedAt || new Date(),
          pausedAt: null,
        },
      });
      for (const recipient of recipients)
        await tx.campaignRecipient.update({
          where: { id: recipient.id },
          data: {
            status:
              recipient.contact.marketingConsentStatus ===
              MarketingConsentStatus.OPTED_IN
                ? CampaignRecipientStatus.QUEUED
                : CampaignRecipientStatus.SKIPPED,
          },
        });
    });
    const eligible = recipients.filter(
      (recipient) =>
        recipient.contact.marketingConsentStatus ===
        MarketingConsentStatus.OPTED_IN,
    );
    await Promise.all(
      eligible.map((recipient) =>
        this.queue.add(
          'send-template',
          { campaignId: id, recipientId: recipient.id },
          { jobId: `campaign:${id}:${recipient.id}:${Date.now()}` },
        ),
      ),
    );
    await this.audit(operator.id, 'CAMPAIGN_STARTED', id, {
      queued: eligible.length,
    });
    return { queued: eligible.length };
  }

  async pause(id: string, operator: Operator) {
    await this.requireState(id, CampaignStatus.RUNNING);
    const campaign = await this.prisma.campaign.update({
      where: { id },
      data: { status: CampaignStatus.PAUSED, pausedAt: new Date() },
    });
    await this.audit(operator.id, 'CAMPAIGN_PAUSED', id);
    return campaign;
  }
  async resume(id: string, operator: Operator) {
    return this.start(id, operator);
  }
  async cancel(id: string, operator: Operator) {
    const campaign = await this.requireCampaign(id);
    const finalStates: CampaignStatus[] = [
      CampaignStatus.COMPLETED,
      CampaignStatus.CANCELLED,
    ];
    if (finalStates.includes(campaign.status))
      throw new BadRequestException('La campaña ya finalizó');
    const result = await this.prisma.campaign.update({
      where: { id },
      data: { status: CampaignStatus.CANCELLED, completedAt: new Date() },
    });
    await this.audit(operator.id, 'CAMPAIGN_CANCELLED', id);
    return result;
  }

  async processSendJob(data: CampaignJobData) {
    const recipient = await this.prisma.campaignRecipient.findUnique({
      where: { id: data.recipientId },
      include: { campaign: true, contact: true },
    });
    if (
      !recipient ||
      recipient.campaignId !== data.campaignId ||
      recipient.wamid ||
      recipient.status !== CampaignRecipientStatus.QUEUED ||
      recipient.campaign.status !== CampaignStatus.RUNNING
    )
      return;
    if (
      recipient.contact.marketingConsentStatus !==
      MarketingConsentStatus.OPTED_IN
    ) {
      await this.prisma.campaignRecipient.update({
        where: { id: recipient.id },
        data: { status: CampaignRecipientStatus.SKIPPED },
      });
      return;
    }
    // Claim atomically before the external side effect. Two jobs, or a resumed
    // campaign, cannot both reach Meta for the same recipient.
    const claim = await this.prisma.campaignRecipient.updateMany({
      where: {
        id: recipient.id,
        status: CampaignRecipientStatus.QUEUED,
        wamid: null,
        sendAttemptedAt: null,
      },
      data: { sendAttemptedAt: new Date() },
    });
    if (claim.count !== 1) return;
    try {
      const result = await this.meta.sendTemplateMessage(
        recipient.phone,
        recipient.campaign.templateName,
        recipient.campaign.templateLanguage,
        {
          headerVideoMediaId:
            recipient.campaign.headerVideoMediaId || undefined,
          headerVideoUrl: recipient.campaign.headerVideoUrl || undefined,
        },
      );
      const wamid = result.messages?.[0]?.id;
      if (!wamid)
        throw new Error('Meta no devolvió un identificador de mensaje');
      await this.prisma.campaignRecipient.update({
        where: { id: recipient.id },
        data: {
          status: CampaignRecipientStatus.SENT,
          wamid,
          sentAt: new Date(),
          errorCode: null,
          errorMessage: null,
        },
      });
      await this.completeIfFinished(data.campaignId);
    } catch (error) {
      const metaError = this.meta.toSafeError(error);
      // 429 explicitly means Meta rejected the request, so releasing the claim
      // and letting BullMQ retry is safe. A timeout or 5xx is ambiguous: Meta
      // could have accepted it, therefore it is never resent automatically.
      if (metaError.status === 429) {
        await this.prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: { sendAttemptedAt: null },
        });
        throw error;
      }
      await this.prisma.campaignRecipient.update({
        where: { id: recipient.id },
        data: {
          status: CampaignRecipientStatus.FAILED,
          failedAt: new Date(),
          errorCode: metaError.code,
          errorMessage: metaError.retryable
            ? 'Entrega no confirmada; no se reintentó para evitar un envío duplicado.'
            : metaError.message,
        },
      });
      await this.completeIfFinished(data.campaignId);
    }
  }

  async markRecipientStatus(
    wamid: string,
    status: string,
    timestamp?: string,
    error?: { code?: number; message?: string },
  ) {
    const recipient = await this.prisma.campaignRecipient.findUnique({
      where: { wamid },
    });
    if (!recipient) return;
    const eventAt =
      timestamp && /^\d+$/.test(timestamp)
        ? new Date(Number(timestamp) * 1000)
        : new Date();
    const rank: Record<string, number> = {
      QUEUED: 0,
      PENDING: 0,
      SENT: 1,
      DELIVERED: 2,
      READ: 3,
      REPLIED: 4,
      FAILED: 4,
      SKIPPED: 4,
    };
    const target: Record<string, CampaignRecipientStatus | undefined> = {
      sent: CampaignRecipientStatus.SENT,
      delivered: CampaignRecipientStatus.DELIVERED,
      read: CampaignRecipientStatus.READ,
      failed: CampaignRecipientStatus.FAILED,
    };
    const next = target[status];
    const terminalStatuses: CampaignRecipientStatus[] = [
      CampaignRecipientStatus.REPLIED,
      CampaignRecipientStatus.FAILED,
      CampaignRecipientStatus.SKIPPED,
    ];
    if (
      !next ||
      terminalStatuses.includes(recipient.status) ||
      rank[next] < rank[recipient.status] ||
      (recipient.metaTimestamp && eventAt < recipient.metaTimestamp)
    )
      return;
    const update: Record<string, unknown> = {
      status: next,
      metaTimestamp: eventAt,
    };
    if (next === CampaignRecipientStatus.SENT) update.sentAt = eventAt;
    if (next === CampaignRecipientStatus.DELIVERED)
      update.deliveredAt = eventAt;
    if (next === CampaignRecipientStatus.READ) update.readAt = eventAt;
    if (next === CampaignRecipientStatus.FAILED) {
      update.failedAt = eventAt;
      update.errorCode = error?.code ? String(error.code) : null;
      update.errorMessage = this.sanitizeError(error?.message);
    }
    await this.prisma.campaignRecipient.update({
      where: { id: recipient.id },
      data: update,
    });
    await this.completeIfFinished(recipient.campaignId);
  }

  async markRetryExhausted(data: CampaignJobData, error: unknown) {
    const safe = this.meta.toSafeError(error);
    const result = await this.prisma.campaignRecipient.updateMany({
      where: {
        id: data.recipientId,
        campaignId: data.campaignId,
        status: CampaignRecipientStatus.QUEUED,
        wamid: null,
      },
      data: {
        status: CampaignRecipientStatus.FAILED,
        failedAt: new Date(),
        errorCode: safe.code,
        errorMessage:
          'Meta rechazó repetidamente la solicitud por límite de tasa.',
      },
    });
    if (result.count) await this.completeIfFinished(data.campaignId);
  }

  async markReplied(contactId: string) {
    const recipient = await this.prisma.campaignRecipient.findFirst({
      where: {
        contactId,
        status: {
          in: [
            CampaignRecipientStatus.SENT,
            CampaignRecipientStatus.DELIVERED,
            CampaignRecipientStatus.READ,
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!recipient) return;
    await this.prisma.campaignRecipient.update({
      where: { id: recipient.id },
      data: { status: CampaignRecipientStatus.REPLIED, repliedAt: new Date() },
    });
    await this.completeIfFinished(recipient.campaignId);
  }

  /**
   * Contacts who have received a campaign are intentionally handled by a human
   * once they write back. This keeps the campaign flow separate from Hermes'
   * automated conversational flow.
   */
  async findHumanManagedRecipient(
    contactId: string,
  ): Promise<{ campaignId: string } | null> {
    return this.prisma.campaignRecipient.findFirst({
      where: {
        contactId,
        status: {
          in: [
            CampaignRecipientStatus.SENT,
            CampaignRecipientStatus.DELIVERED,
            CampaignRecipientStatus.READ,
            CampaignRecipientStatus.REPLIED,
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { campaignId: true },
    });
  }
  async optOut(contactId: string) {
    await this.prisma.contact.update({
      where: { id: contactId },
      data: {
        marketingConsentStatus: MarketingConsentStatus.OPTED_OUT,
        marketingOptOutAt: new Date(),
        marketingConsentSource: 'whatsapp_quick_reply',
      },
    });
  }
  async getPerformance() {
    return Promise.all(
      (
        await this.prisma.campaign.findMany({ orderBy: { createdAt: 'desc' } })
      ).map((campaign) => this.withMetrics(campaign)),
    );
  }

  private async withMetrics<T extends { id: string }>(campaign: T) {
    const rows = await this.prisma.campaignRecipient.groupBy({
      by: ['status'],
      where: { campaignId: campaign.id },
      _count: { id: true },
    });
    const counts = Object.fromEntries(
      rows.map((row) => [row.status.toLowerCase(), row._count.id]),
    );
    const optOuts = await this.prisma.campaignRecipient.count({
      where: {
        campaignId: campaign.id,
        contact: { marketingConsentStatus: MarketingConsentStatus.OPTED_OUT },
      },
    });
    return {
      ...campaign,
      metrics: {
        total: Object.values(counts).reduce(
          (sum, count) => sum + Number(count),
          0,
        ),
        pending: 0,
        queued: 0,
        sent: 0,
        delivered: 0,
        read: 0,
        replied: 0,
        failed: 0,
        skipped: 0,
        optOuts,
        ...counts,
      },
    };
  }
  private async completeIfFinished(campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
    });
    if (!campaign || campaign.status !== CampaignStatus.RUNNING) return;
    const open = await this.prisma.campaignRecipient.count({
      where: {
        campaignId,
        status: {
          in: [CampaignRecipientStatus.PENDING, CampaignRecipientStatus.QUEUED],
        },
      },
    });
    if (!open)
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: { status: CampaignStatus.COMPLETED, completedAt: new Date() },
      });
  }
  private async requireCampaign(id: string) {
    const campaign = await this.prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException('Campaña no encontrada');
    return campaign;
  }
  private async requireState(id: string, state: CampaignStatus) {
    const campaign = await this.requireCampaign(id);
    if (campaign.status !== state)
      throw new BadRequestException(
        'La campaña no está en el estado requerido',
      );
    return campaign;
  }
  private assertCampaignsEnabled() {
    if (
      this.config.get<string>('CAMPAIGNS_ENABLED', 'false').toLowerCase() !==
      'true'
    )
      throw new ForbiddenException(
        'Las campañas están deshabilitadas en este entorno',
      );
  }
  private assertSafeHeader(mediaId?: string, url?: string) {
    if (mediaId && url)
      throw new BadRequestException('Use media ID o URL, no ambos');
    if (url && !this.meta.isSafeMediaUrl(url))
      throw new BadRequestException('La URL del video no está permitida');
  }
  private sanitizeError(value?: string) {
    return value ? value.replace(/[\r\n]/g, ' ').slice(0, 500) : null;
  }
  private async audit(
    userId: string,
    action: string,
    entityId: string,
    changes?: Record<string, unknown>,
  ) {
    await this.prisma.auditLog.create({
      data: {
        userId,
        action,
        entity: 'campaigns',
        entityId,
        changes: changes as Prisma.InputJsonValue | undefined,
      },
    });
  }
}
