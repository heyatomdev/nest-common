import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  SetMetadata,
  UseFilters,
  applyDecorators,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { REQUEST_ID_HEADER } from './logging.js';

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
  // Also raised on insert/update with an unknown foreign key, not only on delete-in-use.
  P2003: { status: 409, code: 'CONFLICT', message: 'Related resource constraint failed' },
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

/**
 * Set on the request by `TransformInterceptor` for `@NoTransform()` handlers. Kept for
 * compatibility: `@NoTransform()` now carries its own scoped filter.
 */
export const NO_TRANSFORM_REQUEST = Symbol.for('@heyatom/nest-common/no-transform');

type Req = IncomingMessage & { id?: unknown; route?: { path?: string }; [NO_TRANSFORM_REQUEST]?: boolean };

/**
 * http-errors shape (body-parser: malformed JSON 400, 413, 415, `request.aborted`). Duck-typed on
 * `expose` + `statusCode === status`: a bare `status` would also match an `AxiosError`, whose
 * status is the upstream's and must stay a 500.
 */
function httpErrorStatus(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const { expose, status, statusCode } = err as { expose?: unknown; status?: unknown; statusCode?: unknown };
  if (typeof expose !== 'boolean' || typeof status !== 'number' || status !== statusCode) return undefined;
  return status >= 400 && status < 500 ? status : undefined;
}
type Res = ServerResponse;

/**
 * Global `@Catch()` filter (api.md §3). Every branch sends a response.
 * Register as `APP_FILTER`.
 */
@Catch()
@Injectable()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  /** Set by `NoTransformExceptionFilter`: keep the `HttpException` body as is. */
  protected readonly passThrough: boolean = false;

  catch(exception: unknown, host: ArgumentsHost): void {
    // ponytail: HTTP only, no service has ws/rpc today; add a per-transport branch when one does.
    if (host.getType() !== 'http') {
      this.logger.error(`unhandled ${host.getType()} exception`, exception instanceof Error ? exception.stack : String(exception));
      return;
    }
    const http = host.switchToHttp();
    const req = http.getRequest<Req>();
    const res = http.getResponse<Res>();
    let requestId = typeof req.id === 'string' ? req.id : (res.getHeader(REQUEST_ID_HEADER) as string | undefined);
    // No `genReqId` wired (no `loggerParams`): still honour "requestId is always present".
    if (!requestId) {
      requestId = randomUUID();
      if (!res.headersSent) res.setHeader(REQUEST_ID_HEADER, requestId);
    }

    const passThrough = this.passThrough || !!req[NO_TRANSFORM_REQUEST];
    const { status, body } = this.toResponse(exception, requestId, passThrough);
    this.log(status, exception, req);

    if (res.headersSent) {
      res.end();
      return;
    }
    res.statusCode = status;
    // herald and fileharbor put the delay in the exception body; the header is what clients read.
    const retryAfter = (body as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
    if (typeof retryAfter === 'number') {
      res.setHeader('Retry-After', String(retryAfter));
      // A normalized body is our own copy; a passed-through one is the exception's, left untouched.
      if (!passThrough) delete (body as ErrorBody).retryAfterSeconds;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  }

  private toResponse(exception: unknown, requestId: string, passThrough: boolean) {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      // @NoTransform() handlers (terminus 503 with `details`) keep their body.
      if (passThrough) return { status, body: raw };
      return { status, body: normalize(status, raw, requestId) };
    }

    const parserStatus = httpErrorStatus(exception);
    if (parserStatus) {
      const err = exception as Error & { expose: boolean };
      const message = err.expose ? err.message : defaultMessage(parserStatus);
      return { status: parserStatus, body: { statusCode: parserStatus, code: defaultErrorCode(parserStatus), message, requestId } };
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
    // The route pattern, like MetricsMiddleware: raw paths carry tokens (`/albums/shared/<token>`).
    const where = `${req.method} ${req.route?.path ?? 'unmatched'}`;
    if (status >= 500) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      // Deliberate unavailability (queue full, upstream down, `retryAfterSeconds`): no stack, no alert.
      if (exception instanceof HttpException && (status === 502 || status === 503 || status === 504)) {
        this.logger.warn(`${status} ${where}: ${err.message}`);
        return;
      }
      // Prisma messages quote the whole invocation, arguments included (`passwordHash`…).
      if (err.name.startsWith('PrismaClient')) {
        const code = (err as { code?: unknown }).code;
        const frames = (err.stack ?? '').split('\n').filter((l) => l.trimStart().startsWith('at ')).join('\n');
        this.logger.error(`${status} ${where}: ${err.name}${typeof code === 'string' ? ` ${code}` : ''}`, frames);
        return;
      }
      this.logger.error(`${status} ${where}: ${err.message}`, err.stack);
    } else if (status === 401 || status === 403 || status === 429) {
      this.logger.warn(`${status} ${where}`);
    }
  }
}

/**
 * Handler/controller-scoped variant applied by `@NoTransform()`: also covers guard and pipe
 * rejections (which run before any interceptor) and services without `TransformInterceptor`.
 */
@Catch()
export class NoTransformExceptionFilter extends AllExceptionsFilter {
  protected override readonly passThrough = true;
}

export const NO_TRANSFORM_KEY = 'heyatom:no-transform';

/**
 * Opts a handler (or a whole controller) out of the `{ data }` envelope and of the
 * error-body normalization (api.md §2–§3): files, streams, redirects, JWKS/OAuth,
 * health checks, inbound webhook replies.
 *
 * By default it also applies a scoped catch-all filter (an instance: no provider needed), so
 * guard rejections keep their body too, with or without `TransformInterceptor`. That filter
 * runs before any `@UseFilters()` of the controller and shadows it: a handler whose own
 * filters must still apply passes `{ filter: false }` (metadata only; the body is then kept
 * only for errors thrown after `TransformInterceptor` ran).
 */
export const NoTransform = (opts: { filter?: boolean } = {}) =>
  opts.filter === false
    ? SetMetadata(NO_TRANSFORM_KEY, true)
    : applyDecorators(SetMetadata(NO_TRANSFORM_KEY, true), UseFilters(new NoTransformExceptionFilter()));

/** Nest exception body (string, `{ message, error }`, or a domain `{ code, message, … }`) → api.md §3 shape. */
export function normalize(status: number, raw: string | object, requestId: string | undefined): ErrorBody {
  if (typeof raw === 'string') {
    return { statusCode: status, code: defaultErrorCode(status), message: raw, requestId };
  }
  const { statusCode: _s, message, code, errors, ...extra } = raw as Record<string, unknown>;
  // Nest's label (`error: 'Conflict'`) only: a structured `error` (terminus' indicator map) is data.
  if (typeof extra.error === 'string') delete extra.error;
  const validation = Array.isArray(message);
  return {
    ...extra,
    statusCode: status,
    code: typeof code === 'string' ? code : validation ? 'VALIDATION_FAILED' : defaultErrorCode(status),
    message: validation ? 'Validation failed' : typeof message === 'string' ? message : defaultMessage(status),
    ...(validation ? { errors: (message as unknown[]).map(String) } : Array.isArray(errors) ? { errors: errors.map(String) } : {}),
    requestId,
  };
}

function defaultMessage(status: number): string {
  return defaultErrorCode(status).toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
