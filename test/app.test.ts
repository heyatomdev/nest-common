import 'reflect-metadata';
import {
  BadRequestException,
  Body,
  ConflictException,
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  controllers: [TestController],
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

  it('turns retryAfterSeconds into a Retry-After header', async () => {
    const { status, res } = await json('/busy');
    expect(status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
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
