import { IsUUID, Matches } from 'class-validator';

/** Public machine identifiers as printed in QR codes. */
export const PUBLIC_MACHINE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class MachineIdParam {
  @Matches(PUBLIC_MACHINE_ID, { message: 'machineId has an invalid format' })
  machineId!: string;
}

export class OrderIdParam {
  @IsUUID('4')
  orderId!: string;
}

export class IdParam {
  @IsUUID('4')
  id!: string;
}
