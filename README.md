# @heyatom/nest-common

Shared HTTP runtime for the HeyAtom NestJS services: pagination, `{ data }` envelope, a global
exception filter, a fail-closed Swagger gate, pino logging with server-side request ids,
Prometheus metrics on a separate port, and outbound webhook helpers (SSRF guard and Standard
Webhooks signing).

```bash
pnpm add @heyatom/nest-common
```

Ships CJS and ESM. Requires Node ≥ 20.19.

## Entry points

| Import | What | Peer deps |
|---|---|---|
| `@heyatom/nest-common` | `PageParams`, `paginate()`, `TransformInterceptor`, `AllExceptionsFilter`, `setupSwagger()`, `loggerParams()`, `setupHttpApp()` | `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `@nestjs/swagger`, `class-validator`, `class-transformer`, `helmet`, `rxjs`, `reflect-metadata`, `nestjs-pino` |
| `@heyatom/nest-common/metrics` | `MetricsModule`, `MetricsService` | `@nestjs/common`, `@prometheus-io/client` (optional peer: install it to use this entry point) |
| `@heyatom/nest-common/webhooks` | `assertPublicWebhookUrl()`, `checkWebhookUrl()`, `isWebhookTargetBlocked()`, `webhookAgent`, `signStandardWebhook()` | none |

The root entry point loads all of its peers at import time, so they are required peers;
`nestjs-pino` (used only for types) and `@prometheus-io/client` are optional.

## Quick start

```ts
// main.ts
const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
app.useLogger(app.get(Logger));
setupHttpApp(app, { trustProxyHops: 1, corsOrigins: ['https://app.example.com'] });
await app.listen(3000);

// app.module.ts
@Module({
  imports: [
    LoggerModule.forRoot(loggerParams({ service: 'my-service', level: 'info' })),
    MetricsModule.forRoot({ app: 'my-service' }),
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
```

## License

MIT
