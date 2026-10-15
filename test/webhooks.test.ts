import { createHmac } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  assertPublicWebhookUrl,
  checkWebhookUrl,
  isPublicAddress,
  signStandardWebhook,
  webhookLookup,
  WebhookUrlError,
} from '../src/webhooks';

const resolver = (map: Record<string, string[]>) => async (hostname: string) => {
  const ips = map[hostname];
  if (!ips) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return ips.map((address): LookupAddress => ({ address, family: address.includes(':') ? 6 : 4 }));
};

describe('isPublicAddress', () => {
  it.each([
    ['10.0.0.1'], ['172.16.5.4'], ['172.31.255.255'], ['192.168.1.1'], // RFC 1918
    ['127.0.0.1'], ['127.255.0.1'], // loopback
    ['100.64.0.1'], ['100.127.255.254'], // CGNAT
    ['169.254.1.1'], ['169.254.169.254'], // link-local, cloud metadata
    ['0.0.0.0'], ['224.0.0.1'], ['255.255.255.255'], ['198.18.0.1'], ['192.0.0.8'],
    ['::'], ['::1'], // IPv6 unspecified, loopback
    ['fc00::1'], ['fd12:3456::1'], // ULA
    ['fe80::1'], // link-local
    ['ff02::1'], // multicast
    ['::ffff:10.0.0.1'], ['::ffff:127.0.0.1'], ['::ffff:169.254.169.254'], ['::ffff:a00:1'], // IPv4-mapped
    ['::10.0.0.1'], // IPv4-compatible
    ['64:ff9b::a00:1'], ['64:ff9b::8.8.8.8'], ['64:ff9b:1::1'], // NAT64
    ['2002:a00:1::1'], // 6to4
    ['2001:db8::1'], // documentation
    ['not-an-ip'], [''],
  ])('%s is not public', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([['8.8.8.8'], ['1.1.1.1'], ['172.32.0.1'], ['100.128.0.1'], ['2606:4700:4700::1111'], ['::ffff:8.8.8.8']])(
    '%s is public',
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    },
  );
});

describe('checkWebhookUrl', () => {
  it.each([
    ['http://hooks.example.com/x', 'only https'],
    ['ftp://hooks.example.com/x', 'only https'],
    ['https://user:pass@hooks.example.com/x', 'credentials'],
    ['https://hooks.example.com@127.0.0.1/x', 'credentials'],
    ['https://localhost/x', 'not publicly reachable'],
    ['https://api.localhost/x', 'not publicly reachable'],
    ['https://127.0.0.1/x', 'not publicly reachable'],
    ['https://169.254.169.254/latest/meta-data', 'not publicly reachable'],
    ['https://[::1]/x', 'not publicly reachable'],
    ['https://[::ffff:10.0.0.1]/x', 'not publicly reachable'],
    ['https://[64:ff9b::a00:1]/x', 'not publicly reachable'],
    ['https://0x7f000001/x', 'not publicly reachable'], // WHATWG URL normalizes to 127.0.0.1
    ['not a url', 'invalid URL'],
  ])('refuses %s', (url, reason) => {
    expect(() => checkWebhookUrl(url)).toThrow(WebhookUrlError);
    expect(() => checkWebhookUrl(url)).toThrow(reason);
  });

  it.each([
    ['http://hooks.example.com/', 'NOT_HTTPS'],
    ['https://u:p@hooks.example.com/', 'CREDENTIALS_IN_URL'],
    ['https://127.0.0.1/', 'NON_PUBLIC_ADDRESS'],
    ['nope', 'INVALID_URL'],
  ])('tags %s with reason %s', (url, reason) => {
    expect(() => checkWebhookUrl(url)).toThrow(expect.objectContaining({ reason, code: 'WEBHOOK_TARGET_BLOCKED' }));
  });

  it('accepts a public https URL', () => {
    expect(checkWebhookUrl('https://hooks.example.com/in?x=1').hostname).toBe('hooks.example.com');
    expect(checkWebhookUrl('https://8.8.8.8/x').hostname).toBe('8.8.8.8');
  });

  it('admits http and private targets only with allowPrivate (development)', () => {
    expect(() => checkWebhookUrl('http://localhost:3000/x', { allowPrivate: true })).not.toThrow();
    expect(() => checkWebhookUrl('https://u:p@localhost/x', { allowPrivate: true })).toThrow('credentials');
  });
});

describe('assertPublicWebhookUrl', () => {
  const resolve = resolver({
    'public.test': ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
    'mixed.test': ['93.184.215.14', '10.0.0.5'],
    'mixed6.test': ['93.184.215.14', 'fd00::1'],
    'metadata.test': ['169.254.169.254'],
    'mapped.test': ['::ffff:192.168.0.1'],
    'empty.test': [],
  });

  it('accepts a host whose every address is public', async () => {
    await expect(assertPublicWebhookUrl('https://public.test/hook', {}, resolve)).resolves.toBeUndefined();
  });

  it.each([['mixed.test'], ['mixed6.test'], ['metadata.test'], ['mapped.test']])(
    'refuses %s (at least one non-public address)',
    async (host) => {
      await expect(assertPublicWebhookUrl(`https://${host}/hook`, {}, resolve)).rejects.toMatchObject({
        reason: 'DNS_NON_PUBLIC',
      });
    },
  );

  it('refuses a host that does not resolve or resolves to nothing', async () => {
    await expect(assertPublicWebhookUrl('https://nope.test/', {}, resolve)).rejects.toMatchObject({ reason: 'DNS_UNRESOLVED' });
    await expect(assertPublicWebhookUrl('https://empty.test/', {}, resolve)).rejects.toMatchObject({ reason: 'DNS_UNRESOLVED' });
  });

  it('gives the caller no DNS oracle: same message for private and unresolved, host never named', async () => {
    const msgs = await Promise.all(
      ['https://nope.test/', 'https://empty.test/', 'https://metadata.test/', 'https://localhost/', 'https://10.0.0.1/'].map((u) =>
        assertPublicWebhookUrl(u, {}, resolve).then(
          () => 'accepted',
          (e: Error) => e.message,
        ),
      ),
    );
    expect(new Set(msgs)).toEqual(new Set(['webhook target blocked: target is not publicly reachable']));
  });

  it('runs the textual checks first', async () => {
    await expect(assertPublicWebhookUrl('http://public.test/', {}, resolve)).rejects.toThrow('only https');
  });
});

describe('webhookLookup', () => {
  const resolve = resolver({ 'public.test': ['93.184.215.14'], 'rebind.test': ['93.184.215.14', '127.0.0.1'] });
  const call = (host: string, all: boolean) =>
    new Promise<unknown[]>((ok) => webhookLookup({}, resolve)(host, { all }, (...args) => ok(args)));

  it('serves both callback shapes for a public host', async () => {
    expect(await call('public.test', false)).toEqual([null, '93.184.215.14', 4]);
    expect(await call('public.test', true)).toEqual([null, [{ address: '93.184.215.14', family: 4 }]]);
  });

  it('fails the connection when the name resolves to a private address at send time', async () => {
    const err = await new Promise<Error>((ok) => {
      const req = request('http://rebind.test:80/', { lookup: webhookLookup({}, resolve) as never }, () => ok(new Error('connected')));
      req.on('error', ok);
      req.end();
    });
    expect(err).toBeInstanceOf(WebhookUrlError);
  });
});

describe('signStandardWebhook', () => {
  // Shared test vector (README): @heyatom/client's verifier must accept exactly these.
  const vector = {
    id: 'msg_2Kx9a',
    timestamp: 1760529600,
    body: '{"type":"event.created","data":{"id":"evt_1"}}',
  };

  it('signs with one secret', () => {
    expect(signStandardWebhook({ ...vector, secrets: ['whsec-test-current'] })).toEqual({
      'webhook-id': 'msg_2Kx9a',
      'webhook-timestamp': '1760529600',
      'webhook-signature': 'v1,+VYotv/AI9wyaA68bMYdRA3RDO8k9+ppDgCTYh6aJJ4=',
    });
  });

  it('emits one space-separated signature per secret during rotation', () => {
    expect(signStandardWebhook({ ...vector, secrets: ['whsec-test-current', 'whsec-test-previous'] })['webhook-signature']).toBe(
      'v1,+VYotv/AI9wyaA68bMYdRA3RDO8k9+ppDgCTYh6aJJ4= v1,TFAF/sEYytApEv9Zepsa4likR+i80NsV05Wcqt5x/5I=',
    );
  });

  it("matches gatherly's current signStandard()", () => {
    const gatherly = (secret: string, id: string, ts: string, body: string) =>
      'v1,' + createHmac('sha256', secret).update(`${id}.${ts}.${body}`).digest('base64');
    expect(signStandardWebhook({ ...vector, secrets: ['s3cret'] })['webhook-signature']).toBe(
      gatherly('s3cret', vector.id, String(vector.timestamp), vector.body),
    );
  });

  it('refuses to sign without a secret', () => {
    expect(() => signStandardWebhook({ ...vector, secrets: [] })).toThrow();
  });
});
