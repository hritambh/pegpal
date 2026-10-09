import { PartialType } from '@nestjs/mapped-types';
import type { DispenseStrategy, UpsertLiquidRequest } from '@pegpal/shared';
import { PUMP_CHANNEL_COUNT } from '@pegpal/shared';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

/** Absolute bounds for operator-entered configuration; machine-level limits apply on top. */
const MAX_ML_PER_LIQUID = 500;

export class CreateLiquidDto implements UpsertLiquidRequest {
  @IsString()
  @Length(1, 60)
  name!: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUrl({ protocols: ['https', 'http'], require_protocol: true })
  imageUrl?: string | null;

  @IsInt()
  @Min(0)
  @Max(PUMP_CHANNEL_COUNT - 1)
  pumpChannel!: number;

  @IsIn(['TIMED', 'WEIGHT'])
  strategy!: DispenseStrategy;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.5)
  @Max(2)
  densityGPerMl?: number | null;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(20)
  cutoffMarginG?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_ML_PER_LIQUID)
  minMl!: number;

  @IsInt()
  @Min(1)
  @Max(MAX_ML_PER_LIQUID)
  maxMl!: number;

  @IsString()
  @Matches(/^\d{1,6}(\.\d{1,4})?$/, { message: 'pricePerMl must be a non-negative decimal with up to 4 places' })
  pricePerMl!: string;

  @IsBoolean()
  active!: boolean;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(100_000)
  remainingStockMl?: number | null;
}

export class UpdateLiquidDto extends PartialType(CreateLiquidDto) {}
