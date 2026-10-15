import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { REQUEST_ID_HEADER } from './logging.js';
import { NO_TRANSFORM_REQUEST } from './transform.interceptor.js';

/** Status codes whose `code` differs from the `HttpStatus` enum name (api.md §3). */
const CODE_OVERRIDES: Record<number, string> = {
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  502: 'UPSTREAM',
  503: 'UNAVAILABLE',
};

export function defaultErrorCode(status: number): string {
  return CODE_OVERRIDES[status] ?? (HttpStatus[status] as string | undefined) ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
}

/** Prisma known-request errors mapped once for every service (api.md §3). */
const PRISMA_STATUS: Record<string, { status: number; code: string; message: string }> = {
  P2002: { status: 409, code: 'CONFLICT', message: 'Resource already exists' },
  P2003: { status: 409, code: 'CONFLICT', message: 'Resource is still referenced' },
  P2025: { status: 404, code: 'NOT_FOUND', message: 'Resource not found' },
};

/**
 * Duck-typed: each service generates its own Prisma client, so there is no shared
 * class to `instanceof` against (and the package does not depend on Prisma).
 */
export function prismaErrorCode(err: unknown): string | undefined {
  if (!(err instanceof Error) || err.name !== 'PrismaClientKnownRequestError') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  errors?: string[];
  requestId?: string;
  [extra: string]: unknown;
}

type Req = IncomingMessage & { id?: unknown; [NO_TRANSFORM_REQUEST]?: boolean };
type Res = ServerResponse;

/**
 * Global `@Catch()` filter (api.md §3). Every branch sends a response.
 * Register as `APP_FILTER`.
 */
@Catch()
@Injectable()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Req>();
    const res = http.getResponse<Res>();
    const requestId = typeof req.id === 'string' ? req.id : (res.getHeader(REQUEST_ID_HEADER) as string | undefined);

    const { status, body } = this.toResponse(exception, requestId, !!req[NO_TRANSFORM_REQUEST]);
    this.log(status, exception, req);

    if (res.headersSent) {
      res.end();
      return;
    }
    res.statusCode = status;
    // herald and fileharbor put the delay in the exception body; the header is what clients read.
    const retryAfter = (body as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
    if (typeof retryAfter === 'number') res.setHeader('Retry-After', String(retryAfter));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  }

  private toResponse(exception: unknown, requestId: string | undefined, noTransform: boolean) {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      // @NoTransform() handlers (terminus 503 with `details`) keep their body; flag set by TransformInterceptor.
      if (noTransform) return { status, body: raw };
      return { status, body: normalize(status, raw, requestId) };
    }

    const prismaCode = prismaErrorCode(exception);
    const mapped = prismaCode ? PRISMA_STATUS[prismaCode] : undefined;
    if (mapped) {
      return { status: mapped.status, body: { statusCode: mapped.status, code: mapped.code, message: mapped.message, requestId } };
    }

    return {
      status: 500,
      body: { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error', requestId },
    };
  }

  private log(status: number, exception: unknown, req: Req): void {
    const where = `${req.method} ${(req.url ?? '').split('?')[0]}`;
    if (status >= 500) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`${status} ${where}: ${err.message}`, err.stack);
    } else if (status === 401 || status === 403 || status === 429) {
      this.logger.warn(`${status} ${where}`);
    }
  }
}

/** Nest exception body (string, `{ message, error }`, or a domain `{ code, message, … }`) → api.md §3 shape. */
export function normalize(status: number, raw: string | object, requestId: string | undefined): ErrorBody {
  if (typeof raw === 'string') {
    return { statusCode: status, code: defaultErrorCode(status), message: raw, requestId };
  }
  const { error: _nestLabel, statusCode: _s, message, code, errors, ...extra } = raw as Record<string, unknown>;
  const validation = Array.isArray(message);
  return {
    ...extra,
    statusCode: status,
    code: typeof code === 'string' ? code : validation && status === 400 ? 'VALIDATION_FAILED' : defaultErrorCode(status),
    message: validation ? 'Validation failed' : typeof message === 'string' ? message : defaultMessage(status),
    ...(validation ? { errors: (message as unknown[]).map(String) } : Array.isArray(errors) ? { errors: errors.map(String) } : {}),
    requestId,
  };
}

function defaultMessage(status: number): string {
  return defaultErrorCode(status).toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
