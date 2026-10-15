---
type: decision
service: nest-common
status: done
updated: 2026-10-15
verified: initial
---

# Decisions — @heyatom/nest-common

Scope di fase 1 del [piano 01 — adozione standard API](../../docs/platform/plans/01-api-standards.md),
concordato il 2026-10-15 tra la sessione di implementazione e una review di Fable sul codice dei
servizi (copie contate con `command grep` su bastion, herald, gatherly, fileharbor, beacon,
articuno, shelfie-api, dbdbuilds-api, nestjs-prisma-template). Standard di riferimento:
[`docs/standards/api.md`](../../docs/standards/api.md).

Regole di partenza:
1. Entra solo ciò che è già copiato in 2+ servizi o che lo standard impone a tutti.
2. Niente astrazioni speculative, niente opzioni che nessun servizio usa.
3. Nessuna sovrapposizione con `@heyatom/bastion-client` (`@Public()`, guard, audit).

## Riepilogo

| # | Pezzo | Esito | Export |
|---|---|---|---|
| D-001 | `PageParams` / `paginate()` / `PageMetaDto` / `ApiPaginatedResponse()` | Dentro | root |
| D-002 | `TransformInterceptor` + `@NoTransform()` | Dentro | root |
| D-003 | `AllExceptionsFilter` con mapping Prisma | Dentro | root |
| D-004 | `swaggerEnabled()` + `createOpenApiDocument()` / `setupSwagger()` + `readAppVersion()` | Dentro | root |
| D-005 | `MetricsModule` (server separato, middleware, histogram) | Dentro | `/metrics` |
| D-006 | `HealthModule` | Fuori | — |
| D-007 | `loggerParams()` + request-id | Dentro | root |
| D-008 | `setupHttpApp()` | Dentro (minimo) | root |
| D-009 | Idempotency interceptor | Più avanti | — |
| D-010 | Firma Standard Webhooks | Più avanti, in `bastion-client/webhooks` | — |
| D-011 | Throttler guard per utente | Fuori | — |
| D-012 | Niente Prisma tra le peer dependency | Presa | — |

---

## D-001 · Paginazione nel package — TAKEN

**Date**: 2026-10-15 · **Reference**: api.md §1

### The problem
`common/pagination.ts` è copiato in 8 servizi (bastion, herald, gatherly, fileharbor, beacon,
articuno, dbdbuilds-api, template). `PageParams`/`paginate` sono identici byte per byte; bastion
esporta in più `PageMetaDto`, articuno `ApiPaginatedResponse()`, beacon un `@Max(10_000)` su `page`.

### The decision
Si spediscono `PageParams`, `paginate()`, `PaginatedResult`, `PageMeta`, `PageMetaDto`,
`ApiPaginatedResponse(item?, description?)`. `paginate()` accetta `Pick<PageParams,'page'|'limit'>`.
Fuori: il `@Max(10_000)` di beacon (resta locale con un override del campo), helper per
`IntersectionType`.

### On what data
8 copie, zero divergenze nella logica.

### What would change it
Introduzione della cursor pagination (oggi nessun servizio la espone).

## D-002 · Envelope `{ data }` e `@NoTransform()` — TAKEN

**Date**: 2026-10-15 · **Reference**: api.md §2

### The problem
6 copie di `TransformInterceptor` in due famiglie: herald (con `Reflector` + `@NoTransform()`,
wrappa tutto) e 5 identiche (gatherly, beacon, shelfie, dbdbuilds-api, template) senza decoratore
e con pass-through euristico di `null` e `{ data, meta }`.

### The decision
Una sola classe: `@NoTransform()` (handler o controller) + pass-through di `null`/`undefined` e di
`{ data, meta }`. L'euristica `{ data, meta }` resta: costa una riga ed evita il doppio wrapping
delle liste paginate nei 5 servizi durante la fase 2. Solo contesto `http`.

### On what data
6 copie; §2 impone il decoratore.

### What would change it
Un'entità di dominio con campi `data` e `meta` restituita nuda: allora `paginate()` marca il
risultato con un brand al posto dell'euristica.

## D-003 · Exception filter globale — TAKEN

**Date**: 2026-10-15 · **Reference**: api.md §3, piano 01 bug 0.1

### The problem
4 filter (articuno, fileharbor, herald, template) + `apiError()` di beacon + `toHttpError` di
dbdbuilds. Nessuno emette `code` né `requestId`; fileharbor fa `return` senza rispondere su 3 rami
(request appese); articuno e fileharbor portano una lista di ~60 regex per declassare il rumore
degli scanner.

### The decision
`AllExceptionsFilter`, `@Catch()` senza argomenti, nessuna opzione. Ogni ramo risponde (anche con
`headersSent` chiude la risposta).
- `HttpException` → `{ statusCode, code, message, errors?, requestId, ...extra }`. I campi extra
  del body (herald `errorType`, `correlationId`, `logId`) passano; `error` di Nest cade.
  `code` dal body se presente, altrimenti dallo status (tabella §3, fallback sul nome
  `HttpStatus`). Un `message` array di `ValidationPipe` diventa `VALIDATION_FAILED` + `errors`.
- `retryAfterSeconds` numerico nel body → header `Retry-After` (herald, fileharbor `RenderBusy`).
- Handler `@NoTransform()` → body dell'eccezione invariato (503 di terminus con `details`). Nest
  non passa handler e classe all'`ArgumentsHost` dei filter: il flag lo mette sulla request il
  `TransformInterceptor`, quindi i due vanno registrati insieme.
- Prisma: `P2002`/`P2003` → 409 `CONFLICT`, `P2025` → 404 `NOT_FOUND`, altri → 500.
- Tutto il resto → 500 `INTERNAL_ERROR` generico; stack solo nel log.
- Log: `error` sui 5xx con stack, `warn` su 401/403/429, niente sugli altri 4xx.

**Fuori**: la lista regex degli scanner. Esisteva solo perché articuno/fileharbor loggavano ogni
eccezione a `error`; se i 404 non si loggano non c'è niente da declassare. Fuori anche
`uniqueViolationTarget()` di bastion: la usa solo bastion.

### On what data
4 filter + 2 helper; bug 0.1; 47 punti di catch Prisma confrontano `code` come stringa.

### What would change it
Un secondo servizio che deve leggere il nome del vincolo di un `P2002` → `uniqueViolationTarget()` entra.

## D-004 · Swagger: gate, documento condiviso, versione — TAKEN

**Date**: 2026-10-15 · **Reference**: api.md §4, piano 01 bug 0.3, 0.4

### The problem
Solo bastion ha il gate corretto (`config.validation.ts:378`); 7 servizi usano
`NODE_ENV !== 'production'` (Swagger acceso se `NODE_ENV` manca), herald `=== 'development'`.
La versione è in 3 `version.ts` identici (`require('../../package.json')`), 2 `app-version.ts`
basati su `cwd`, 4 stringhe scritte a mano. Il `DocumentBuilder` è scritto due volte nei servizi
con `openapi:dump` e diverge già (articuno: `npm_package_version || '2.0.0'` nel dump).

### The decision
- `swaggerEnabled({ ENABLE_SWAGGER, NODE_ENV })`: esplicito vince, altrimenti acceso solo con
  `development`/`test`.
- `createOpenApiDocument(app, { title, version, description?, configure? })`, usato da
  `setupSwagger()` e dallo script `openapi:dump`. `configure: (b) => b.addBearerAuth()` copre gli
  schemi di auth senza altre opzioni.
- `setupSwagger(app, opts)`: UI su `/docs`, JSON su `/docs-json`.
- `readAppVersion(dir)`: il servizio passa la cartella del suo `package.json`; `version` resta
  obbligatoria (il package non può trovare da solo il `package.json` del servizio).

**Disaccordo risolto**: Fable proponeva `setupSwagger()` fuori (9 catene `DocumentBuilder` diverse,
nessuna duplicazione). Dentro, perché §4 rende `openapi:dump` obbligatorio in tutti i servizi:
senza un builder condiviso ogni servizio avrebbe la catena due volte, e articuno diverge già.

### On what data
8 gate sbagliati; 2 servizi con dump già divergente.

### What would change it
—

## D-005 · Metriche — TAKEN

**Date**: 2026-10-15 · **Reference**: api.md §5

### The problem
7 copie (bastion, herald, gatherly, fileharbor, beacon, articuno, dbdbuilds-api).
Middleware identico; server identico tranne bastion (`METRICS_HOST` + cache dello scrape di 10s) e
fileharbor (chiave Joi `metricsPort`). Ogni servizio mette le metriche di dominio nella stessa
classe `MetricsService` (12 consumer).

### The decision
Subpath `@heyatom/nest-common/metrics` (peer `@prometheus-io/client` opzionale: shelfie e template
non lo hanno ancora).
`MetricsModule.forRoot({ app, port?, host? })` / `forRootAsync(...)` (ConfigurableModuleBuilder,
niente peer `@nestjs/config`), `@Global`, applica da solo `MetricsMiddleware` a `'*'`.
`MetricsService` espone `registry` (label `app`, default metrics) e `httpRequestDuration`; le
metriche di dominio restano nel servizio e si registrano su `registry`. Server con la versione di
bastion (host, cache scrape, nessuna cache di un render fallito).
**Fuori**: helper per gauge lazy (solo fileharbor `lazyGauge`).

**Disaccordo risolto**: Fable proponeva che ogni servizio applicasse il middleware e che il server
leggesse `METRICS_PORT` da `ConfigService`. Il middleware si auto-applica (una riga in meno per
servizio, impossibile dimenticarlo); il middleware di un modulo importato gira prima di quello
dell'`AppModule` (secondo Fable; da verificare all'adozione in articuno, dove `MetricsMiddleware`
deve restare esterno a `TenantMiddleware`). Porta e host arrivano da `forRootAsync`.

L'esclusione di `/health*` legge `req.originalUrl`, non `req.path`: il test e2e su una vera app Nest
e una prova isolata (Nest 11, `forRoutes('*')`) mostrano che nel middleware `req.path` e `req.url`
valgono `/`: le copie attuali (`req.path.startsWith('/health')`) non escludono niente e registrano
i probe nel histogram. Si corregge adottando il package (fase 2).

### On what data
7 copie, 2 divergenze minori.

### What would change it
—

## D-006 · HealthModule — DROPPED

**Date**: 2026-10-15 · **Reference**: api.md §6

### The problem
9 controller health quasi identici, ma: `@Public()` da 3 fonti diverse, articuno senza `@Public()`
(guard `X-API-Key` proprio), fileharbor con `StorageHealthIndicator`, dbdbuilds con
`/health/version`, `PrismaService` diverso per servizio.

### The decision
Resta locale (~20 righe). Un controller nel package richiederebbe `bastion-client` come peer solo
per `@Public()` (sbagliato per articuno) e un token `READY_CHECKS` con factory, lungo quanto il
controller che sostituisce. I bug legati agli health (log, metriche) si risolvono in D-005 e D-007.

**Disaccordo risolto**: Fable lo proponeva dentro (sottile, con `READY_CHECKS`); ha poi concordato.

### On what data
9 copie; i punti di divergenza sono esattamente auth e indicator.

### What would change it
Tutti i servizi sulla stessa chiave di metadata per `@Public()`.

## D-007 · Logging pino e request-id — TAKEN

**Date**: 2026-10-15 · **Reference**: api.md §7, piano 01 bug 0.5, 0.6, 0.8

### The problem
`clientRequestId()` identico in bastion e beacon. 4 servizi (gatherly, shelfie, dbdbuilds,
template) hanno lo stesso `RequestIdMiddleware` bacato (header del client usato come id e
rimandato). Le opzioni pino sono 9 varianti delle stesse ~25 righe; 3 ignorano `=== '/health'`
(non esclude niente). Nessun servizio mette `X-Request-Id` in risposta.

### The decision
`loggerParams({ service, level, pretty?, redact? })` → `Params` di nestjs-pino: livello e
`pretty` passati dal servizio (niente logica su `NODE_ENV` nel package), redact con `remove` sui 5
header di §7 + extra, `genReqId`, `customProps` con `clientRequestId`, `autoLogging.ignore` con
`startsWith('/health')`. Serializer specifici (sanitizer URL di bastion/beacon/fileharbor) restano
nel servizio con uno spread.
`genReqId(req, res)` genera l'UUID **e** imposta l'header `X-Request-Id` di risposta: un solo
pezzo, impostato prima di guard e filter, impossibile dimenticarlo. Niente `RequestIdMiddleware`.

**Disaccordi risolti**: Fable proponeva un `RequestIdMiddleware` separato per l'header e
`pretty` derivato da `nodeEnv !== 'production'` (stessa trappola del gate Swagger). Ha concordato
su entrambi.

### On what data
Bug 0.5, 0.6, 0.8; 9 varianti di config.

### What would change it
Tracing distribuito (OpenTelemetry): il request-id diventa il trace id.

## D-008 · `setupHttpApp()` minimo — TAKEN

**Date**: 2026-10-15 · **Reference**: api.md §8, piano 01 bug 0.2, 0.2b, 0.7, 0.11

### The problem
9 `main.ts` tutti diversi, ma con gli stessi bug: CORS con `callback(new Error())` (4 servizi),
`trust proxy` assente o fisso (6), `helmet` assente (2), body limit implicito.

### The decision
`setupHttpApp(app, { trustProxyHops, corsOrigins, corsAllowedHeaders?, jsonBodyLimit? })`:
shutdown hooks, `trust proxy`, `helmet()`, CORS con `callback(null, false)`, body JSON (default
`1mb`), `ValidationPipe` di §8. Più `parseCorsOrigins()`. Bastion passa `trustProxyHops: 0`.
**Fuori**: prefisso globale, `rawBody` (opzione di `NestFactory.create`), cookie-parser, Swagger,
interceptor e filter (sono provider `APP_*`).

### On what data
Bug comuni a 7 servizi.

### What would change it
—

## D-009 · Idempotency interceptor — DEFERRED

**Date**: 2026-10-15 · **Reference**: api.md §12

### The problem
Una sola implementazione vera (gatherly, legata al modello Prisma `IdempotencyKey` e a
`req.client.id`). Herald ha un design diverso (la riga `MailLog` fa da lock, senza hash del body).

### The decision
Più avanti. Nel package servirebbe un'interfaccia di storage più una migrazione per ogni adottante,
e oggi non c'è un secondo consumer.

### On what data
1 copia + 1 design diverso.

### What would change it
La correzione del known issue di herald (fase 2): a quel punto due servizi condividono la stessa
semantica e l'interceptor entra con uno storage astratto.

## D-010 · Firma Standard Webhooks — DEFERRED

**Date**: 2026-10-15 · **Reference**: api.md §13

### The problem
4 formati: gatherly Standard Webhooks (2 righe), bastion `signV2()` multi-secret, articuno hex sul
body, herald `sha256=`. `bastion-client/webhooks` oggi verifica solo il formato di bastion.

### The decision
Non in nest-common: `signStandardWebhook()` / `verifyStandardWebhook()` vanno in
`@heyatom/bastion-client/webhooks` quando bastion migra (fase 2), accanto al verificatore
esistente. I riceventi (dbdbuilds-api) devono poter verificare senza dipendere da nest-common.

### On what data
1 implementazione conforme di 2 righe; il lavoro vero (outbox, rotazione) è per servizio.

### What would change it
—

## D-011 · Throttler guard per utente — DROPPED

**Date**: 2026-10-15 · **Reference**: api.md §8

### The problem
beacon `UserThrottlerGuard` (verifica il JWT da sé), gatherly e articuno `AdminThrottlerGuard`
(6 righe identiche su `req.adminUser.sub`), bastion `AppThrottlerGuard` (IP da proxy fidati).

### The decision
Resta locale: l'identità viene da campi diversi in ogni servizio (`req.user`, `req.adminUser`,
`req.client`); un'opzione `keyFrom(req)` sarebbe chiamata in modo diverso da ognuno.

### On what data
3 fonti d'identità diverse; l'unica coppia identica è di 6 righe.

### What would change it
Un'identità normalizzata su `req` fornita da `bastion-client`.

## D-012 · Nessuna peer dependency su Prisma — TAKEN

**Date**: 2026-10-15 · **Reference**: D-003

### The problem
Il brief prevedeva Prisma 7 come peer opzionale per filter e health. Ogni servizio genera il
proprio client: non c'è una classe condivisa per `instanceof`.

### The decision
Il filter riconosce gli errori Prisma per duck typing (`name === 'PrismaClientKnownRequestError'`
+ `code` stringa), stabile su Prisma 5–7 e driver adapter. Health è fuori (D-006). Quindi nessuna
dipendenza da Prisma.

### On what data
47 catch esistenti confrontano già `code` come stringa.

### What would change it
Prisma che rinomina la classe d'errore.
