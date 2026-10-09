import type { CalibrationKind, CalibrationMeasurementRequest, MockFaultConfig, StartCalibrationRequest } from '@pegpal/shared';
import { PUMP_CHANNEL_COUNT } from '@pegpal/shared';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class SetMachineStatusDto {
  @IsIn(['IN_SERVICE', 'OUT_OF_SERVICE'])
  status!: 'IN_SERVICE' | 'OUT_OF_SERVICE';
}

export class ReasonDto {
  @IsString()
  @Length(1, 200)
  reason!: string;
}

export class NoteDto {
  @IsString()
  @Length(1, 500)
  note!: string;
}

export class ListQueryDto {
  @IsOptional()
  @IsUUID('4')
  machineId?: string;

  @IsOptional()
  @IsUUID('4')
  orderId?: string;

  @IsOptional()
  @IsUUID('4')
  liquidId?: string;

  @IsOptional()
  @IsIn(['INFO', 'WARN', 'SAFETY'])
  severity?: 'INFO' | 'WARN' | 'SAFETY';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export class StartCalibrationDto implements StartCalibrationRequest {
  @IsUUID('4')
  liquidId!: string;

  @IsIn(['FLOW_RATE', 'VALIDATION'])
  kind!: CalibrationKind;

  @ValidateIf((o: StartCalibrationDto) => o.kind === 'FLOW_RATE')
  @IsInt()
  @Min(500)
  @Max(120_000)
  runtimeMs?: number;

  @ValidateIf((o: StartCalibrationDto) => o.kind === 'VALIDATION')
  @IsInt()
  @Min(1)
  @Max(500)
  targetMl?: number;
}

export class CalibrationMeasurementDto implements CalibrationMeasurementRequest {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.1)
  @Max(2000)
  measuredMl!: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.1)
  @Max(4000)
  measuredMassG?: number;
}

export class MockConfigDto implements Partial<MockFaultConfig> {
  @IsOptional() @IsNumber() @Min(0.05) @Max(5) flowRateMultiplier?: number;
  @IsOptional() @IsObject() channelFlowMultipliers?: Record<string, number>;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(PUMP_CHANNEL_COUNT - 1) failChannel?: number | null;
  @IsOptional() @IsBoolean() dropAcks?: boolean;
  @IsOptional() @IsBoolean() dropCompletion?: boolean;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(0) @Max(1) disconnectAtFraction?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(0) @Max(1) estopAtFraction?: number | null;
  @IsOptional() @IsBoolean() scaleUnstable?: boolean;
  @IsOptional() @IsBoolean() scaleMissing?: boolean;
}

export class ActiveDto {
  @IsBoolean()
  active!: boolean;
}

export class ConnectedDto {
  @IsBoolean()
  connected!: boolean;
}
