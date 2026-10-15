import { createHmac } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

/*
 * Outbound webhooks (api.md §13): SSRF guard for tenant/admin-chosen URLs and
 * Standard Webhooks signing. Framework-free: no Nest import in this subpath.
 *
 * A webhook URL is chosen by someone outside the service, and the service POSTs to it
 * from inside the private network. Three layers, each catching what the previous cannot:
 * 1. `checkWebhookUrl` — textual: scheme, credentials, literal IPs, `localhost`.
 *    Run at save time and again right before every send (the agent never sees a
 *    literal IP: `net.connect` skips `lookup` for it).
 * 2. `assertPublicWebhookUrl` — (1) plus every DNS answer public. Save time.
 * 3. `webhookLookup` / `webhookAgent` — the same DNS rule as the socket's `lookup`, so the
 *    address that was checked IS the address connected to (no DNS rebinding window).
 */

// Union of the bastion, gatherly and herald lists, plus ::/96 and 64:ff9b:1::/48.
// IPv4-mapped IPv6 (::ffff:a.b.c.d) is matched against the IPv4 rules by BlockList itself.
const NON_PUBLIC = new BlockList();
const NON_PUBLIC_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // RFC 1918 (Docker default bridge)
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 3], // multicast, reserved, broadcast
];
const NON_PUBLIC_V6: Array<[string, number]> = [
  ['::', 96], // unspecified, loopback, IPv4-compatible (::a.b.c.d)
  ['64:ff9b::', 96], // NAT64 can wrap a private IPv4
  ['64:ff9b:1::', 48], // local-use NAT64 (RFC 8215)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 can wrap a private IPv4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];
for (const [net, prefix] of NON_PUBLIC_V4) NON_PUBLIC.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of NON_PUBLIC_V6) NON_PUBLIC.addSubnet(net, prefix, 'ipv6');

/** True only for a syntactically valid IP outside every non-public range. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && !NON_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** Why a target was refused. For logs and metrics; the client sees only `message`. */
export type WebhookUrlReason =
  | 'INVALID_URL'
  | 'NOT_HTTPS'
  | 'CREDENTIALS_IN_URL'
  | 'NON_PUBLIC_ADDRESS'
  | 'DNS_NON_PUBLIC'
  | 'DNS_UNRESOLVED'
  | 'DNS_TRANSIENT';

// The URL's author sees `message`. The address reasons share one text and none
// names the host: "resolves to a private address" vs "does not resolve" would let a
// tenant admin probe which internal names (postgres, bastion…) exist.
const MESSAGES: Record<WebhookUrlReason, string> = {
  INVALID_URL: 'invalid URL',
  NOT_HTTPS: 'only https:// targets are allowed',
  CREDENTIALS_IN_URL: 'credentials in URL are not allowed',
  NON_PUBLIC_ADDRESS: 'target is not publicly reachable',
  DNS_NON_PUBLIC: 'target is not publicly reachable',
  DNS_UNRESOLVED: 'target is not publicly reachable',
  DNS_TRANSIENT: 'target is not publicly reachable',
};

/**
 * Refused target. Terminal for a delivery loop (retrying a blocked address is the scan itself),
 * except `DNS_TRANSIENT` (resolver hiccup, no verdict on the target): retry with backoff.
 * `DNS_UNRESOLVED` / `DNS_NON_PUBLIC` never opened a socket.
 * `message` is safe to return to the caller as is; log `reason` (and the host) server-side.
 */
export class WebhookUrlError extends Error {
  readonly code = 'WEBHOOK_TARGET_BLOCKED';
  declare readonly reason: WebhookUrlReason;
  constructor(reason: WebhookUrlReason, options?: { cause?: unknown }) {
    super(`webhook target blocked: ${MESSAGES[reason]}`, options);
    this.name = 'WebhookUrlError';
    // Not enumerable: `new BadRequestException(err)` or a spread must not put the reason in a
    // response body, where DNS_UNRESOLVED vs DNS_NON_PUBLIC would reopen the DNS oracle.
    Object.defineProperty(this, 'reason', { value: reason, enumerable: false });
  }
}

/**
 * True for a refused target however it surfaces. At send time the error is raised inside the
 * socket's `lookup`, so axios / `@nestjs/axios` hand back their own error with
 * `code: 'WEBHOOK_TARGET_BLOCKED'` and the `WebhookUrlError` as `cause`, not the error itself.
 * Terminal (retrying a blocked address is the scan itself) except `DNS_TRANSIENT`, which is false:
 * retry with backoff.
 */
export function isWebhookTargetBlocked(err: unknown): boolean {
  let coded = false;
  for (let e = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    // The wrapper carries the code too, so the typed error deeper in the chain decides first.
    if (e instanceof WebhookUrlError) return e.reason !== 'DNS_TRANSIENT';
    if ((e as { code?: unknown }).code === 'WEBHOOK_TARGET_BLOCKED') coded = true;
  }
  return coded;
}

export interface WebhookUrlPolicy {
  /**
   * Development only (bastion `WEBHOOK_ALLOW_PRIVATE_TARGETS`): admits private
   * addresses and `http://`. The service refuses it with `NODE_ENV=production`.
   */
  allowPrivate?: boolean;
}

function bareHost(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, '$1');
}

/** Textual check, no network. Returns the parsed URL or throws `WebhookUrlError`. */
export function checkWebhookUrl(raw: string, policy: WebhookUrlPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlError('INVALID_URL');
  }
  if (url.protocol !== 'https:' && !(policy.allowPrivate && url.protocol === 'http:')) {
    throw new WebhookUrlError('NOT_HTTPS');
  }
  // `https://evil.com@127.0.0.1/`: the part before `@` is userinfo, not the host.
  if (url.username || url.password) throw new WebhookUrlError('CREDENTIALS_IN_URL');
  const host = bareHost(url);
  if (!host) throw new WebhookUrlError('INVALID_URL');
  if (policy.allowPrivate) return url;
  if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) !== 0 && !isPublicAddress(host))) {
    throw new WebhookUrlError('NON_PUBLIC_ADDRESS');
  }
  return url;
}

// getaddrinfo EAI_AGAIN plus c-ares (dns.TIMEOUT, dns.SERVFAIL, dns.CONNREFUSED) codes.
const TRANSIENT_DNS = new Set(['EAI_AGAIN', 'ETIMEOUT', 'ETIMEDOUT', 'ESERVFAIL', 'ECONNREFUSED']);

type LookupFn = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;

const systemLookup: LookupFn = (hostname, options) =>
  new Promise((resolve, reject) => dnsLookup(hostname, options, (err, addrs) => (err ? reject(err) : resolve(addrs))));

/**
 * Every address `hostname` answers with, refused unless all are public. "All", not
 * "any": a name mixing a public and a private record is the rebinding shape.
 */
export async function resolvePublicAddresses(
  hostname: string,
  policy: WebhookUrlPolicy = {},
  resolve: LookupFn = systemLookup,
): Promise<LookupAddress[]> {
  let addresses: LookupAddress[];
  try {
    addresses = await resolve(hostname, { all: true });
  } catch (err) {
    // The exact code stays in `cause`, for the operator's log only.
    const code = (err as { code?: unknown })?.code;
    throw new WebhookUrlError(typeof code === 'string' && TRANSIENT_DNS.has(code) ? 'DNS_TRANSIENT' : 'DNS_UNRESOLVED', {
      cause: err,
    });
  }
  if (addresses.length === 0) throw new WebhookUrlError('DNS_UNRESOLVED');
  if (!policy.allowPrivate && !addresses.every((a) => isPublicAddress(a.address))) {
    throw new WebhookUrlError('DNS_NON_PUBLIC');
  }
  return addresses;
}

/** Save-time check: https, no credentials, and every address public. Throws `WebhookUrlError`. */
export async function assertPublicWebhookUrl(
  raw: string,
  policy: WebhookUrlPolicy = {},
  resolve: LookupFn = systemLookup,
): Promise<void> {
  const host = bareHost(checkWebhookUrl(raw, policy));
  if (isIP(host) === 0) await resolvePublicAddresses(host, policy, resolve);
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `lookup` for `net`/`http(s).request`/`Agent` that applies `resolvePublicAddresses`:
 * one resolution per connection, and it is the checked one. Serves both the
 * `all: true` and the single-address callback shapes Node uses.
 */
export function webhookLookup(policy: WebhookUrlPolicy = {}, resolve: LookupFn = systemLookup) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    // Resolve every family so the all-public check is complete, then filter by the requested
    // one. `hints` and `verbatim` are ignored: the answer order is the resolver's.
    const want = options?.family === 'IPv4' ? 4 : options?.family === 'IPv6' ? 6 : options?.family || 0;
    resolvePublicAddresses(hostname, policy, resolve).then(
      (all) => {
        const addresses = want ? all.filter((a) => a.family === want) : all;
        if (addresses.length === 0) {
          return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), '');
        }
        options?.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family);
      },
      (err: NodeJS.ErrnoException) => callback(err, ''),
    );
  };
}

/**
 * https Agent pinned to `webhookLookup()`: `httpsAgent` for axios / `@nestjs/axios`,
 * `agent` for `https.request`. Still call `checkWebhookUrl()` before each send
 * (literal IPs bypass `lookup`) and never follow redirects.
 */
export const webhookAgent = new Agent({ lookup: webhookLookup() as never });

const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * POST for `fetch` users (fetch cannot take an `https.Agent`). Same guarantees as `webhookAgent`:
 * `checkWebhookUrl` first, DNS pinned through `webhookLookup`, no redirects (3xx is returned as
 * `status`), response body capped at 64 KiB. Errors propagate as is: `isWebhookTargetBlocked(err)` works.
 */
export async function postWebhook(
  url: string,
  body: string,
  headers: Record<string, string>,
  opts: { timeoutMs?: number; policy?: WebhookUrlPolicy } = {},
): Promise<{ status: number; body: string }> {
  const target = checkWebhookUrl(url, opts.policy);
  const send = target.protocol === 'http:' ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      target,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        lookup: webhookLookup(opts.policy) as never,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          if (size < MAX_RESPONSE_BYTES) chunks.push(c.subarray(0, MAX_RESPONSE_BYTES - size));
          size += c.length; // keep draining so the socket frees up
        });
        res.on('end', () => {
          clearTimeout(deadline);
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    // A total deadline, not `req.setTimeout` (idle only: a receiver dripping a byte at a time never trips it).
    const deadline = setTimeout(
      () => req.destroy(Object.assign(new Error('webhook timeout'), { code: 'ETIMEDOUT' })),
      opts.timeoutMs ?? 10_000,
    );
    req.on('error', (err) => {
      clearTimeout(deadline);
      reject(err);
    });
    req.end(body);
  });
}

export interface StandardWebhookInput {
  /** Delivery id, also inside the payload: receivers deduplicate on it. */
  id: string;
  /** Unix seconds at **send** time (not enqueue time). */
  timestamp: number;
  /** The exact bytes sent as the request body. */
  body: string;
  /** Current secret first; during rotation also the previous one (valid 24h). */
  secrets: string[];
}

export interface StandardWebhookHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

/**
 * Standard Webhooks headers: `v1,<base64 HMAC-SHA256(secret, "<id>.<timestamp>.<body>")>`,
 * one per secret, space-separated. The key is the secret string as UTF-8 (gatherly's
 * existing format), not a `whsec_`-prefixed base64 key.
 */
export function signStandardWebhook(input: StandardWebhookInput): StandardWebhookHeaders {
  if (input.secrets.length === 0) throw new Error('signStandardWebhook: at least one secret is required');
  const timestamp = String(input.timestamp);
  const signed = `${input.id}.${timestamp}.${input.body}`;
  return {
    'webhook-id': input.id,
    'webhook-timestamp': timestamp,
    'webhook-signature': input.secrets
      .map((secret) => `v1,${createHmac('sha256', secret).update(signed).digest('base64')}`)
      .join(' '),
  };
}
