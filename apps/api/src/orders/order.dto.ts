import type { ConfirmOrderRequest, CreateOrderItemRequest, CreateOrderRequest } from '@pegpal/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PUBLIC_MACHINE_ID } from '../common/params';

/** Absolute ceiling; per-liquid and per-order limits are enforced in the service. */
const ABSOLUTE_MAX_ML = 1000;

export class CreateOrderItemDto implements CreateOrderItemRequest {
  @IsUUID('4')
  liquidId!: string;

  @IsInt({ message: 'volumeMl must be a whole number of mL' })
  @Min(1)
  @Max(ABSOLUTE_MAX_ML)
  volumeMl!: number;
}

export class CreateOrderDto implements CreateOrderRequest {
  @Matches(PUBLIC_MACHINE_ID)
  machineId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items!: CreateOrderItemDto[];
}

export class ConfirmOrderDto implements ConfirmOrderRequest {
  @IsOptional()
  @IsBoolean()
  testPaymentConfirmed?: boolean;
}
