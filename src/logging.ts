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
  /**
   * Replace the default `req` / `res` log serializers, e.g. a `req` serializer that sanitizes
   * URLs carrying tokens. pino-http hands them its standard serialized object (with `.raw`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pino-http's serialized shapes
  serializers?: { req?: (req: any) => unknown; res?: (res: any) => unknown };
}

/** The `Options` member of nestjs-pino's `pinoHttp` union, without importing pino-http. */
export type PinoHttpOptions = Exclude<NonNullable<Params['pinoHttp']>, unknown[] | { write: unknown }>;

/** nestjs-pino `Params` with `pinoHttp` narrowed to options, so `{ ...params.pinoHttp }` spreads without a cast. */
export type LoggerParams = Omit<Params, 'pinoHttp'> & { pinoHttp: PinoHttpOptions };

interface SerializedReq {
  id?: unknown;
  method?: string;
  url?: string;
  remoteAddress?: string;
}

/**
 * Default `req` serializer: no headers, no query, no body. pino-http's standard one logs every
 * request header, the caller's raw `X-Request-Id` included, which defeats `clientRequestId`.
 */
export function minimalRequestSerializer(req: SerializedReq) {
  return { id: req.id, method: req.method, url: req.url, remoteAddress: req.remoteAddress };
}

/** Default `res` serializer: status only (no `set-cookie` or other response headers). */
export function minimalResponseSerializer(res: { statusCode?: number }) {
  return { statusCode: res.statusCode };
}

/**
 * `LoggerModule.forRoot(Async)` params for nestjs-pino (api.md §7). Request lines carry
 * `id`, `method`, `url`, `remoteAddress` and the status, never headers; pass `serializers`
 * to replace them (URLs carrying tokens). `REDACTED_PATHS` still applies to whatever a
 * custom serializer keeps.
 */
export function loggerParams(opts: LoggerOptions): LoggerParams {
  return {
    pinoHttp: {
      level: opts.level,
      transport: opts.pretty
        ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
        : undefined,
      redact: { paths: [...REDACTED_PATHS, ...(opts.redact ?? [])], remove: true },
      serializers: {
        req: opts.serializers?.req ?? minimalRequestSerializer,
        res: opts.serializers?.res ?? minimalResponseSerializer,
      },
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
