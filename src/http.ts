import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HttpAppOptions {
  /**
   * `TRUST_PROXY_HOPS`: 0 = `req.ip` is the socket peer; N = trust the last N
   * `X-Forwarded-For` hops (1 = the one nginx appends). Required behind a proxy
   * with an IP throttler, or every client shares the proxy's IP.
   */
  trustProxyHops: number;
  /** `CORS_ORIGINS`, already split. Empty = no cross-origin browser access. */
  corsOrigins: string[];
  /** Custom headers the service accepts (`Idempotency-Key`, `X-API-Key`, …) on top of Content-Type/Authorization. */
  corsAllowedHeaders?: string[];
  /** Response headers browsers may read, on top of `X-Request-Id` (e.g. `X-Deploy-Color`). */
  corsExposedHeaders?: string[];
  /** JSON body limit, default `1mb`. */
  jsonBodyLimit?: string;
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
  app.enableShutdownHooks();
  app.set('trust proxy', opts.trustProxyHops);
  app.use(helmet());
  const origins = new Set(opts.corsOrigins);
  app.enableCors({
    // A disallowed origin gets no CORS headers and the browser blocks it; an Error here would be a 500.
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) =>
      cb(null, !origin || origins.has(origin)),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', ...(opts.corsAllowedHeaders ?? [])],
    // Without it a browser client cannot read the id to quote it in a bug report.
    exposedHeaders: ['X-Request-Id', ...(opts.corsExposedHeaders ?? [])],
    credentials: true,
  });
  app.useBodyParser('json', { limit: opts.jsonBodyLimit ?? '1mb' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}

/**
 * `APP_VERSION` for Swagger and `/health`: the `version` of the package.json in `dir`.
 * Not `npm_package_version`, unset under `node dist/main.js`. From `src/common/version.ts`:
 * `readAppVersion(join(__dirname, '../..'))` resolves the same from `src/` and `dist/`.
 */
export function readAppVersion(dir: string): string {
  return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }).version;
}
