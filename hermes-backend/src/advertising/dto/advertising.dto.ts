import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { AdvertisingConsentChoice, AdvertisingEventType } from '@prisma/client';

const CLICK_ID = /^[^\s]{1,2048}$/;
const CURRENCY = /^[A-Z]{3}$/;

export class AdvertisingConsentDto {
  @IsEnum(AdvertisingConsentChoice)
  adStorage!: AdvertisingConsentChoice;

  @IsEnum(AdvertisingConsentChoice)
  analyticsStorage!: AdvertisingConsentChoice;

  @IsEnum(AdvertisingConsentChoice)
  adUserData!: AdvertisingConsentChoice;

  @IsEnum(AdvertisingConsentChoice)
  adPersonalization!: AdvertisingConsentChoice;

  @IsString()
  @MaxLength(100)
  source!: string;

  @IsDateString()
  recordedAt!: string;
}

export class CreateContactIntentDto {
  @IsOptional()
  @Matches(CLICK_ID)
  gclid?: string;

  @IsOptional()
  @Matches(CLICK_ID)
  gbraid?: string;

  @IsOptional()
  @Matches(CLICK_ID)
  wbraid?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  utmSource?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  utmMedium?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  utmCampaign?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  utmContent?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  utmTerm?: string;

  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  landingPage?: string;

  @IsOptional()
  @IsDateString()
  visitedAt?: string;

  @ValidateNested()
  @Type(() => AdvertisingConsentDto)
  consent!: AdvertisingConsentDto;
}

export class RecordCommercialEventDto {
  @IsEnum(AdvertisingEventType)
  eventType!: AdvertisingEventType;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  value?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  revenueReceived?: number;

  @IsOptional()
  @Matches(CURRENCY)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  commercialReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  serviceRequested?: string;
}

export class UpsertConversionMappingDto {
  @IsEnum(AdvertisingEventType)
  eventType!: AdvertisingEventType;

  @IsString()
  @Matches(/^\d{1,30}$/)
  conversionActionId!: string;

  @IsBoolean()
  exportEnabled!: boolean;

  @IsBoolean()
  isPrimary!: boolean;
}

export class AdvertisingDateRangeDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class RevokeAdvertisingConsentDto {
  @IsString()
  @MaxLength(300)
  reason!: string;
}

export class SyncMetricsDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;
}

export class UpdateAdvertisingIntegrationDto {
  @IsBoolean()
  conversionSyncEnabled!: boolean;

  @IsBoolean()
  metricsSyncEnabled!: boolean;

  @IsString()
  @Matches(/^\d{1,30}$/)
  accountId!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{1,30}$/)
  loginAccountId?: string;
}
