import { BankAccountType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class BankAccountDto {
  @IsString() @MaxLength(100) label!: string;
  @IsString() @MaxLength(100) bankName!: string;
  @IsString() @MaxLength(150) accountHolder!: string;
  @IsOptional() @IsString() @MaxLength(30) holderIdentification?: string;
  @IsEnum(BankAccountType) accountType!: BankAccountType;
  @IsString() @Matches(/^(?=(?:.*\d){6})[0-9-]{6,34}$/) accountNumber!: string;
  @Matches(/^[A-Z]{3}$/) currency!: string;
  @IsOptional() @IsString() @MaxLength(500) instructions?: string;
  @IsOptional() @IsInt() @Min(0) priority?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateBankAccountDto {
  @IsOptional() @IsString() @MaxLength(100) label?: string;
  @IsOptional() @IsString() @MaxLength(100) bankName?: string;
  @IsOptional() @IsString() @MaxLength(150) accountHolder?: string;
  @IsOptional() @IsString() @MaxLength(30) holderIdentification?: string;
  @IsOptional() @IsEnum(BankAccountType) accountType?: BankAccountType;
  @IsOptional()
  @IsString()
  @Matches(/^(?=(?:.*\d){6})[0-9-]{6,34}$/)
  accountNumber?: string;
  @IsOptional() @Matches(/^[A-Z]{3}$/) currency?: string;
  @IsOptional() @IsString() @MaxLength(500) instructions?: string;
  @IsOptional() @IsInt() @Min(0) priority?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
