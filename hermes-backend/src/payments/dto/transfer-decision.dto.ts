import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { TransferPaymentStatus } from '@prisma/client';

export class ApproveTransferDto {
  @IsEnum(TransferPaymentStatus) expectedStatus!: TransferPaymentStatus;
  @IsString() reviewedProofMessageId!: string;
  @IsString() @MaxLength(128) contractReference!: string;
  @IsOptional() @IsString() @MaxLength(2000) reviewNote?: string;
}

export class RejectTransferDto {
  @IsEnum(TransferPaymentStatus) expectedStatus!: TransferPaymentStatus;
  @IsString() @MaxLength(2000) reviewNote!: string;
}
