import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  clientRequestId,
  defaultErrorCode,
  genReqId,
  loggerParams,
  normalize,
  PageParams,
  paginate,
  parseCorsOrigins,
  prismaErrorCode,
  swaggerEnabled,
} from '../src';

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
    expect(http.customProps({ headers: { 'x-request-id': 'ok-1' } })).toEqual({ service: 'herald', clientRequestId: 'ok-1' });
    expect(http.customProps({ headers: { 'x-request-id': 'bad id' } })).toEqual({ service: 'herald' });
  });

  it('removes credential headers and the extra paths, and is not pretty by default', () => {
    expect(http.redact.remove).toBe(true);
    expect(http.redact.paths).toEqual(expect.arrayContaining(['req.headers.authorization', 'req.headers["x-api-key"]', 'req.body.password']));
    expect(http.transport).toBeUndefined();
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
