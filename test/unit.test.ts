import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  clientRequestId,
  defaultErrorCode,
  genReqId,
  isPaginated,
  loggerParams,
  markPaginated,
  normalize,
  PageParams,
  paginate,
  parseCorsOrigins,
  prismaErrorCode,
  readAppInfo,
  readAppVersion,
  swaggerEnabled,
} from '../src';
import { join } from 'node:path';

describe('paginate', () => {
  it('builds { data, meta } with totalPages rounded up', () => {
    expect(paginate(['a', 'b'], 41, { page: 3, limit: 20 })).toEqual({
      data: ['a', 'b'],
      meta: { total: 41, page: 3, limit: 20, totalPages: 3 },
    });
  });

  it('has zero pages for an empty set', () => {
    expect(paginate([], 0, { page: 1, limit: 20 }).meta.totalPages).toBe(0);
  });

  it('marks its result without changing JSON or keys', () => {
    const page = paginate([1], 1, { page: 1, limit: 20 });
    expect(isPaginated(page)).toBe(true);
    expect(isPaginated({ data: [1], meta: page.meta })).toBe(false);
    expect(isPaginated({ ...page })).toBe(false);
    expect(Object.keys(page)).toEqual(['data', 'meta']);
    expect(JSON.parse(JSON.stringify(page))).toEqual({ data: [1], meta: page.meta });
  });

  it('never yields Infinity (null in JSON) for limit 0', () => {
    expect(paginate([], 5, { page: 1, limit: 0 }).meta.totalPages).toBe(0);
  });
});

describe('AllExceptionsFilter outside HTTP', () => {
  it('does not crash on a ws/rpc context', async () => {
    const { AllExceptionsFilter } = await import('../src/exception.filter.js');
    const host = { getType: () => 'rpc', switchToHttp: () => { throw new Error('not http'); } };
    expect(() => new AllExceptionsFilter().catch(new Error('boom'), host as never)).not.toThrow();
  });
});

describe('MetricsMiddleware', () => {
  it('records requests the client abandoned, as 499', async () => {
    const { EventEmitter } = await import('node:events');
    const { MetricsMiddleware, MetricsService } = await import('../src/metrics/index.js');
    const metrics = new MetricsService({ app: 't' });
    const res = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false });
    new MetricsMiddleware(metrics).use({ method: 'GET', originalUrl: '/slow' } as never, res as never, () => {});
    res.emit('close');
    expect(await metrics.registry.metrics()).toMatch(/http_request_duration_seconds_count\{[^}]*status="499"[^}]*\} 1/);
  });
});

describe('PageParams', () => {
  const parse = (query: Record<string, string>) => {
    const params = plainToInstance(PageParams, query);
    return { params, errors: validateSync(params) };
  };

  it('defaults to page 1, limit 20, skip 0', () => {
    const { params, errors } = parse({});
    expect(errors).toEqual([]);
    expect([params.page, params.limit, params.skip]).toEqual([1, 20, 0]);
  });

  it('coerces query strings and computes skip', () => {
    const { params, errors } = parse({ page: '3', limit: '25' });
    expect(errors).toEqual([]);
    expect(params.skip).toBe(50);
  });

  it('rejects limit above 100 and page below 1', () => {
    expect(parse({ limit: '101' }).errors.map((e) => e.property)).toEqual(['limit']);
    expect(parse({ page: '0' }).errors.map((e) => e.property)).toEqual(['page']);
  });

  it('keeps skip on a subclass (the getter lives on the prototype)', () => {
    class Query extends PageParams {}
    expect(plainToInstance(Query, { page: '2' }).skip).toBe(20);
  });
});

describe('swaggerEnabled', () => {
  it.each([
    [{}, false],
    [{ NODE_ENV: 'production' }, false],
    [{ NODE_ENV: 'staging' }, false],
    [{ NODE_ENV: '' }, false],
    [{ NODE_ENV: 'development' }, true],
    [{ NODE_ENV: 'test' }, true],
    [{ ENABLE_SWAGGER: 'true' }, true],
    [{ ENABLE_SWAGGER: 'false', NODE_ENV: 'development' }, false],
    [{ ENABLE_SWAGGER: true, NODE_ENV: 'production' }, true],
    [{ ENABLE_SWAGGER: 'yes' }, false],
  ])('%j → %s', (env, expected) => {
    expect(swaggerEnabled(env)).toBe(expected);
  });

  it('accepts a service-specific list of development environments', () => {
    expect(swaggerEnabled({ NODE_ENV: 'develop' })).toBe(false);
    expect(swaggerEnabled({ NODE_ENV: 'develop' }, ['develop', 'test'])).toBe(true);
    expect(swaggerEnabled({}, ['develop'])).toBe(false);
  });
});

describe('readAppInfo', () => {
  it('walks up to the first package.json (dist/src/ layout)', () => {
    const info = readAppInfo(join(__dirname, 'deep', 'dist', 'src'));
    expect(info.name).toBe('@heyatom/nest-common');
    expect(readAppVersion(__dirname)).toBe(info.version);
  });

  it('skips a package.json without a version (dist stub)', () => {
    expect(readAppInfo(join(__dirname, 'fixtures', 'dist-stub')).name).toBe('@heyatom/nest-common');
  });
});

describe('markPaginated', () => {
  it('marks a hand-built or upstream page in place', () => {
    const upstream = { data: [1], meta: { total: 1, page: 1, pageSize: 20 } };
    expect(markPaginated(upstream)).toBe(upstream);
    expect(isPaginated(upstream)).toBe(true);
    expect(Object.keys(upstream)).toEqual(['data', 'meta']);
  });
});

describe('request id', () => {
  it('accepts only an opaque token as clientRequestId', () => {
    expect(clientRequestId('abc-123_X.y')).toBe('abc-123_X.y');
    expect(clientRequestId('a'.repeat(65))).toBeUndefined();
    expect(clientRequestId('evil\r\nSet-Cookie: x=1')).toBeUndefined();
    expect(clientRequestId('has space')).toBeUndefined();
    expect(clientRequestId(['a', 'b'])).toBeUndefined();
    expect(clientRequestId(undefined)).toBeUndefined();
  });

  it('genReqId reuses the id setupHttpApp assigned before the body parser', () => {
    const req = { id: 'early-id', headers: {} } as unknown as IncomingMessage;
    const res = { setHeader: () => { throw new Error('header already set'); } } as unknown as ServerResponse;
    expect(genReqId(req, res)).toBe('early-id');
  });

  it('genReqId ignores the caller header and sets its own on the response', () => {
    const headers: Record<string, string> = {};
    const req = { headers: { 'x-request-id': 'caller-id' } } as unknown as IncomingMessage;
    const res = { setHeader: (k: string, v: string) => (headers[k] = v) } as unknown as ServerResponse;
    const id = genReqId(req, res);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(id).not.toBe('caller-id');
    expect(headers['X-Request-Id']).toBe(id);
  });
});

describe('loggerParams', () => {
  const http = loggerParams({ service: 'herald', level: 'info', redact: ['req.body.password'] }).pinoHttp as {
    autoLogging: { ignore: (req: { url?: string }) => boolean };
    customProps: (req: { headers: Record<string, string> }) => Record<string, string>;
    redact: { paths: string[]; remove: boolean };
    transport?: unknown;
  };

  it('ignores every /health route, not just the exact /health', () => {
    expect(http.autoLogging.ignore({ url: '/health/live' })).toBe(true);
    expect(http.autoLogging.ignore({ url: '/health/ready' })).toBe(true);
    expect(http.autoLogging.ignore({ url: '/events' })).toBe(false);
  });

  it('logs the service and a valid caller id as clientRequestId only', () => {
    expect(http.customProps({ headers: { 'x-request-id': 'ok-1' } })).toEqual({ clientRequestId: 'ok-1' });
    expect(http.customProps({ headers: { 'x-request-id': 'bad id' } })).toEqual({});
  });

  it('puts service in base, so lines outside requests carry it too', () => {
    expect((http as unknown as { base: Record<string, unknown> }).base).toMatchObject({ service: 'herald', pid: process.pid });
  });

  it('removes credential headers and the extra paths, and is not pretty by default', () => {
    expect(http.redact.remove).toBe(true);
    expect(http.redact.paths).toEqual(expect.arrayContaining(['req.headers.authorization', 'req.headers["x-api-key"]', 'req.body.password']));
    expect(http.transport).toBeUndefined();
  });
});

describe('loggerParams serializers', () => {
  it('logs no request or response headers by default (the raw X-Request-Id included)', async () => {
    const { default: pinoHttp } = await import('pino-http');
    const { PassThrough } = await import('node:stream');
    const { createServer } = await import('node:http');
    const lines: string[] = [];
    const sink = new PassThrough();
    sink.on('data', (chunk: Buffer) => lines.push(chunk.toString()));
    const { transport: _t, ...opts } = loggerParams({ service: 'svc', level: 'info' }).pinoHttp;
    const log = pinoHttp(opts as never, sink);
    const server = createServer((req, res) => {
      log(req, res);
      res.setHeader('Set-Cookie', 'sid=secret');
      res.end('ok');
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const { port } = server.address() as { port: number };
    await fetch(`http://127.0.0.1:${port}/events?token=x`, {
      headers: { 'X-Request-Id': '<script>', Cookie: 'sid=1', 'X-Custom': 'leak' },
    });
    await new Promise((ok) => setTimeout(ok, 50));
    server.close();
    const line = JSON.parse(lines.join('').trim().split('\n').pop()!) as {
      req: Record<string, unknown>;
      res: Record<string, unknown>;
      service: string;
    };
    expect(Object.keys(line.req).sort()).toEqual(['id', 'method', 'remoteAddress', 'url']);
    expect(line.res).toEqual({ statusCode: 200 });
    expect(line.service).toBe('svc');
    expect(lines.join('')).not.toContain('<script>');
    expect(lines.join('')).not.toContain('leak');
  });

  it('uses the serializers passed in, and spreads without a cast', () => {
    const req = (r: { url?: string }) => ({ url: r.url?.split('?')[0] });
    const params = loggerParams({ service: 'svc', level: 'info', serializers: { req } });
    const custom = { ...params.pinoHttp, serializers: { ...params.pinoHttp.serializers, res: () => ({}) } };
    expect(params.pinoHttp.serializers?.req).toBe(req);
    expect(custom.serializers.res).toBeTypeOf('function');
  });
});

describe('MetricsServer host', () => {
  it('listens on :: (dual-stack) when METRICS_HOST is unset', async () => {
    const { MetricsServer, MetricsService } = await import('../src/metrics/index.js');
    const opts = { app: 't', port: 0 };
    const server = new MetricsServer(new MetricsService(opts), opts);
    await server.onApplicationBootstrap();
    const addr = (server as unknown as { server: { address(): { address: string } } }).server.address();
    await server.onApplicationShutdown();
    expect(addr.address).toBe('::');
  });
});

describe('error mapping', () => {
  it('derives codes from the status (api.md §3 table)', () => {
    expect([400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503].map(defaultErrorCode)).toEqual([
      'BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'PAYLOAD_TOO_LARGE',
      'UNPROCESSABLE', 'RATE_LIMITED', 'INTERNAL_ERROR', 'UPSTREAM', 'UNAVAILABLE',
    ]);
    expect(defaultErrorCode(405)).toBe('METHOD_NOT_ALLOWED');
  });

  it('recognizes a Prisma known-request error by name and code only', () => {
    const err = Object.assign(new Error('x'), { name: 'PrismaClientKnownRequestError', code: 'P2002' });
    expect(prismaErrorCode(err)).toBe('P2002');
    expect(prismaErrorCode(Object.assign(new Error('x'), { code: 'P2002' }))).toBeUndefined();
    expect(prismaErrorCode({ name: 'PrismaClientKnownRequestError', code: 'P2002' })).toBeUndefined();
  });

  it('keeps domain extras, drops Nest `error`, prefers the declared code', () => {
    expect(normalize(409, { code: 'SLUG_TAKEN', message: 'Slug taken', error: 'Conflict', logId: 'l1' }, 'r1')).toEqual({
      statusCode: 409, code: 'SLUG_TAKEN', message: 'Slug taken', logId: 'l1', requestId: 'r1',
    });
  });

  it('keeps a structured `error` (terminus indicator map), drops only the string label', () => {
    expect(normalize(503, { message: 'down', error: { db: { status: 'down' } } }, 'r')).toMatchObject({ error: { db: { status: 'down' } } });
  });

  it('reports VALIDATION_FAILED for a validation array whatever the status', () => {
    expect(normalize(422, { message: ['a is bad'] }, 'r')).toMatchObject({ code: 'VALIDATION_FAILED', errors: ['a is bad'] });
  });

  it('cannot let a body override statusCode or requestId', () => {
    const body = normalize(400, { statusCode: 200, requestId: 'forged', message: 'x' }, 'real');
    expect([body.statusCode, body.requestId]).toEqual([400, 'real']);
  });
});

describe('parseCorsOrigins', () => {
  it('splits, trims and drops empties', () => {
    expect(parseCorsOrigins(' https://a.test, ,https://b.test ')).toEqual(['https://a.test', 'https://b.test']);
    expect(parseCorsOrigins(undefined)).toEqual([]);
  });
});
