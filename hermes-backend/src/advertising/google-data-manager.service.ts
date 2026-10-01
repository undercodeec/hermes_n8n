import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import axios, { AxiosError } from 'axios';
import { GoogleAuth } from 'google-auth-library';
import {
  AdvertisingConsentChoice,
  AdvertisingEventType,
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
  ): Promise<{ requestId: string | null; validateOnly: boolean }> {
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
    if (
      job.status !== AdvertisingSyncStatus.QUEUED &&
      job.status !== AdvertisingSyncStatus.RETRYING
    ) {
      throw new GoogleSyncError(
        'Sync job is not dispatchable',
        false,
        'TERMINAL_JOB',
      );
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
    if (
      job.conversion.eventType === AdvertisingEventType.CONTRACT_WON &&
      (job.conversion.value === null ||
        !Number.isFinite(Number(job.conversion.value)) ||
        Number(job.conversion.value) <= 0 ||
        !job.conversion.currency ||
        !/^[A-Z]{3}$/.test(job.conversion.currency) ||
        !job.conversion.commercialReference?.trim())
    ) {
      await this.notEligible(job.id, 'Invalid CONTRACT_WON commercial value');
      throw new GoogleSyncError(
        'CONTRACT_WON requires valid commercial value, currency and reference',
        false,
        'INVALID_COMMERCIAL_VALUE',
      );
    }

    const event: Record<string, unknown> = {
      eventTimestamp: job.conversion.occurredAt.toISOString(),
      transactionId: job.conversion.idempotencyKey,
      eventSource: 'WEB',
    };
    const adIdentifiers = this.adIdentifiers(touch);
    if (Object.keys(adIdentifiers).length) event.adIdentifiers = adIdentifiers;
    if (
      job.conversion.eventType !== AdvertisingEventType.LEAD_QUALIFIED &&
      job.conversion.value !== null
    ) {
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
    const destinationSnapshot = job.destinationSnapshot as {
      operatingAccountId?: string;
      loginAccountId?: string;
      conversionActionId?: string;
    } | null;
    const body: Record<string, unknown> = {
      destinations: [
        {
          operatingAccount: {
            accountType: 'GOOGLE_ADS',
            accountId:
              destinationSnapshot?.operatingAccountId ||
              mapping.integration.accountId,
          },
          loginAccount: {
            accountType: 'GOOGLE_ADS',
            accountId:
              destinationSnapshot?.loginAccountId ||
              mapping.integration.loginAccountId ||
              mapping.integration.accountId,
          },
          productDestinationId:
            destinationSnapshot?.conversionActionId ||
            mapping.conversionActionId,
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

    let response: { data: IngestResponse };
    try {
      await this.assertRuntimeAllowed(job.id, validateOnly);
      const token = await this.accessToken();
      await this.assertRuntimeAllowed(job.id, validateOnly);
      response = await axios.post<IngestResponse>(
        'https://datamanager.googleapis.com/v1/events:ingest',
        body,
        {
          timeout: Number(this.config.get('GOOGLE_API_TIMEOUT_MS') || 10000),
          headers: { Authorization: `Bearer ${token}` },
        },
      );
    } catch (error) {
      if (error instanceof GoogleSyncError && error.code === 'RUNTIME_STOP') {
        throw error;
      }
      throw await this.handleError(job.id, error);
    }

    const requestId =
      typeof response.data?.requestId === 'string' &&
      response.data.requestId.trim()
        ? response.data.requestId.trim()
        : null;
    if (!validateOnly && !requestId) {
      await this.prisma.advertisingSyncJob.update({
        where: { id: job.id },
        data: {
          status: AdvertisingSyncStatus.FAILED,
          errorCode: 'MISSING_REQUEST_ID',
          errorMessage: 'Google returned HTTP success without a request ID',
        },
      });
      throw new GoogleSyncError(
        'Google returned HTTP success without a request ID',
        false,
        'MISSING_REQUEST_ID',
      );
    }
    await this.prisma.advertisingSyncJob.update({
      where: { id: job.id },
      data: {
        status: validateOnly
          ? AdvertisingSyncStatus.VALIDATED
          : AdvertisingSyncStatus.SUBMITTED,
        attempts: { increment: 1 },
        googleRequestId: requestId,
        warnings: response.data.fieldWarnings
          ? (response.data.fieldWarnings as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        submittedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
    });
    return { requestId, validateOnly };
  }

  private async assertRuntimeAllowed(
    syncJobId: string,
    validateOnly: boolean,
  ): Promise<void> {
    const current = await this.prisma.advertisingSyncJob.findUnique({
      where: { id: syncJobId },
      include: { conversion: { include: { touch: true } } },
    });
    const mapping = current
      ? await this.prisma.advertisingConversionMapping.findUnique({
          where: { eventType: current.conversion.eventType },
          include: { integration: true },
        })
      : null;
    if (
      !current ||
      (current.status !== AdvertisingSyncStatus.QUEUED &&
        current.status !== AdvertisingSyncStatus.RETRYING) ||
      !mapping?.exportEnabled ||
      !mapping.integration.conversionSyncEnabled ||
      !mapping.integration.accountId ||
      current.conversion.touch?.adUserData !==
        AdvertisingConsentChoice.GRANTED ||
      this.config.get<string>('ADVERTISING_GOOGLE_SYNC_ENABLED') !== 'true' ||
      (!validateOnly &&
        this.config.get<string>('ADVERTISING_GOOGLE_SEND_ENABLED') !== 'true')
    ) {
      throw new GoogleSyncError(
        'Google sync stopped by current settings or consent',
        false,
        'RUNTIME_STOP',
      );
    }
  }

  async diagnose(syncJobId: string): Promise<AdvertisingSyncStatus> {
    const job = await this.prisma.advertisingSyncJob.findUnique({
      where: { id: syncJobId },
    });
    if (
      !job?.googleRequestId ||
      job.validateOnly ||
      job.status !== AdvertisingSyncStatus.SUBMITTED
    )
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
      const failure = this.classifyGoogleError(error);
      await this.prisma.advertisingSyncJob.update({
        where: { id: job.id },
        data: {
          errorCode: failure.code,
          errorMessage: failure.message.slice(0, 500),
        },
      });
      throw failure;
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
    contact: {
      email: string | null;
      phone: string | null;
      waId: string;
    } | null,
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
    const phone = this.normalizePhone(contact.phone, contact.waId);
    if (phone) {
      identifiers.push({ phoneNumber: this.sha256(phone) });
    }
    return identifiers.length ? { userIdentifiers: identifiers } : undefined;
  }

  private normalizePhone(
    phone: string | null,
    waId: string,
  ): string | undefined {
    const value = phone?.trim();
    if (!value) return undefined;
    if (/^\+[1-9]\d{7,14}$/.test(value)) return value;
    if (value === waId && /^[1-9]\d{7,14}$/.test(waId)) return `+${waId}`;
    return undefined;
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
    const failure = this.classifyGoogleError(error);
    await this.prisma.advertisingSyncJob.update({
      where: { id },
      data: {
        status: failure.transient
          ? AdvertisingSyncStatus.RETRYING
          : AdvertisingSyncStatus.FAILED,
        attempts: { increment: 1 },
        errorCode: failure.code,
        errorMessage: failure.message.slice(0, 500),
        nextAttemptAt: failure.transient ? new Date(Date.now() + 60_000) : null,
      },
    });
    return failure;
  }

  private classifyGoogleError(error: unknown): GoogleSyncError {
    if (error instanceof GoogleSyncError) return error;
    const axiosError = error instanceof AxiosError ? error : undefined;
    const status = axiosError?.response?.status;
    const networkCode = axiosError?.code;
    const transient =
      status === 429 ||
      (status !== undefined && status >= 500) ||
      (status === undefined &&
        [
          'ECONNRESET',
          'ETIMEDOUT',
          'ECONNABORTED',
          'EAI_AGAIN',
          'ENETUNREACH',
        ].includes(networkCode || ''));
    const code = status
      ? `HTTP_${status}`
      : networkCode || 'GOOGLE_REQUEST_FAILED';
    const message =
      axiosError?.message || (error instanceof Error ? error.message : code);
    return new GoogleSyncError(message, transient, code);
  }
}
