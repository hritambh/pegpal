import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

const VALID_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Assigns X-Request-Id and writes one structured access-log line per request. */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && VALID_ID.test(incoming) ? incoming : randomUUID();
    req.headers['x-request-id'] = id;
    res.setHeader('X-Request-Id', id);
    const start = Date.now();
    res.on('finish', () => {
      this.logger.log({
        msg: 'request',
        requestId: id,
        method: req.method,
        // Strip query strings: they never carry anything we need in logs.
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Date.now() - start,
      });
    });
    next();
  }
}
