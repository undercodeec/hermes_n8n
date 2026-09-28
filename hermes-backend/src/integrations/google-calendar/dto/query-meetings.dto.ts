import { MeetingStatus } from '@prisma/client';
import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsTimeZone,
  Matches,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'meetingRange', async: false })
class MeetingRangeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const query = args.object as QueryMeetingsDto;
    if (typeof query.from !== 'string' || typeof value !== 'string')
      return false;
    const duration = Date.parse(value) - Date.parse(query.from);
    return (
      Number.isFinite(duration) && duration > 0 && duration <= 42 * 86400000
    );
  }

  defaultMessage(): string {
    return 'to debe ser posterior a from y el intervalo no debe superar 42 días';
  }
}

// An explicit offset is required: never interpret a date in the server timezone.
const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export class QueryMeetingsDto {
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(INSTANT_PATTERN)
  from!: string;

  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(INSTANT_PATTERN)
  @Validate(MeetingRangeConstraint)
  to!: string;

  @IsOptional()
  @IsEnum(MeetingStatus)
  status?: MeetingStatus;

  @IsOptional()
  @IsString()
  @IsTimeZone()
  timezone?: string;
}
