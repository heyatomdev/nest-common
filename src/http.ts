import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet, { type HelmetOptions } from 'helmet';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { REQUEST_ID_HEADER } from './logging.js';

export interface HttpAppOptions {
  /**
   * `TRUST_PROXY_HOPS`: 0 = `req.ip` is the socket peer; N = trust the last N
   * `X-Forwarded-For` hops (1 = the one nginx appends). Required behind a proxy
   * with an IP throttler, or every client shares the proxy's IP.
   */
  trustProxyHops: number;
  /**
   * `CORS_ORIGINS`, already split. Empty = no cross-origin browser access. `'*'` (or a `'*'`
   * entry) = any origin, without credentials (public CDN).
   */
  corsOrigins: '*' | string[];
  /**
   * Custom headers the service accepts (`Idempotency-Key`, `X-API-Key`, …). The base is only
   * `Content-Type, Authorization`: list every other request header browsers send.
   */
  corsAllowedHeaders?: string[];
  /** Response headers browsers may read, on top of `X-Request-Id` (e.g. `X-Deploy-Color`). */
  corsExposedHeaders?: string[];
  /** JSON body limit, default `1mb`. */
  jsonBodyLimit?: string;
  /** urlencoded body limit, default `100kb`. */
  urlencodedBodyLimit?: string;
  /**
   * Replaces helmet's defaults. A CDN serving `<img>`/`<video>` to other sites needs
   * `crossOriginResourcePolicy: { policy: 'cross-origin' }`; `/docs` over plain http (LAN)
   * needs `contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } }`.
   */
  helmet?: HelmetOptions;
}

/** `CORS_ORIGINS` env (comma-separated) → list. */
export function parseCorsOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * The common `main.ts` bootstrap (api.md §8): shutdown hooks, `trust proxy`, helmet,
 * CORS allowlist, JSON body limit, global ValidationPipe. Call it right after
 * `NestFactory.create(…, { bufferLogs: true })` + `app.useLogger(app.get(Logger))`.
 * Envelope and filter are `APP_INTERCEPTOR` / `APP_FILTER` providers, not here.
 */
export function setupHttpApp(app: NestExpressApplication, opts: HttpAppOptions): void {
  // First middleware: body-parser errors (400/413) are raised before pino-http runs, and still
  // need an id. `genReqId` reuses it.
  app.use((req: IncomingMessage & { id?: unknown }, res: ServerResponse, next: () => void) => {
    req.id = randomUUID();
    res.setHeader(REQUEST_ID_HEADER, req.id as string);
    next();
  });
  app.enableShutdownHooks();
  app.set('trust proxy', opts.trustProxyHops);
  app.use(helmet(opts.helmet));
  const anyOrigin = opts.corsOrigins === '*' || opts.corsOrigins.includes('*');
  const origins = new Set(opts.corsOrigins);
  app.enableCors({
    // A disallowed origin gets no CORS headers and the browser blocks it; an Error here would be a 500.
    origin: anyOrigin
      ? '*'
      : (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) =>
          cb(null, !origin || origins.has(origin)),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', ...(opts.corsAllowedHeaders ?? [])],
    // Without it a browser client cannot read the id to quote it in a bug report.
    exposedHeaders: ['X-Request-Id', ...(opts.corsExposedHeaders ?? [])],
    // Browsers refuse credentials with `Access-Control-Allow-Origin: *`.
    credentials: !anyOrigin,
  });
  app.useBodyParser('json', { limit: opts.jsonBodyLimit ?? '1mb' });
  app.useBodyParser('urlencoded', { limit: opts.urlencodedBodyLimit ?? '100kb', extended: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}

/**
 * `name` and `version` of the first package.json found walking up from `dir`: the same from
 * `src/`, `dist/` and `dist/src/`. Call it with `__dirname` (or `process.cwd()`).
 * Not `npm_package_version`, unset under `node dist/main.js`.
 */
export function readAppInfo(dir: string): { name: string; version: string } {
  for (let d = dir; ; d = dirname(d)) {
    const file = join(d, 'package.json');
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as { name: string; version: string };
    if (dirname(d) === d) throw new Error(`readAppInfo: no package.json above ${dir}`);
  }
}

/** `APP_VERSION` for Swagger and `/health`: `readAppInfo(dir).version`. */
export function readAppVersion(dir: string): string {
  return readAppInfo(dir).version;
}
