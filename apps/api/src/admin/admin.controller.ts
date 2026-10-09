import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import type {
  AdminLiquidView,
  AdminMachineView,
  AdminOverview,
  CalibrationRunView,
  DispensingEventView,
  IssuedMachineCredential,
  MachineCredentialView,
  MockStateView,
  OrderView,
} from '@pegpal/shared';
import { IsString, Matches } from 'class-validator';
import { Errors } from '../common/errors';
import { IdParam } from '../common/params';
import { CredentialsService } from '../hardware/credentials.service';
import { HARDWARE_ADAPTER, HardwareAdapter } from '../hardware/hardware-adapter';
import { MockHardwareAdapter } from '../hardware/mock/mock-hardware.adapter';
import { CreateLiquidDto, UpdateLiquidDto } from '../liquids/liquid.dto';
import { LiquidsService } from '../liquids/liquids.service';
import { MachinesService } from '../machines/machines.service';
import { Actor, AdminAuthGuard } from './admin-auth.guard';
import {
  ActiveDto,
  CalibrationMeasurementDto,
  ConnectedDto,
  ListQueryDto,
  MockConfigDto,
  NoteDto,
  ReasonDto,
  SetMachineStatusDto,
  StartCalibrationDto,
} from './admin.dto';
import { AdminService } from './admin.service';
import { CalibrationService } from './calibration.service';

class KeyIdParam {
  @IsString()
  @Matches(/^k_[0-9a-f]{16}$/)
  keyId!: string;
}

@Controller('admin')
@UseGuards(AdminAuthGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly liquids: LiquidsService,
    private readonly credentials: CredentialsService,
  ) {}

  @Get('overview')
  overview(): Promise<AdminOverview> {
    return this.admin.overview();
  }

  @Get('orders')
  orders(@Query() q: ListQueryDto): Promise<OrderView[]> {
    return this.admin.orders(q);
  }

  @Get('events')
  events(@Query() q: ListQueryDto): Promise<DispensingEventView[]> {
    return this.admin.events(q);
  }

  @Patch('machines/:id')
  setStatus(@Param() { id }: IdParam, @Body() dto: SetMachineStatusDto, @Actor() actor: string): Promise<AdminMachineView> {
    return this.admin.setStatus(id, dto.status, actor);
  }

  @Post('machines/:id/stop')
  @HttpCode(200)
  stop(@Param() { id }: IdParam, @Body() dto: ReasonDto, @Actor() actor: string): Promise<AdminMachineView> {
    return this.admin.stop(id, dto.reason, actor);
  }

  @Post('machines/:id/clear-fault')
  @HttpCode(200)
  clearFault(@Param() { id }: IdParam, @Body() dto: NoteDto, @Actor() actor: string): Promise<AdminMachineView> {
    return this.admin.clearFault(id, dto.note, actor);
  }

  @Get('machines/:id/liquids')
  listLiquids(@Param() { id }: IdParam): Promise<AdminLiquidView[]> {
    return this.liquids.adminList(id);
  }

  @Post('machines/:id/liquids')
  createLiquid(@Param() { id }: IdParam, @Body() dto: CreateLiquidDto, @Actor() actor: string): Promise<AdminLiquidView> {
    return this.liquids.create(id, dto, actor);
  }

  @Patch('liquids/:id')
  updateLiquid(@Param() { id }: IdParam, @Body() dto: UpdateLiquidDto, @Actor() actor: string): Promise<AdminLiquidView> {
    return this.liquids.update(id, dto, actor);
  }

  @Get('machines/:id/credentials')
  listCredentials(@Param() { id }: IdParam): Promise<MachineCredentialView[]> {
    return this.credentials.list(id);
  }

  @Post('machines/:id/credentials')
  issueCredential(@Param() { id }: IdParam, @Actor() actor: string): Promise<IssuedMachineCredential> {
    return this.credentials.issue(id, actor);
  }

  @Post('credentials/:keyId/revoke')
  @HttpCode(200)
  revokeCredential(@Param() { keyId }: KeyIdParam, @Actor() actor: string): Promise<MachineCredentialView> {
    return this.credentials.revoke(keyId, actor);
  }
}

@Controller('admin/calibration')
@UseGuards(AdminAuthGuard)
export class CalibrationController {
  constructor(private readonly calibration: CalibrationService) {}

  @Get('runs')
  list(@Query() q: ListQueryDto): Promise<CalibrationRunView[]> {
    return this.calibration.list(q.liquidId, q.limit);
  }

  @Post('runs')
  start(@Body() dto: StartCalibrationDto, @Actor() actor: string): Promise<CalibrationRunView> {
    return this.calibration.start(dto, actor);
  }

  @Get('runs/:id')
  get(@Param() { id }: IdParam): Promise<CalibrationRunView> {
    return this.calibration.get(id);
  }

  @Post('runs/:id/measurement')
  @HttpCode(200)
  measure(@Param() { id }: IdParam, @Body() dto: CalibrationMeasurementDto, @Actor() actor: string): Promise<CalibrationRunView> {
    return this.calibration.measure(id, dto, actor);
  }

  @Post('runs/:id/apply')
  @HttpCode(200)
  apply(@Param() { id }: IdParam, @Actor() actor: string): Promise<AdminLiquidView> {
    return this.calibration.apply(id, actor);
  }
}

/** Simulator controls. Exists only in mock mode; 404 otherwise. `:id` is the machine's internal id. */
@Controller('admin/mock')
@UseGuards(AdminAuthGuard)
export class MockController {
  constructor(
    @Inject(HARDWARE_ADAPTER) private readonly adapter: HardwareAdapter,
    private readonly machines: MachinesService,
  ) {}

  private async sim(id: string): Promise<{ mock: MockHardwareAdapter; publicId: string }> {
    if (!(this.adapter instanceof MockHardwareAdapter)) throw Errors.notFound('NOT_MOCK_MODE', 'Simulator controls exist only in mock mode');
    const m = await this.machines.getById(id);
    return { mock: this.adapter, publicId: m.publicId };
  }

  private orNotFound(v: MockStateView | null): MockStateView {
    if (!v) throw Errors.notFound('SIMULATOR_NOT_FOUND', 'No simulator for this machine');
    return v;
  }

  @Get(':id')
  async state(@Param() { id }: IdParam): Promise<MockStateView> {
    const { mock, publicId } = await this.sim(id);
    return this.orNotFound(mock.state(publicId));
  }

  @Put(':id/config')
  async configure(@Param() { id }: IdParam, @Body() dto: MockConfigDto): Promise<MockStateView> {
    const { mock, publicId } = await this.sim(id);
    return this.orNotFound(mock.configure(publicId, dto));
  }

  /** Simulates the physical mushroom button being pressed / released and reset locally. */
  @Post(':id/estop')
  @HttpCode(200)
  async estop(@Param() { id }: IdParam, @Body() dto: ActiveDto): Promise<MockStateView> {
    const { mock, publicId } = await this.sim(id);
    return this.orNotFound(mock.setEstop(publicId, dto.active));
  }

  @Post(':id/connection')
  @HttpCode(200)
  async connection(@Param() { id }: IdParam, @Body() dto: ConnectedDto): Promise<MockStateView> {
    const { mock, publicId } = await this.sim(id);
    return this.orNotFound(mock.setConnected(publicId, dto.connected));
  }
}
