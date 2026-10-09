import { Body, Controller, HttpCode, Inject, Post, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import type { AdminLoginRequest, AdminLoginResponse } from '@pegpal/shared';
import { IsString, Length } from 'class-validator';
import { timingSafeEqual } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { verifyPassword } from './password';

class LoginDto implements AdminLoginRequest {
  @IsString()
  @Length(1, 64)
  username!: string;

  @IsString()
  @Length(1, 256)
  password!: string;
}

@Controller('admin/auth')
export class AuthController {
  constructor(
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(@Body() dto: LoginDto): Promise<AdminLoginResponse> {
    const userOk = safeEqual(dto.username, this.config.ADMIN_USERNAME);
    // Always run the hash check so timing doesn't reveal valid usernames.
    const passOk = verifyPassword(dto.password, this.config.ADMIN_PASSWORD_HASH);
    if (!userOk || !passOk) {
      await this.audit.record({ type: 'ADMIN_LOGIN_FAILED', severity: 'WARN', payload: { username: dto.username.slice(0, 64) } });
      throw new UnauthorizedException('Invalid credentials');
    }
    await this.audit.record({ type: 'ADMIN_LOGIN', actor: dto.username });
    const accessToken = await this.jwt.signAsync({ sub: dto.username, role: 'operator' });
    return { accessToken, expiresInSec: this.config.ADMIN_JWT_TTL_SEC };
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
