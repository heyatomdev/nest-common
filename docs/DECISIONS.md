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
| D-010 | Webhook in uscita: guard SSRF + firma Standard Webhooks | Dentro dalla 0.1.0 (revisione 2026-10-15) | `/webhooks` |
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

### Revisione 2026-10-15 — host di default

Gatherly ha notato che `host: '0.0.0.0'` di default faceva ascoltare il server solo su IPv4,
mentre prima i servizi, con `listen(port)`, ascoltavano su `::`. Ora l'host di default non è
impostato e Node usa `::` (dual-stack). `METRICS_HOST` resta disponibile per legare il server a
un'interfaccia precisa.

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

### Revisione 2026-10-15 — serializer e tipo di ritorno

Adottando il package in gatherly sono emersi due problemi.
- Senza serializer custom, pino-http logga tutti gli header della richiesta, compreso
  l'`X-Request-Id` grezzo del client: la validazione di `clientRequestId` non serviva a niente.
- `Params` tipizza `pinoHttp` come un'unione, quindi lo spread suggerito dalla guida d'uso (`docs/usage.md`) richiedeva un
  cast.

La decisione:
- I serializer di default sono minimi: `req.{id, method, url, remoteAddress}` e
  `res.statusCode`, senza header, query né body.
- `serializers` è un'opzione di `loggerParams` per sostituirli (sanitizer degli URL di bastion,
  beacon e fileharbor).
- Il tipo di ritorno è `LoggerParams`, con `pinoHttp` ristretto alle opzioni. Il tipo si ricava
  da `Params`, senza importare pino-http.
- `REDACTED_PATHS` resta, e si applica a quello che un serializer custom tiene.

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

### Revisione 2026-10-15 — `exposedHeaders`

Il CORS non esponeva `X-Request-Id`, quindi un frontend nel browser non poteva leggerlo per
citarlo in una segnalazione. Ora `exposedHeaders` contiene sempre `X-Request-Id`, più
`corsExposedHeaders` per gli header del servizio (dbdbuilds `X-Deploy-Color`).

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

### Revisione 2026-10-15 — TAKEN (0.1.0)

**Date**: 2026-10-15 · **Reference**: api.md §13, richiesta della sessione di analisi approvata dall'utente

#### The problem
La prima versione metteva la firma in `bastion-client`. L'utente ha ridefinito i ruoli dei package:
- `nest-common` è il runtime lato server dei servizi, quindi anche l'**invio** dei webhook;
- `@heyatom/client` (`heyatom-client/`) è l'SDK di chi consuma la piattaforma, quindi la
  **verifica** dei webhook ricevuti;
- `bastion-client` resta solo Bastion.

Oltre alla firma, il codice duplicato è il guard SSRF sull'URL di destinazione, presente in 3
copie con regole diverse:
- bastion `modules/webhooks/webhook-target.ts`;
- gatherly `modules/webhook/webhook-url.ts`;
- herald `modules/newsletter/webhook-url.ts`.

#### The decision
Il subpath `@heyatom/nest-common/webhooks` non dipende da Nest: usa solo i built-in di Node.
- `checkWebhookUrl(url, { allowPrivate? })` fa i controlli testuali: solo https, niente
  credenziali, niente IP letterali privati, niente `localhost`/`*.localhost`. Si chiama al
  salvataggio e prima di ogni invio.
- `assertPublicWebhookUrl(url, { allowPrivate? })` aggiunge il DNS: ogni indirizzo risolto deve
  essere pubblico; una risposta vuota o mancante viene rifiutata. Si usa al salvataggio.
- `webhookLookup(policy)` e `webhookAgent` (https `Agent`) applicano la stessa regola come
  `lookup` del socket. L'indirizzo verificato è quello a cui ci si connette: niente finestra di
  DNS rebinding.
- `isPublicAddress()` e `WebhookUrlError` (`code: 'WEBHOOK_TARGET_BLOCKED'`, terminale per il
  delivery loop).
- `signStandardWebhook({ id, timestamp, body, secrets })` restituisce gli header `webhook-id`,
  `webhook-timestamp` e `webhook-signature`. La firma è `v1,<base64>`, una per secret, separate
  da spazio durante la rotazione. La chiave HMAC è il secret come stringa UTF-8, come fa oggi
  gatherly: compatibile byte per byte (c'è un test dedicato).
- `docs/usage.md` contiene un test vector fisso che `@heyatom/client` riusa per il verificatore.

La **verifica** andrà in `@heyatom/client` in un secondo momento: dbdbuilds-api e gli altri
riceventi non dipendono da nest-common. Bastion passa a questo modulo, e al formato Standard
Webhooks, quando adotta nest-common (fase 2), con l'alias V2 finché `bastion-client/webhooks`
non è aggiornato.

#### On what data
Regole delle 3 copie a confronto. La lista del package è la loro unione più stretta.

| Regola | bastion | gatherly | herald | package |
|---|---|---|---|---|
| IPv4 (0/8, 10/8, CGNAT, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/3) | sì (224/4 + 240/4) | sì | sì | sì |
| IPv6 `::`, `::1` | sì | sì | sì (`::/127`) | `::/96` (copre anche IPv4-compatible `::a.b.c.d`) |
| ULA `fc00::/7`, link-local `fe80::/10` | sì | sì | sì | sì |
| multicast `ff00::/8` | **no** | sì | sì | sì |
| NAT64 `64:ff9b::/96` | **no** | sì | **no** | sì, più `64:ff9b:1::/48` (RFC 8215) |
| 6to4 `2002::/16` | **no** | sì | **no** | sì |
| documentazione `2001:db8::/32` | sì | no | no | sì |
| IPv4-mapped `::ffff:a.b.c.d` | via `BlockList` | via `BlockList` | via `BlockList` | via `BlockList` (testato, anche in forma esadecimale `::ffff:a00:1`) |
| solo https | sì (http con `allowPrivate`) | sì | **no**: http ammesso se `NODE_ENV !== 'production'`, anche con `NODE_ENV` assente | sì (http solo con `allowPrivate`) |
| credenziali nell'URL rifiutate | sì | **no** | **no** | sì |
| `localhost` / `*.localhost` | sì | sì | sì | sì |
| risposta DNS vuota | rifiutata | **accettata** al salvataggio, TypeError su `addresses[0]` all'invio (in pratica `dns.lookup` non risponde vuoto) | rifiutata | rifiutata |
| un indirizzo privato su più → rifiuto | sì | sì | sì | sì |
| indirizzo fissato al connect (anti-rebinding) | sì (`http.request({ lookup })`, primo indirizzo) | sì (`Agent({ lookup })`) | **no**: resolve-then-fetch, finestra di rebinding (ponytail noto) | sì (`webhookLookup` / `webhookAgent`) |
| escape per lo sviluppo | `WEBHOOK_ALLOW_PRIVATE_TARGETS` (rifiutato in prod) | nessuno | http fuori produzione | `allowPrivate` (http + privati); il servizio lo rifiuta in prod |

NAT64 si blocca per intero, anche quando incapsula un IPv4 pubblico (`64:ff9b::8.8.8.8`): come
gatherly, nessun servizio ha destinatari solo NAT64.

#### Cosa non è stato portato
- `postWebhook()` di bastion (client http con timeout, risposta scartata): gatherly usa `@nestjs/axios`
  con `httpsAgent`, quindi basta l'agent. Entra se bastion e herald, adottando il modulo, finiscono
  per scrivere lo stesso wrapper.
- La firma legacy di ciascun servizio (`X-Webhook-Signature` di gatherly, `X-Bastion-Signature-V2`,
  `x-webhook-signature` di articuno, `sha256=` di herald): resta nel servizio finché i consumer non
  sono migrati (piano 01, fase 2).
- Outbox, retry e lease: logica di dominio e schema Prisma diversi per servizio.
- La variante di herald "http ammesso ma privati bloccati": in sviluppo si usa `allowPrivate`.

#### What would change it
Un consumer che richiede chiavi `whsec_` base64 (spec Standard Webhooks completa): si aggiunge
una codifica del secret senza rompere il test vector.

### Revisione 2026-10-15 (2) — dopo l'adozione in gatherly

**Il problema.** Il primo consumer reale, gatherly, ha fatto emergere tre cose.
- `WebhookUrlError` metteva l'host nel `message` e distingueva "resolves to a non-public address"
  da "does not resolve". Un admin di tenant poteva così scoprire quali nomi interni esistono
  (`postgres`, `bastion`…): un oracolo sul DNS interno.
- Il motivo del rifiuto non era disponibile come campo, quindi il servizio non poteva loggarlo
  né mappare i messaggi senza confrontare stringhe.
- I peer della root entry erano obbligatori, quindi chi importa solo `/webhooks` riceveva
  warning su `@nestjs/*` e `helmet`.

**La decisione.**
- `WebhookUrlError.reason` vale `INVALID_URL | NOT_HTTPS | CREDENTIALS_IN_URL |
  NON_PUBLIC_ADDRESS | DNS_NON_PUBLIC | DNS_UNRESOLVED`, ed è quello che finisce nel log.
- `message` non contiene mai l'host. I tre motivi legati all'indirizzo hanno lo stesso testo
  ("target is not publicly reachable"), quindi il `message` si può restituire al chiamante così
  com'è.
- Tutti i peer sono `optional`; README e `docs/usage.md` dicono quali servono per ogni entry point.

Rilascio insieme ai fix trovati adottando il package negli altri servizi.

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

## D-013 · Correzioni dalla review di Fable prima del rilascio — TAKEN

**Date**: 2026-10-15 · **Reference**: review di Fable su `ff13e9e`, adozione in gatherly

### The problem
La review dei fix non ancora rilasciati ha trovato nove punti.
1. I peer erano tutti `optional`, ma la root entry li carica all'import, e pnpm non installa i
   peer opzionali. Un servizio senza `helmet` riceverebbe `Cannot find module` all'avvio, senza
   alcun warning all'installazione.
2. Al momento dell'invio, axios avvolge `WebhookUrlError`: `instanceof` non lo riconosce più e il
   consumer ritenta l'invio, cioè ripete lo scan.
3. Il messaggio di `P2003` ("still referenced") è falso sulle insert con una FK inesistente.
4. `reason` era enumerabile: `new BadRequestException(err)` lo avrebbe messo nel body, e l'oracolo
   DNS si sarebbe riaperto. In più la causa DNS (`ENOTFOUND` vs `EAI_AGAIN`) andava persa.
5. Il log del server metriche diceva `::` anche dopo il fallback su `0.0.0.0`.
6. Le metriche osservavano solo `finish`, quindi le richieste abbandonate dal client non
   venivano contate.
7. Il filter non controllava il tipo di contesto: con ws/rpc `switchToHttp()` esplode.
8. Con `limit: 0`, `paginate` produceva `totalPages: Infinity`, che in JSON diventa `null`.
9. Il package è dichiarato MIT ma il file `LICENSE` mancava.

### The decision
1. I peer della root sono obbligatori; restano opzionali solo `nestjs-pino`, usato solo per i
   tipi, e `@prometheus-io/client`, che serve solo a `/metrics`.
2. Nuovo `isWebhookTargetBlocked(err)`: riconosce l'errore se è un `WebhookUrlError`, se ha
   `code: 'WEBHOOK_TARGET_BLOCKED'` o se lo ha nella catena di `cause`. La guida lo usa come
   condizione terminale.
3. Il messaggio di `P2003` diventa "Related resource constraint failed".
4. `reason` è non enumerabile, e l'errore DNS originale finisce in `cause`.
5. Il log riporta `server.address()`.
6. L'osservazione avviene su `close`; le richieste abbandonate vengono contate con
   `status="499"`.
7. Fuori da HTTP il filter logga e ritorna (`ponytail`: un ramo per trasporto quando servirà).
8. Con `limit <= 0`, `totalPages` vale `0`.
9. Aggiunto il file `LICENSE`, incluso in `files`.

### On what data
Review di Fable (smoke ESM/CJS e DI, pino-http reale, richiesta HTTP reale per il lookup) e
la catch di gatherly in `webhook.service.ts`, che ritentava le consegne bloccate.

### What would change it
Un consumer che importa solo `/webhooks` senza Nest: in quel caso i peer della root tornano
`optional`, con un controllo esplicito all'import.

## D-014 · Bug emersi dall'adozione completa in gatherly — TAKEN

**Date**: 2026-10-15 · **Reference**: report della sessione gatherly; D-002

### The problem
1. **TS2883 nei consumer con TypeScript 6.** Con `module: commonjs`, TS 6 usa per default la
   risoluzione `bundler`: risolve i tipi da `exports.require` ma, per generare la
   dichiarazione, non trova una condizione da cui nominare il tipo.
   - Effetto: un metodo che restituisce `paginate()` senza tipo esplicito non compila con
     `declaration: true` ("cannot be named without a reference to …/dist/cjs").
   - `typesVersions` non c'entra: il problema si riproduce anche senza.
2. **`TransformInterceptor` troppo permissivo.** Lasciava passare qualunque oggetto con `data` e
   `meta`, quindi un'entità con quei due campi usciva senza envelope.

### The decision
1. Ogni entry di `exports` ha, dopo `import`/`require`, un fallback senza condizione
   `types`/`default` sulla build CJS. Gli ESM continuano a risolvere su `import`.
   - `scripts/consumer-types.cjs` (`pnpm test:consumer`, in CI) installa la tarball in un
     consumer pnpm vero e compila le dichiarazioni con `commonjs` (default `bundler`), `node10`,
     `node16` e `nodenext`.
   - Il check è verificato: senza il fallback fallisce su `commonjs`.
2. `paginate()` imposta un marker non enumerabile, `Symbol.for('@heyatom/nest-common/paginated')`,
   che l'interceptor controlla al posto della forma.
   - Questo rivede D-002, che teneva la regola sulla forma per non wrappare due volte i
     `{ data, meta }` costruiti a mano durante la fase 2. Oggi gatherly passa sempre da
     `paginate()`; chi costruisce ancora le liste a mano deve migrare insieme all'adozione.

### On what data
Riprodotto in un consumer pnpm pulito con TS 6.0.3 e `@heyatom/nest-common@0.1.1`. Fix verificato
con la tarball locale nei 4 modi di risoluzione. Gatherly non ha `{ data, meta }` costruiti a mano
né spread di `paginate()`.

### What would change it
Se TS 6 corregge la generazione degli specifier in modalità `bundler`, il fallback diventa
superfluo, ma resta innocuo.
