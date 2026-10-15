# Usage guide

Detailed usage of `@heyatom/nest-common`, one section per entry point. It is kept in the
repository only: the README published on npm is a short overview. References like §1 or §7
point to the platform API standard (`heyatom/docs/standards/api.md`). The reasons behind what
is in the package, and what is not, are in [`DECISIONS.md`](DECISIONS.md).

Entry points:

- `@heyatom/nest-common`
  - `PageParams`, `paginate()`, `markPaginated()`, `PageMetaDto`, `ApiPaginatedResponse()` (§1)
  - `TransformInterceptor` + `@NoTransform()` (§2)
  - `AllExceptionsFilter` with the Prisma mapping (§3)
  - `swaggerEnabled()`, `createOpenApiDocument()`, `setupSwagger()` (§4)
  - `loggerParams()`, `genReqId`, `clientRequestId()` (§7)
  - `setupHttpApp()`, `parseCorsOrigins()`, `readAppInfo()`, `readAppVersion()` (§8)
- `@heyatom/nest-common/metrics`
  - `MetricsModule`: own `GET /metrics` server on `:9091` and the
    `http_request_duration_seconds` middleware
  - `MetricsService` (§5)
- `@heyatom/nest-common/webhooks`: outbound webhooks, framework-free (§13)
  - SSRF guard: `checkWebhookUrl()`, `assertPublicWebhookUrl()`, `webhookLookup()`,
    `webhookAgent`, `isPublicAddress()`, `WebhookUrlError`
  - Standard Webhooks signing: `signStandardWebhook()`

Not in this package:
- `@Public()`, guards and audit live in `@heyatom/bastion-client`;
- verifying webhooks received from the platform belongs to `@heyatom/client`;
- health controller, idempotency and throttler guards stay in each service (`DECISIONS.md`).

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
    // X-Request-Id is always exposed to browsers; add the service's own response headers:
    // corsExposedHeaders: ['X-Deploy-Color'],
    // jsonBodyLimit: '1mb', urlencodedBodyLimit: '100kb',
    // helmet: { crossOriginResourcePolicy: { policy: 'cross-origin' } }, // CDN embedded by other sites
  });

  if (config.get('ENABLE_SWAGGER') === 'true') {
    setupSwagger(app, { title: 'Herald', version: APP_VERSION, configure: (b) => b.addBearerAuth() });
  }
  await app.listen(config.getOrThrow<number>('PORT'));
}
void bootstrap();
```

```ts
// src/common/version.ts — walks up to the first package.json: same from src/, dist/, dist/src/
import { readAppInfo } from '@heyatom/nest-common';
export const { name: APP_NAME, version: APP_VERSION } = readAppInfo(__dirname);
```

`setupHttpApp` details:
- Registers first a middleware that assigns the request id, so body-parser errors (malformed JSON
  400, 413, 415) carry `requestId` and `X-Request-Id` like every other response.
- `corsOrigins: '*'` (or a `'*'` entry, e.g. `CORS_ORIGINS=*`) answers any origin, without
  credentials: browsers refuse `*` with credentials.
- `corsAllowedHeaders` is added to a base of only `Content-Type, Authorization`: list every other
  request header the service reads from browsers (`X-API-Key`, `Idempotency-Key`, …).
- `helmet` replaces helmet's defaults. Two cases to know: `Cross-Origin-Resource-Policy:
  same-origin` (default) blocks `<img>`/`<video>` embedded by other sites, so a CDN passes
  `crossOriginResourcePolicy: { policy: 'cross-origin' }`; the default CSP has
  `upgrade-insecure-requests`, so `/docs` served over plain http (LAN IP) loads no JS/CSS — outside
  production pass `contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } }`.

```ts
// config validation: resolve the fail-closed Swagger default once
import { swaggerEnabled } from '@heyatom/nest-common';
validated.ENABLE_SWAGGER ??= String(swaggerEnabled(validated));
// unset or unexpected NODE_ENV → false; development/test → true; explicit ENABLE_SWAGGER wins
// own environment names: swaggerEnabled(validated, ['development', 'develop', 'test'])
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
        host: config.get<string>('METRICS_HOST'), // unset = :: (dual-stack)
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

Request lines carry `req.{id, method, url, remoteAddress}` and `res.statusCode`, never headers:
pino-http's standard serializer logs every request header, the caller's raw `X-Request-Id`
included. Services whose URLs carry tokens pass their own `req` serializer:

```ts
loggerParams({ service: 'beacon', level, serializers: { req: requestLogSerializer } });
```

The return type narrows `pinoHttp` to the options object, so `{ ...params.pinoHttp, … }` needs
no cast. For a destination stream (tests) pass nestjs-pino's tuple form yourself:
`LoggerModule.forRoot({ pinoHttp: [loggerParams(opts).pinoHttp, stream] })`. `serializers.err`
replaces pino's error serializer. `service` is in pino's `base`, so lines outside requests
(`Bootstrap`, `MetricsServer`, …) carry it too.

### Request id

`genReqId` (used by `loggerParams`) reuses the id `setupHttpApp` assigned, or generates a UUID and sets it as the `X-Request-Id`
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

`TransformInterceptor` passes `null`/`undefined` and `paginate()` results through. A
`paginate()` result carries a hidden marker (`isPaginated()`), so an entity that merely has `data`
and `meta` fields is still wrapped, and a hand-built `{ data, meta }` is wrapped too: always go
through `paginate()`. Add extra fields inside `meta` on the returned object
(`page.meta.statusCounts = …`) and return that object as is: **any copy loses the marker**
(`{ ...page }`, `Object.assign`, `structuredClone`, class-transformer, `ClassSerializerInterceptor`)
and the list comes out as `{ data: { data, meta } }`. Serialize the items *before* `paginate()`.

A page whose `meta` is not `PageMeta` (`pageSize`) or a `{ data, meta }` relayed as is from
Articuno/FileHarbor goes through `markPaginated(page)`: same object, marked.

## Errors

```ts
throw new ConflictException({ code: 'SLUG_TAKEN', message: 'Slug already in use' });
// 409 { statusCode: 409, code: 'SLUG_TAKEN', message: 'Slug already in use', requestId: '…' }
```

- `code` from the body when declared, else from the status (`BAD_REQUEST`, `UNAUTHORIZED`,
  `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `UNPROCESSABLE`, `RATE_LIMITED`,
  `INTERNAL_ERROR`, `UPSTREAM`, `UNAVAILABLE`, otherwise the `HttpStatus` name).
- `ValidationPipe` errors (any body whose `message` is an array, whatever the status) →
  `VALIDATION_FAILED`, `message: 'Validation failed'`, `errors: string[]`.
- Extra fields of the exception body are sent to the client as they are (`errorType`, `logId`, …):
  put in an `HttpException` only what the caller may read. Nest's string `error` label is
  dropped; a structured `error` is kept.
- `retryAfterSeconds: number` becomes a `Retry-After` header and is removed from the body.
- body-parser errors (malformed JSON 400, 413, 415, aborted request) keep their 4xx status;
  `message` is the parser's only when it is meant to be exposed.
- Prisma: `P2002` → 409 `CONFLICT` "Resource already exists"; `P2003` → 409 `CONFLICT`
  "Related resource constraint failed" (raised on delete-in-use and on writes with an unknown
  foreign key: check references first to answer 404); `P2025` → 404 `NOT_FOUND`; any other → 500.
- Anything else → 500 `INTERNAL_ERROR`, generic message; the error and stack go to the log only.
- `@NoTransform()` handlers keep the exception body as is (e.g. terminus' 503 with `details`),
  guard rejections included: the decorator applies its own scoped filter, so it works without
  `TransformInterceptor` too.
- Logs `error` with stack on 5xx, `warn` on 401/403/429 and on an `HttpException` 502/503/504
  (deliberate: queue full, upstream down), nothing on other 4xx (scanner 404s stay silent).
  Log lines carry the route pattern (`GET /albums/shared/:token`, `unmatched`), never the raw
  path. Prisma errors are logged by name, code and stack frames only: their message quotes the
  invocation arguments.
- `requestId` is always present: without `loggerParams`/`setupHttpApp` the filter generates one.

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
`unmatched` for unknown routes; `/health*` is not observed. Requests are observed on `close`, so
the ones the client abandoned (timeout, disconnect) are counted too, with `status="499"`.
`GET /metrics` is served on its own port, outside the Nest router: do not publish it from the
container. With `host` unset it listens on `::` (dual-stack), or `0.0.0.0` where IPv6 is off;
the log line shows the real address. A render is shared for 10 s, so DB-backed gauges
(`collect()`) run at most once per window.

## Outbound webhooks

No Nest dependency: `@heyatom/nest-common/webhooks` uses only Node built-ins.

```ts
import {
  assertPublicWebhookUrl, checkWebhookUrl, isWebhookTargetBlocked, signStandardWebhook,
  webhookAgent, WebhookUrlError,
} from '@heyatom/nest-common/webhooks';

// Save time (PATCH of the webhook URL): https only, no credentials, every DNS answer public.
try {
  await assertPublicWebhookUrl(dto.webhookUrl);
} catch (err) {
  if (err instanceof WebhookUrlError) {
    // `message` is safe for the caller: no host, and one text for "private" and "does not
    // resolve" (otherwise it is an oracle on internal DNS names). The detail goes to the log.
    this.logger.warn(`webhook URL refused: ${err.reason}`); // `reason` is not enumerable: never in a body
    throw new BadRequestException({ code: err.code, message: err.message }); // not `(err)` itself
  }
  throw err;
}

// Send time: textual re-check (literal IPs bypass `lookup`), then the pinned agent.
checkWebhookUrl(target.url); // throws WebhookUrlError → terminal, do not retry
const body = JSON.stringify({ id: delivery.id, type, timestamp, data });
const headers = signStandardWebhook({
  id: delivery.id,
  timestamp: Math.floor(Date.now() / 1000), // at send, not at enqueue
  body,
  secrets: [target.secret, ...(target.previousSecret ? [target.previousSecret] : [])],
});
try {
  await this.http.post(target.url, body, {
    headers: { ...headers, 'Content-Type': 'application/json' },
    httpsAgent: webhookAgent, // every connection resolves through the same public-only rule
    maxRedirects: 0,
    timeout: 10_000,
  });
} catch (err) {
  // The agent's refusal reaches you wrapped by axios (code WEBHOOK_TARGET_BLOCKED, cause =
  // WebhookUrlError), not as a WebhookUrlError: `instanceof` alone would retry the scan.
  if (isWebhookTargetBlocked(err)) return markFailed(delivery); // terminal
  return scheduleRetry(delivery); // network errors, 5xx, timeouts
}
```

- Blocked: RFC 1918, loopback, CGNAT, link-local and cloud metadata (`169.254.169.254`),
  `0/8`, `192.0.0/24`, `198.18/15`, multicast/reserved; IPv6 `::/96`, ULA, link-local,
  multicast, documentation, NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), 6to4 (`2002::/16`);
  IPv4-mapped (`::ffff:10.0.0.1`) is checked against the IPv4 rules; `localhost`, `*.localhost`.
- A hostname with any non-public answer is refused, also at connect time: the address checked
  is the address connected to, so DNS rebinding has no window.
- `{ allowPrivate: true }` (development only) admits private targets and `http://`. Refuse it
  with `NODE_ENV=production` in the config validation.
- For `https.request` pass `agent: webhookAgent`; with a custom agent or `http`, pass
  `lookup: webhookLookup()`.
- With axios set `proxy: false`: otherwise `HTTP(S)_PROXY` env vars route the request through a
  proxy, the agent's `lookup` never sees the target and the guard is bypassed.
- A fixed host allowlist is a valid alternative to the save-time DNS check for services whose
  targets are known in advance.
- `fetch` cannot take an `https.Agent`: use `postWebhook(url, body, headers, { timeoutMs?, policy? })`
  (Node `https`, same pinned lookup, no redirects, 10 s default timeout → `ETIMEDOUT`, response body
  capped at 64 KiB). It returns `{ status, body }` and rethrows errors as is, so
  `isWebhookTargetBlocked(err)` works on them.
- Reasons: `DNS_UNRESOLVED` and `DNS_NON_PUBLIC` never opened a socket and are terminal.
  `DNS_TRANSIENT` (`EAI_AGAIN`, `ETIMEOUT`, `ESERVFAIL`, `ECONNREFUSED`) is a resolver hiccup, not a
  verdict: `isWebhookTargetBlocked()` is `false`, so deliveries retry with backoff. At save time answer
  400 or 503, at the service's choice. All reasons share one public message.
- The pinned lookup honours `options.family` (4/6/`'IPv4'`/`'IPv6'`); every family is still resolved
  and checked first. `hints` and `verbatim` are ignored.

### Signature test vector

Shared with the verifier in `@heyatom/client`: both sides must produce/accept exactly this.
The HMAC key is the secret string as UTF-8 (gatherly's format), not a `whsec_` base64 key.

| Field | Value |
|---|---|
| `id` | `msg_2Kx9a` |
| `timestamp` | `1760529600` |
| `body` | `{"type":"event.created","data":{"id":"evt_1"}}` |
| secret | `whsec-test-current` |
| `webhook-signature` | `v1,+VYotv/AI9wyaA68bMYdRA3RDO8k9+ppDgCTYh6aJJ4=` |
| with rotation (`whsec-test-current`, `whsec-test-previous`) | `v1,+VYotv/AI9wyaA68bMYdRA3RDO8k9+ppDgCTYh6aJJ4= v1,TFAF/sEYytApEv9Zepsa4likR+i80NsV05Wcqt5x/5I=` |

Signed content: `<id>.<timestamp>.<body>`, HMAC-SHA256, base64.
