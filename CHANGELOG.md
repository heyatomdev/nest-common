# Changelog

## 0.3.0

Fixes the issues reported by the services (N1–N26). Remove the `TODO(nest-common)` workarounds
after upgrading.

### Breaking

- `retryAfterSeconds` is no longer in the error body: it is sent only as the `Retry-After`
  header. Clients reading the field must read the header.
- `loggerParams().pinoHttp.customProps` no longer returns `service`: it moved to pino's `base`,
  so every line carries it, also outside requests. Code spreading `customProps` keeps it only
  through `base`.
- `@NoTransform()` now also applies a scoped catch-all exception filter (guard rejections keep
  their body). It shadows the controller's `@UseFilters()` on that handler: use
  `@NoTransform({ filter: false })` where a service filter must still apply (e.g. OAuth error
  filters).
- `corsOrigins` type is now `'*' | string[]`; a `'*'` entry means any origin without credentials.

### Fixed

- Exception filter: body-parser errors (malformed JSON, 413, 415, aborted) keep their 4xx; logs
  carry the route pattern instead of the raw path; Prisma errors are logged without their message;
  a structured `error` field is kept; HttpException 502/503/504 are logged as `warn` without stack;
  `VALIDATION_FAILED` for any validation array; `requestId` always present.
- Request id assigned before the body parser by `setupHttpApp`.
- Webhooks: `DNS_TRANSIENT` (retryable) separate from `DNS_UNRESOLVED`; `webhookLookup` honours
  `family`.
- `readAppInfo()` walks up to the first package.json with a `version`.

### Added

- `postWebhook()` for `fetch` users; `markPaginated()`; `readAppInfo()`; `setupHttpApp` options
  `helmet` and `urlencodedBodyLimit`; `swaggerEnabled(env, devEnvs)`; `serializers.err`.
