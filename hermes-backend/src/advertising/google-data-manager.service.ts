import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import axios, { AxiosError } from 'axios';
import { GoogleAuth } from 'google-auth-library';
import {
  AdvertisingConsentChoice,
  AdvertisingSyncStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface IngestResponse {
  requestId: string;
  fieldWarnings?: unknown[];
}

interface DiagnosticItem {
  requestStatus?: string;
  errorInfo?: unknown;
  warningInfo?: unknown;
}

interface DiagnosticResponse {
  requestStatusPerDestination?: DiagnosticItem[];
}

export class GoogleSyncError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    readonly code?: string,
  ) {
    super(message);
  }
}

@Injectable()
export class GoogleDataManagerService {
  private readonly auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/datamanager'],
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async ingest(
    syncJobId: string,
  ): Promise<{ requestId: string; validateOnly: boolean }> {
    const job = await this.prisma.advertisingSyncJob.findUnique({
      where: { id: syncJobId },
      include: {
        conversion: {
          include: { touch: true, contact: true },
        },
      },
    });
    if (!job)
      throw new GoogleSyncError('Sync job not found', false, 'NOT_FOUND');
    if (job.status === AdvertisingSyncStatus.CANCELLED) {
      throw new GoogleSyncError('Sync job was cancelled', false, 'CANCELLED');
    }
    const mapping = await this.prisma.advertisingConversionMapping.findUnique({
      where: { eventType: job.conversion.eventType },
      include: { integration: true },
    });
    const touch = job.conversion.touch;
    if (!mapping?.exportEnabled || !touch || !mapping.integration.accountId) {
      await this.notEligible(
        job.id,
        'Missing enabled mapping, account or attribution',
      );
      throw new GoogleSyncError(
        'Conversion is not eligible',
        false,
        'NOT_ELIGIBLE',
      );
    }
    if (touch.adUserData !== AdvertisingConsentChoice.GRANTED) {
      await this.notEligible(job.id, 'ad_user_data consent is not granted');
      throw new GoogleSyncError(
        'Consent is not granted',
        false,
        'DENIED_CONSENT',
      );
    }

    const event: Record<string, unknown> = {
      eventTimestamp: job.conversion.occurredAt.toISOString(),
      transactionId: job.conversion.idempotencyKey,
      eventSource: 'WEB',
    };
    const adIdentifiers = this.adIdentifiers(touch);
    if (Object.keys(adIdentifiers).length) event.adIdentifiers = adIdentifiers;
    if (job.conversion.value !== null) {
      event.conversionValue = Number(job.conversion.value);
      event.currency = job.conversion.currency;
    }
    const userData = this.userData(
      job.conversion.contact,
      touch.adUserData === AdvertisingConsentChoice.GRANTED,
    );
    if (userData) event.userData = userData;
    if (!event.adIdentifiers && !event.userData) {
      await this.notEligible(job.id, 'No supported Google matching identifier');
      throw new GoogleSyncError(
        'No supported identifier',
        false,
        'NO_IDENTIFIER',
      );
    }

    const validateOnly = job.validateOnly;
    const body: Record<string, unknown> = {
      destinations: [
        {
          operatingAccount: {
            accountType: 'GOOGLE_ADS',
            accountId: mapping.integration.accountId,
          },
          loginAccount: {
            accountType: 'GOOGLE_ADS',
            accountId:
              mapping.integration.loginAccountId ||
              mapping.integration.accountId,
          },
          productDestinationId: mapping.conversionActionId,
        },
      ],
      events: [event],
      consent: {
        adUserData: 'CONSENT_GRANTED',
        adPersonalization:
          touch.adPersonalization === AdvertisingConsentChoice.GRANTED
            ? 'CONSENT_GRANTED'
            : touch.adPersonalization === AdvertisingConsentChoice.DENIED
              ? 'CONSENT_DENIED'
              : 'CONSENT_STATUS_UNSPECIFIED',
      },
      validateOnly,
    };
    if (userData) body.encoding = 'HEX';

    try {
      const token = await this.accessToken();
      const response = await axios.post<IngestResponse>(
        'https://datamanager.googleapis.com/v1/events:ingest',
        body,
        {
          timeout: Number(this.config.get('GOOGLE_API_TIMEOUT_MS') || 10000),
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      await this.prisma.advertisingSyncJob.update({
        where: { id: job.id },
        data: {
          status: validateOnly
            ? AdvertisingSyncStatus.VALIDATED
            : AdvertisingSyncStatus.SUBMITTED,
          attempts: { increment: 1 },
          googleRequestId: response.data.requestId,
          warnings: response.data.fieldWarnings
            ? (response.data.fieldWarnings as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          submittedAt: new Date(),
          errorCode: null,
          errorMessage: null,
        },
      });
      return { requestId: response.data.requestId, validateOnly };
    } catch (error) {
      throw await this.handleError(job.id, error);
    }
  }

  async diagnose(syncJobId: string): Promise<AdvertisingSyncStatus> {
    const job = await this.prisma.advertisingSyncJob.findUnique({
      where: { id: syncJobId },
    });
    if (!job?.googleRequestId || job.validateOnly)
      return job?.status || AdvertisingSyncStatus.FAILED;
    try {
      const token = await this.accessToken();
      const response = await axios.get<DiagnosticResponse>(
        'https://datamanager.googleapis.com/v1/requestStatus:retrieve',
        {
          timeout: Number(this.config.get('GOOGLE_API_TIMEOUT_MS') || 10000),
          headers: { Authorization: `Bearer ${token}` },
          params: { requestId: job.googleRequestId },
        },
      );
      const items = response.data.requestStatusPerDestination || [];
      const statuses = items.map((item) => item.requestStatus);
      const status = statuses.includes('FAILED')
        ? AdvertisingSyncStatus.FAILED
        : statuses.includes('PARTIAL_SUCCESS')
          ? AdvertisingSyncStatus.PARTIAL
          : statuses.length > 0 && statuses.every((item) => item === 'SUCCESS')
            ? AdvertisingSyncStatus.ACCEPTED
            : AdvertisingSyncStatus.SUBMITTED;
      await this.prisma.advertisingSyncJob.update({
        where: { id: job.id },
        data: {
          status,
          diagnosedAt: new Date(),
          warnings: items as unknown as Prisma.InputJsonValue,
        },
      });
      return status;
    } catch (error) {
      throw await this.handleError(job.id, error);
    }
  }

  private adIdentifiers(touch: {
    gclid: string | null;
    gbraid: string | null;
    wbraid: string | null;
  }): Record<string, string> {
    return {
      ...(touch.gclid ? { gclid: touch.gclid } : {}),
      ...(touch.gbraid ? { gbraid: touch.gbraid } : {}),
      ...(touch.wbraid ? { wbraid: touch.wbraid } : {}),
    };
  }

  private userData(
    contact: { email: string | null; phone: string | null } | null,
    consentGranted: boolean,
  ): { userIdentifiers: Array<Record<string, string>> } | undefined {
    if (
      !contact ||
      !consentGranted ||
      this.config.get<string>('ADVERTISING_GOOGLE_INCLUDE_USER_DATA') !== 'true'
    ) {
      return undefined;
    }
    const identifiers: Array<Record<string, string>> = [];
    const email = contact.email
      ? this.normalizeEmail(contact.email)
      : undefined;
    if (email) identifiers.push({ emailAddress: this.sha256(email) });
    const phone = contact.phone?.trim();
    if (phone && /^\+[1-9]\d{7,14}$/.test(phone)) {
      identifiers.push({ phoneNumber: this.sha256(phone) });
    }
    return identifiers.length ? { userIdentifiers: identifiers } : undefined;
  }

  private normalizeEmail(value: string): string | undefined {
    const email = value.trim().toLowerCase().replace(/\s+/g, '');
    const parts = email.split('@');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
    if (parts[1] === 'gmail.com' || parts[1] === 'googlemail.com') {
      parts[0] = parts[0].split('+')[0].replace(/\./g, '');
    }
    return `${parts[0]}@${parts[1]}`;
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex').toUpperCase();
  }

  private async accessToken(): Promise<string> {
    const client = await this.auth.getClient();
    const result = await client.getAccessToken();
    if (!result.token)
      throw new GoogleSyncError('No Google access token', false, 'AUTH');
    return result.token;
  }

  private async notEligible(id: string, reason: string): Promise<void> {
    await this.prisma.advertisingSyncJob.update({
      where: { id },
      data: {
        status: AdvertisingSyncStatus.NOT_ELIGIBLE,
        errorCode: 'NOT_ELIGIBLE',
        errorMessage: reason.slice(0, 500),
      },
    });
  }

  private async handleError(
    id: string,
    error: unknown,
  ): Promise<GoogleSyncError> {
    const axiosError = error instanceof AxiosError ? error : undefined;
    const status = axiosError?.response?.status;
    const transient = status === 429 || (status !== undefined && status >= 500);
    const code = status ? `HTTP_${status}` : 'GOOGLE_REQUEST_FAILED';
    const message =
      axiosError?.message || (error instanceof Error ? error.message : code);
    await this.prisma.advertisingSyncJob.update({
      where: { id },
      data: {
        status: transient
          ? AdvertisingSyncStatus.RETRYING
          : AdvertisingSyncStatus.FAILED,
        attempts: { increment: 1 },
        errorCode: code,
        errorMessage: message.slice(0, 500),
        nextAttemptAt: transient ? new Date(Date.now() + 60_000) : null,
      },
    });
    return new GoogleSyncError(message, transient, code);
  }
}
