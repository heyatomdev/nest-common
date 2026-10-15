import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Opaque-token shape a caller's `X-Request-Id` must have to be logged at all (api.md §7). */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The caller's `X-Request-Id`, if well-formed — logged as `clientRequestId`, never
 * adopted as the request id and never echoed back (log/header injection).
 * A repeated header arrives as an array: no single caller intent to keep.
 */
export function clientRequestId(header: string | string[] | undefined): string | undefined {
  return typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : undefined;
}

/**
 * pino-http `genReqId`: always a server-generated UUID, also set as the
 * `X-Request-Id` response header (errors included: it is set before any handler runs).
 */
export function genReqId(_req: IncomingMessage, res: ServerResponse): string {
  const id = randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

/** Headers removed from every request/response log line (api.md §7). */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-internal-secret"]',
  'res.headers["set-cookie"]',
];

export interface LoggerOptions {
  /** Service slug, logged as `service` on every line. */
  service: string;
  /** From the validated `LOG_LEVEL`. */
  level: string;
  /** `pino-pretty` single-line output; keep it off in production. */
  pretty?: boolean;
  /** Extra redact paths on top of `REDACTED_PATHS` (e.g. `req.body.password`). */
  redact?: string[];
}

/**
 * `LoggerModule.forRoot(Async)` params for nestjs-pino (api.md §7). Override
 * `pinoHttp.serializers` with `{ ...opts.pinoHttp, serializers }` when URLs carry tokens.
 */
export function loggerParams(opts: LoggerOptions): Params {
  return {
    pinoHttp: {
      level: opts.level,
      transport: opts.pretty
        ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
        : undefined,
      redact: { paths: [...REDACTED_PATHS, ...(opts.redact ?? [])], remove: true },
      genReqId,
      customProps: (req: IncomingMessage) => {
        const callerId = clientRequestId(req.headers['x-request-id']);
        return callerId ? { service: opts.service, clientRequestId: callerId } : { service: opts.service };
      },
      // Prefix match: the routes are /health/live and /health/ready, an exact '/health' ignores nothing.
      autoLogging: { ignore: (req: IncomingMessage) => (req.url ?? '').startsWith('/health') },
    },
  };
}
