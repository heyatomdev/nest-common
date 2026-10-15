import {
  ConfigurableModuleBuilder,
  Global,
  Inject,
  Injectable,
  Logger,
  type MiddlewareConsumer,
  Module,
  type NestMiddleware,
  type NestModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { collectDefaultMetrics, Histogram, Registry } from '@prometheus-io/client';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface MetricsOptions {
  /** Service slug: default label `app=<slug>`. */
  app: string;
  /** `METRICS_PORT`, default 9091. 0 picks a free port (tests). */
  port?: number;
  /** `METRICS_HOST`, default `0.0.0.0` (container). */
  host?: string;
}

export const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN: METRICS_OPTIONS,
} = new ConfigurableModuleBuilder<MetricsOptions>().setClassMethodName('forRoot').build();

/**
 * Own `Registry` (not the global one), so a service built per test never collides.
 * Domain metrics register on `registry` with the `<slug>_` prefix (api.md §5);
 * DB-backed gauges compute lazily in `collect()` and keep the last value on failure.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly httpRequestDuration: Histogram<'method' | 'route' | 'status'>;

  constructor(@Inject(METRICS_OPTIONS) opts: MetricsOptions) {
    this.registry.setDefaultLabels({ app: opts.app });
    collectDefaultMetrics({ register: this.registry });
    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
  }
}

type RoutedRequest = IncomingMessage & { originalUrl?: string; route?: { path?: string } };

/**
 * Observes `http_request_duration_seconds`. A middleware, not an interceptor:
 * guard and throttler rejections (401/403/429) never reach an interceptor.
 * `route` is the Nest pattern, `unmatched` when no route matched; `/health*` is skipped.
 */
@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  use(req: RoutedRequest, res: ServerResponse, next: () => void): void {
    // originalUrl: `req.path`/`req.url` are relative to the mount point Nest gives the middleware.
    if ((req.originalUrl ?? req.url ?? '').startsWith('/health')) return next();
    // Nest mounts middleware as a catch-all route, so `req.route` is already that
    // catch-all here and stays so when no controller matches.
    const mountRoute = req.route;
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const matched = req.route;
      const route = (matched !== mountRoute ? matched?.path : undefined) ?? 'unmatched';
      this.metrics.httpRequestDuration.observe(
        { method: req.method ?? 'UNKNOWN', route, status: String(res.statusCode) },
        Number(process.hrtime.bigint() - start) / 1e9,
      );
    });
    next();
  }
}

/**
 * `GET /metrics` on its own port, outside the Nest router: no guards, no CORS, no
 * route on the public port. Isolation is the network's job (api.md §5). One render is
 * shared for `SCRAPE_CACHE_MS`, bounding the DB load of lazy gauges.
 */
@Injectable()
export class MetricsServer implements OnApplicationBootstrap, OnApplicationShutdown {
  static readonly SCRAPE_CACHE_MS = 10_000;
  private readonly logger = new Logger(MetricsServer.name);
  private server: Server | undefined;
  private scrape: { body: Promise<string>; at: number } | undefined;

  constructor(
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(METRICS_OPTIONS) private readonly opts: MetricsOptions,
  ) {}

  private render(): Promise<string> {
    const now = Date.now();
    if (!this.scrape || now - this.scrape.at >= MetricsServer.SCRAPE_CACHE_MS) {
      const body = this.metrics.registry.metrics();
      this.scrape = { body, at: now };
      // A failed render must not be served until the cache expires.
      body.catch(() => {
        if (this.scrape?.body === body) this.scrape = undefined;
      });
    }
    return this.scrape.body;
  }

  onApplicationBootstrap(): Promise<void> {
    const port = this.opts.port ?? 9091;
    const host = this.opts.host ?? '0.0.0.0';
    const server = createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      this.render().then(
        (body) => res.writeHead(200, { 'Content-Type': this.metrics.registry.contentType }).end(body),
        (err: unknown) => {
          this.logger.error(`metrics scrape failed: ${err instanceof Error ? err.message : String(err)}`);
          res.writeHead(500).end();
        },
      );
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject).listen(port, host, () => {
        this.logger.log(`metrics listening on ${host}:${this.port}`);
        resolve();
      });
    });
  }

  onApplicationShutdown(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Bound port — tests listen on 0 and read the real one back. */
  get port(): number | undefined {
    const addr = this.server?.address();
    return typeof addr === 'object' && addr ? addr.port : undefined;
  }
}

/**
 * `MetricsModule.forRoot({ app })` / `.forRootAsync({ inject: [ConfigService], useFactory })`.
 * Global, so domain modules inject `MetricsService`; applies `MetricsMiddleware` to every route itself.
 */
@Global()
@Module({
  providers: [MetricsService, MetricsServer, MetricsMiddleware],
  exports: [MetricsService],
})
export class MetricsModule extends ConfigurableModuleClass implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(MetricsMiddleware).forRoutes('*');
  }
}
