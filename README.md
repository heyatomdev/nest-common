# @heyatom/nest-common

Shared HTTP contract for the HeyAtom NestJS services: the reference implementation of the
platform API standard (`heyatom/docs/standards/api.md`). Replaces the `pagination.ts`,
`TransformInterceptor`, exception filters, request-id middleware and metrics modules every
service used to copy by hand.

- `@heyatom/nest-common` — `PageParams`, `paginate()`, `PageMetaDto`, `ApiPaginatedResponse()`
  (§1); `TransformInterceptor` + `@NoTransform()` (§2); `AllExceptionsFilter` with the Prisma
  mapping (§3); `swaggerEnabled()`, `createOpenApiDocument()`, `setupSwagger()` (§4);
  `loggerParams()`, `genReqId`, `clientRequestId()` (§7); `setupHttpApp()`, `parseCorsOrigins()`,
  `readAppVersion()` (§8).
- `@heyatom/nest-common/metrics` — `MetricsModule` (own `GET /metrics` server on `:9091`,
  `http_request_duration_seconds` middleware), `MetricsService` (§5).

What is deliberately **not** here (health controller, idempotency, webhook signing, throttler
guards) and why: [`docs/DECISIONS.md`](docs/DECISIONS.md). `@Public()`, guards and audit live in
`@heyatom/bastion-client`.

Ships CJS and ESM. Node ≥ 20.19. Peer deps: `@nestjs/common`, `@nestjs/core`,
`@nestjs/platform-express`, `@nestjs/swagger`, `class-validator`, `class-transformer`, `helmet`,
`rxjs`, `reflect-metadata`; optional `nestjs-pino` (for `loggerParams`) and
`@prometheus-io/client` (for `/metrics`). No Prisma dependency: Prisma errors are recognized by
`name` + `code`, since every service generates its own client.

## Bootstrap

```ts
// main.ts
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { parseCorsOrigins, setupHttpApp, setupSwagger } from '@heyatom/nest-common';
import { APP_VERSION } from './common/version';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const config = app.get(ConfigService);

  // shutdown hooks, trust proxy, helmet, CORS allowlist, JSON body limit, ValidationPipe
  setupHttpApp(app, {
    trustProxyHops: config.getOrThrow<number>('TRUST_PROXY_HOPS'),
    corsOrigins: parseCorsOrigins(config.get('CORS_ORIGINS')),
    corsAllowedHeaders: ['Idempotency-Key'], // custom headers the service really accepts
    // jsonBodyLimit: '1mb',
  });

  if (config.get('ENABLE_SWAGGER') === 'true') {
    setupSwagger(app, { title: 'Herald', version: APP_VERSION, configure: (b) => b.addBearerAuth() });
  }
  await app.listen(config.getOrThrow<number>('PORT'));
}
void bootstrap();
```

```ts
// src/common/version.ts — same result from src/ and dist/
import { join } from 'node:path';
import { readAppVersion } from '@heyatom/nest-common';
export const APP_VERSION = readAppVersion(join(__dirname, '../..'));
```

```ts
// config validation: resolve the fail-closed Swagger default once
import { swaggerEnabled } from '@heyatom/nest-common';
validated.ENABLE_SWAGGER ??= String(swaggerEnabled(validated));
// unset or unexpected NODE_ENV → false; development/test → true; explicit ENABLE_SWAGGER wins
```

```ts
// scripts/openapi-dump.ts — the same document as /docs-json, no listening port
const app = await NestFactory.create(AppModule, { logger: false });
const doc = createOpenApiDocument(app, { title: 'Herald', version: APP_VERSION, configure: (b) => b.addBearerAuth() });
writeFileSync('openapi.json', JSON.stringify(doc, null, 2) + '\n');
```

## Module

```ts
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AllExceptionsFilter, loggerParams, TransformInterceptor } from '@heyatom/nest-common';
import { MetricsModule } from '@heyatom/nest-common/metrics';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        loggerParams({
          service: 'herald',
          level: config.getOrThrow('LOG_LEVEL'),
          pretty: config.get('NODE_ENV') === 'development',
          redact: ['req.body.password'], // on top of authorization, cookie, x-api-key, x-internal-secret, set-cookie
        }),
    }),
    MetricsModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        app: 'herald',
        port: config.getOrThrow<number>('METRICS_PORT'), // default 9091
        host: config.getOrThrow<string>('METRICS_HOST'), // default 0.0.0.0
      }),
    }),
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
```

Services whose URLs carry tokens keep their own `req` serializer:

```ts
const params = loggerParams({ service: 'beacon', level });
return { pinoHttp: { ...params.pinoHttp, serializers: { req: requestLogSerializer } } };
```

### Request id

`genReqId` (used by `loggerParams`) always generates a UUID and sets it as the `X-Request-Id`
response header, before any guard runs, so errors carry it too and the filter repeats it as
`requestId`. The caller's `X-Request-Id` is never adopted nor echoed: when it matches
`/^[A-Za-z0-9._-]{1,64}$/` it is logged as `clientRequestId`, otherwise dropped. Outbound calls
to other platform services send `req.id` as `X-Request-Id`.

## Pagination and envelope

```ts
export class ListEventsQuery extends PageParams {   // extend: `skip` is a prototype getter
  @IsOptional() @IsIn(['DRAFT', 'PUBLISHED']) status?: string;
}

@Get()
@ApiPaginatedResponse(EventDto)
async list(@Query() q: ListEventsQuery) {
  const where = { tenantId, status: q.status };
  const [items, total] = await Promise.all([
    this.prisma.event.findMany({ where, skip: q.skip, take: q.limit }),
    this.prisma.event.count({ where }),
  ]);
  return paginate(items, total, q); // { data, meta: { total, page, limit, totalPages } }
}

@Get(':id')
get() { return event; }             // → { data: event }

@Get('.well-known/jwks.json')
@NoTransform()                       // files, redirects, JWKS/OAuth, health, webhook replies
jwks() { return { keys }; }
```

`TransformInterceptor` passes `null`/`undefined` and an existing `{ data, meta }` through.

## Errors

```ts
throw new ConflictException({ code: 'SLUG_TAKEN', message: 'Slug already in use' });
// 409 { statusCode: 409, code: 'SLUG_TAKEN', message: 'Slug already in use', requestId: '…' }
```

- `code` from the body when declared, else from the status (`BAD_REQUEST`, `UNAUTHORIZED`,
  `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `UNPROCESSABLE`, `RATE_LIMITED`,
  `INTERNAL_ERROR`, `UPSTREAM`, `UNAVAILABLE`, otherwise the `HttpStatus` name).
- `ValidationPipe` errors → `400 VALIDATION_FAILED`, `message: 'Validation failed'`, `errors: string[]`.
- Extra fields of the exception body are kept (`errorType`, `logId`, …); Nest's `error` label is dropped.
  `retryAfterSeconds: number` also becomes a `Retry-After` header.
- Prisma: `P2002`/`P2003` → 409 `CONFLICT`, `P2025` → 404 `NOT_FOUND`, any other → 500.
- Anything else → 500 `INTERNAL_ERROR`, generic message; the error and stack go to the log only.
- `@NoTransform()` handlers keep the exception body as is (e.g. terminus' 503 with `details`).
  The flag reaches the filter through `TransformInterceptor`, so register both.
- Logs `error` on 5xx, `warn` on 401/403/429, nothing on other 4xx (scanner 404s stay silent).

## Metrics

```ts
@Injectable()
export class MailMetrics {
  readonly sent: Counter<'status'>;
  constructor(metrics: MetricsService) {
    this.sent = new Counter({
      name: 'herald_mail_send_total', help: '…', labelNames: ['status'],
      registers: [metrics.registry],
    });
  }
}
```

`MetricsModule` is global and applies `MetricsMiddleware` to every route itself. The histogram `route` label is the Nest pattern (`/events/:id`),
`unmatched` for unknown routes; `/health*` is not observed. `GET /metrics` is served on its own
port, outside the Nest router: do not publish it from the container. A render is shared for 10 s,
so DB-backed gauges (`collect()`) run at most once per window.

## Development

```bash
pnpm install
pnpm lint        # tsc --noEmit
pnpm test        # vitest (SWC, for decorator metadata)
pnpm build       # dist/cjs + dist/esm
pnpm test:di     # Nest DI against dist/cjs
```
