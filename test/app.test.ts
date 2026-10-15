import 'reflect-metadata';
import {
  BadRequestException,
  type ArgumentsHost,
  Body,
  CanActivate,
  Catch,
  type ExceptionFilter,
  UseFilters,
  ConflictException,
  Logger,
  UnauthorizedException,
  UseGuards,
  Controller,
  Get,
  HttpCode,
  Module,
  Post,
  Query,
  ServiceUnavailableException,
  HttpException,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IsString } from 'class-validator';
import { LoggerModule } from 'nestjs-pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AllExceptionsFilter,
  loggerParams,
  NoTransform,
  PageParams,
  paginate,
  setupHttpApp,
  TransformInterceptor,
} from '../src';
import { MetricsModule, MetricsServer } from '../src/metrics';

class CreateDto {
  @IsString()
  name!: string;
}

const prismaError = (code: string) =>
  Object.assign(new Error(`prisma ${code}`), { name: 'PrismaClientKnownRequestError', code });

class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException({ status: 'denied' });
  }
}

class DomainError extends Error {}

@Catch(DomainError)
class DomainFilter implements ExceptionFilter {
  catch(_e: DomainError, host: ArgumentsHost) {
    host.switchToHttp().getResponse<{ status(n: number): { json(b: unknown): void } }>().status(418).json({ custom: true });
  }
}

@Controller('raw-class')
@NoTransform()
class RawClassController {
  @Get()
  item() {
    return { raw: true };
  }

  @Get('guarded')
  @UseGuards(DenyGuard)
  guarded() {
    return {};
  }
}

@Controller('filtered')
@UseFilters(DomainFilter)
class FilteredController {
  @Get()
  @NoTransform({ filter: false })
  item() {
    throw new DomainError();
  }
}

@Controller()
class TestController {
  @Get('item')
  item() {
    return { id: '1' };
  }

  @Get('list')
  list(@Query() q: PageParams) {
    return paginate([q.skip], 45, q);
  }

  @Get('shaped')
  shaped() {
    return { data: 'payload', meta: 'not a page' }; // an entity that happens to have these fields
  }

  @Get('list-extra')
  listExtra(@Query() q: PageParams) {
    const page = paginate([1], 1, q);
    Object.assign(page.meta, { statusCounts: { DRAFT: 1 } }); // extra fields go inside meta
    return page;
  }

  @Get('empty')
  @HttpCode(204)
  empty() {}

  @Get('raw')
  @NoTransform()
  raw() {
    return { keys: [] };
  }

  @Post('items')
  create(@Body() dto: CreateDto) {
    return dto;
  }

  @Get('conflict')
  conflict() {
    throw new ConflictException({ code: 'SLUG_TAKEN', message: 'Slug already in use' });
  }

  @Get('plain-400')
  plain400() {
    throw new BadRequestException();
  }

  @Get('busy')
  busy() {
    throw new HttpException({ message: 'busy', retryAfterSeconds: 7 }, 429);
  }

  @Get('prisma/:code')
  prisma(@Query('x') _x: string) {
    throw prismaError('P2002');
  }

  @Get('p2003')
  p2003() {
    throw prismaError('P2003');
  }

  @Get('p2025')
  p2025() {
    throw prismaError('P2025');
  }

  @Get('p9999')
  p9999() {
    throw prismaError('P9999');
  }

  @Get('boom')
  boom() {
    throw new Error('secret SQL: SELECT * FROM users');
  }

  @Get('throw-string')
  throwString() {
    throw 'not an error';
  }

  @Get('throw-null')
  throwNull() {
    throw null;
  }

  @Get('async-boom')
  async asyncBoom() {
    await Promise.resolve();
    throw new TypeError('x is undefined');
  }

  @Get('health/ready')
  @NoTransform()
  ready() {
    throw new ServiceUnavailableException({ status: 'error', details: { database: { status: 'down' } } });
  }

  @Get('raw-guarded')
  @NoTransform()
  @UseGuards(DenyGuard)
  rawGuarded() {
    return { never: true };
  }

  @Get('render-busy')
  renderBusy() {
    throw new ServiceUnavailableException({ message: 'renderer queue full', retryAfterSeconds: 3 });
  }

  @Get('shared/:token')
  shared() {
    throw new UnauthorizedException();
  }

  @Get('prisma-validation')
  prismaValidation() {
    throw Object.assign(new Error('Invalid `prisma.user.create()` invocation: { passwordHash: "secret-hash" }'), {
      name: 'PrismaClientValidationError',
    });
  }

  @Get('axios-like')
  axiosLike() {
    // An upstream 502 surfacing as AxiosError: `status` is the upstream's, no `expose`/`statusCode`.
    throw Object.assign(new Error('Request failed with status code 502'), { name: 'AxiosError', status: 502 });
  }

  @Get('users/:id')
  user() {
    return { ok: true };
  }
}

@Module({
  imports: [
    LoggerModule.forRoot(loggerParams({ service: 'test', level: 'silent' })),
    MetricsModule.forRootAsync({ useFactory: () => ({ app: 'test', port: 0, host: '127.0.0.1' }) }),
  ],
  controllers: [TestController, RawClassController, FilteredController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
class AppModule {}

let app: NestExpressApplication;
let base: string;
let metricsBase: string;

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  setupHttpApp(app, { trustProxyHops: 0, corsOrigins: ['https://ok.test'], corsAllowedHeaders: ['Idempotency-Key'] });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  metricsBase = `http://127.0.0.1:${app.get(MetricsServer).port}`;
});

afterAll(() => app.close());

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(2000) });
const json = async (path: string) => {
  const res = await get(path);
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, res };
};

describe('envelope', () => {
  it('wraps a single resource in { data }', async () => {
    expect((await json('/item')).body).toEqual({ data: { id: '1' } });
  });

  it('leaves a paginate() result as { data, meta }', async () => {
    expect((await json('/list?page=2&limit=10')).body).toEqual({
      data: [10],
      meta: { total: 45, page: 2, limit: 10, totalPages: 5 },
    });
  });

  it('wraps an entity that merely has data and meta fields', async () => {
    expect((await json('/shaped')).body).toEqual({ data: { data: 'payload', meta: 'not a page' } });
  });

  it('keeps the marker when extra fields are added to meta', async () => {
    expect((await json('/list-extra')).body).toMatchObject({ data: [1], meta: { statusCounts: { DRAFT: 1 } } });
  });

  it('sends 204 with no body', async () => {
    const res = await get('/empty');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('skips @NoTransform() handlers', async () => {
    expect((await json('/raw')).body).toEqual({ keys: [] });
  });
});

describe('exception filter', () => {
  it('always responds, with code and requestId matching the response header', async () => {
    const paths = ['/boom', '/throw-string', '/throw-null', '/async-boom', '/nope', '/p9999'];
    for (const path of paths) {
      const { status, body, res } = await json(path);
      expect(status, path).toBeGreaterThanOrEqual(400);
      expect(typeof body.code, path).toBe('string');
      expect(body.requestId, path).toBe(res.headers.get('x-request-id'));
    }
  });

  it('hides internal error details behind INTERNAL_ERROR', async () => {
    const { status, body } = await json('/boom');
    expect(status).toBe(500);
    expect(body).toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' });
    expect(JSON.stringify(body)).not.toContain('SQL');
  });

  it('maps unknown routes to NOT_FOUND', async () => {
    expect((await json('/nope')).body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('maps Prisma errors (P2002/P2003 → 409, P2025 → 404, others → 500)', async () => {
    expect((await json('/prisma/x')).body).toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    expect((await json('/p2003')).body).toMatchObject({ statusCode: 409, code: 'CONFLICT', message: 'Related resource constraint failed' });
    expect((await json('/p2025')).body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect((await json('/p9999')).body).toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR' });
  });

  it('keeps a domain code', async () => {
    expect((await json('/conflict')).body).toMatchObject({ statusCode: 409, code: 'SLUG_TAKEN', message: 'Slug already in use' });
  });

  it('derives the code from the status when none is declared', async () => {
    const { body } = await json('/plain-400');
    expect(body).toMatchObject({ statusCode: 400, code: 'BAD_REQUEST', message: 'Bad Request' });
    expect(body).not.toHaveProperty('error');
  });

  it('turns ValidationPipe errors into VALIDATION_FAILED + errors[]', async () => {
    const res = await fetch(`${base}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 1, extra: true }),
    });
    const body = (await res.json()) as { code: string; message: string; errors: string[] };
    expect(res.status).toBe(400);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.message).toBe('Validation failed');
    expect(body.errors).toEqual(expect.arrayContaining(['property extra should not exist', 'name must be a string']));
  });

  it('rejects an out-of-range page param', async () => {
    expect((await json('/list?limit=500')).status).toBe(400);
  });

  it('turns retryAfterSeconds into a Retry-After header, not a body field', async () => {
    const { status, res, body } = await json('/busy');
    expect(status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(body).not.toHaveProperty('retryAfterSeconds');
  });

  it('maps body-parser errors (malformed JSON, too large) to their 4xx with a requestId', async () => {
    const post = (body: string) =>
      fetch(`${base}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const bad = await post('{"email":');
    const badBody = (await bad.json()) as Record<string, unknown>;
    expect(bad.status).toBe(400);
    expect(badBody).toMatchObject({ statusCode: 400, code: 'BAD_REQUEST' });
    expect(badBody.requestId).toBe(bad.headers.get('x-request-id'));
    expect(badBody.requestId).toMatch(/^[0-9a-f-]{36}$/);

    const big = await post(JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024) }));
    const bigBody = (await big.json()) as Record<string, unknown>;
    expect(big.status).toBe(413);
    expect(bigBody).toMatchObject({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
    expect(bigBody.requestId).toBe(big.headers.get('x-request-id'));
  });

  it('keeps an upstream status on a non-http-errors error as 500 (AxiosError shape)', async () => {
    expect((await json('/axios-like')).body).toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR' });
  });

  it('applies @NoTransform() on a whole controller, guard rejections included', async () => {
    expect((await json('/raw-class')).body).toEqual({ raw: true });
    const { status, body } = await json('/raw-class/guarded');
    expect(status).toBe(401);
    expect(body).toEqual({ status: 'denied' });
  });

  it('leaves the controller filters in charge with @NoTransform({ filter: false })', async () => {
    const { status, body } = await json('/filtered');
    expect(status).toBe(418);
    expect(body).toEqual({ custom: true });
  });

  it('keeps the body of a guard rejection on @NoTransform() handlers', async () => {
    const { status, body } = await json('/raw-guarded');
    expect(status).toBe(401);
    expect(body).toEqual({ status: 'denied' });
  });

  it('logs route patterns, never raw paths; deliberate 503 as warn without stack; Prisma args never', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await json('/shared/tok-secret-123');
      await json('/render-busy');
      await json('/prisma-validation');
      const lines = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
      expect(lines).not.toContain('tok-secret-123');
      expect(lines).toContain('401 GET /shared/:token');
      expect(warn.mock.calls.some(([m]) => String(m).startsWith('503 GET /render-busy'))).toBe(true);
      expect(error.mock.calls.some(([m]) => String(m).includes('render-busy'))).toBe(false);
      expect(lines).toContain('PrismaClientValidationError');
      expect(lines).not.toContain('secret-hash');
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('passes the exception body through on @NoTransform() handlers', async () => {
    const { status, body } = await json('/health/ready');
    expect(status).toBe(503);
    expect(body).toEqual({ status: 'error', details: { database: { status: 'down' } } });
  });
});

describe('request id', () => {
  it('never reflects the caller X-Request-Id', async () => {
    for (const caller of ['valid-id', 'evil\tvalue']) {
      const res = await get('/item', { 'X-Request-Id': caller });
      const id = res.headers.get('x-request-id');
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(id).not.toBe(caller);
    }
  });
});

describe('http setup', () => {
  it('answers a disallowed CORS origin without CORS headers instead of a 500', async () => {
    const res = await get('/item', { Origin: 'https://evil.test' });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows a listed origin and the custom headers', async () => {
    const res = await fetch(`${base}/items`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://ok.test', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://ok.test');
    expect(res.headers.get('access-control-allow-headers')).toContain('Idempotency-Key');
  });

  it('lets browsers read X-Request-Id', async () => {
    const res = await get('/item', { Origin: 'https://ok.test' });
    expect(res.headers.get('access-control-expose-headers')).toContain('X-Request-Id');
  });

  it('sets helmet headers', async () => {
    expect((await get('/item')).headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('CORS any origin', () => {
  it("answers '*' without credentials", async () => {
    @Controller()
    class C {
      @Get('x')
      x() {
        return 1;
      }
    }
    @Module({ controllers: [C] })
    class M {}
    const a = await NestFactory.create<NestExpressApplication>(M, { logger: false });
    setupHttpApp(a, { trustProxyHops: 0, corsOrigins: '*' });
    await a.listen(0, '127.0.0.1');
    try {
      const res = await fetch(`${await a.getUrl()}/x`, { headers: { Origin: 'https://any.test' } });
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    } finally {
      await a.close();
    }
  });
});

describe('metrics', () => {
  it('records route patterns and unmatched, never /health or raw paths', async () => {
    await get('/users/abc-123');
    await get('/nope-xyz');
    await get('/health/ready');
    // Past the scrape cache: a fresh server would have rendered once already in another test.
    (app.get(MetricsServer) as unknown as { scrape: unknown }).scrape = undefined;
    const text = await (await fetch(`${metricsBase}/metrics`)).text();
    expect(text).toMatch(/http_request_duration_seconds_count\{[^}]*route="\/users\/:id"[^}]*status="200"/);
    expect(text).toMatch(/http_request_duration_seconds_count\{[^}]*route="unmatched"[^}]*status="404"/);
    expect(text).not.toContain('abc-123');
    expect(text).not.toContain('nope-xyz');
    expect(text).not.toContain('/health');
    expect(text).toContain('app="test"');
  });

  it('serves only GET /metrics', async () => {
    expect((await fetch(`${metricsBase}/`)).status).toBe(404);
    expect((await fetch(`${metricsBase}/metrics`, { method: 'POST' })).status).toBe(404);
  });

  it('is not routed on the API port', async () => {
    expect((await get('/metrics')).status).toBe(404);
  });
});
