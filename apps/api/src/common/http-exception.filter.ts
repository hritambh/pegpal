import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ApiError } from '@pegpal/shared';
import type { Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';

/** Maps every error to the single ApiError shape and logs server faults. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = req.headers['x-request-id'] as string | undefined;

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let code: string | undefined;
    let details: string[] | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const b = body as { message?: unknown; code?: unknown; details?: unknown };
        if (Array.isArray(b.message)) {
          // class-validator output
          message = 'Validation failed';
          details = b.message.map(String);
          code = 'VALIDATION_FAILED';
        } else if (typeof b.message === 'string') {
          message = b.message;
        }
        if (typeof b.code === 'string') code = b.code;
        if (Array.isArray(b.details)) details = b.details.map(String);
      }
    } else {
      this.logger.error(
        { msg: 'Unhandled error', requestId, path: req.url, err: exception instanceof Error ? exception.stack : exception },
      );
    }

    if (status >= 500 && exception instanceof HttpException) {
      this.logger.warn({ msg: 'Server error response', requestId, path: req.url, status, message });
    }

    const payload: ApiError = {
      statusCode: status,
      error: STATUS_CODES[status] ?? 'Error',
      message,
      ...(code ? { code } : {}),
      ...(details ? { details } : {}),
      ...(requestId ? { requestId } : {}),
    };
    if (!res.headersSent) res.status(status).json(payload);
  }
}
