import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

export interface AdminPrincipal {
  sub: string;
  role: 'operator';
}

type AdminRequest = Request & { admin?: AdminPrincipal };

/** Requires a valid operator JWT. Applied to every admin controller. */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Admin authentication required');
    try {
      const payload = await this.jwt.verifyAsync<AdminPrincipal>(header.slice(7));
      if (payload.role !== 'operator') throw new Error('wrong role');
      req.admin = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired admin token');
    }
  }
}

/** The authenticated operator's username, for audit records. */
export const Actor = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<AdminRequest>();
  return req.admin?.sub ?? 'unknown';
});
