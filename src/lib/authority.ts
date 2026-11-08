/**
 * Authority parsing and matching, mirrored from the DSH `connection` Host fence
 * (`dsh-client-connection`'s `api-request-trust` + `loopback-hostname`). This
 * module deliberately adds no rules of its own:
 *
 * - parse with WHATWG `URL` under the listed scheme;
 * - a configured entry must survive that parsing unchanged (case aside);
 * - canonical form is `hostname` or `hostname:port`, with an explicit default
 *   port preserved through cross-scheme parsing (`:80` and `:443` stay visible);
 * - a bare entry matches its hostname on any port; `host:port` compares parsed
 *   `URL.host` values, so HTTP's default port folds into the bare form;
 * - loopback (`localhost`, `[::1]`, 127/8) and the listener bind address are
 *   accepted by DSH without a `trustedHosts` entry.
 *
 * Host values on the wire are parsed exactly like DSH parses them: whatever URL
 * normalization does (case, IDN punycode, percent-decoding of the host, an
 * explicit default port) is the behavior, and no extra restrictions apply.
 */

const HTTP = 'http:';
const HTTPS = 'https:';
type Scheme = typeof HTTP | typeof HTTPS;

export interface Authority {
  /** WHATWG hostname: lowercase, IPv6 literals keep their brackets. */
  readonly hostname: string;
  /** WHATWG host: hostname plus a non-default port, when one was written. */
  readonly host: string;
  /** DSH loopback: `localhost`, `[::1]`, or any IPv4 address in 127/8. */
  readonly loopback: boolean;
}

export class AuthorityError extends Error {
  readonly code = 'ERR_BRIDGE_AUTHORITY';
  constructor(message: string) {
    super(message);
    this.name = 'AuthorityError';
  }
}

/** Parse a request Host or entry with DSH's URL rules. */
export function parseAuthority(text: string, scheme: Scheme = HTTP): Authority | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  const url = parseUrl(text, scheme);
  if (url === undefined) return undefined;
  return { hostname: url.hostname, host: url.host, loopback: isLoopbackHostname(url.hostname) };
}

/** DSH's canonical form of a configured entry, or undefined when unparsable. */
export function canonicalAuthority(entry: string): string | undefined {
  const url = parseUrl(entry, HTTP);
  return url === undefined ? undefined : canonicalOf(entry, url);
}

/**
 * DSH's entry rule: the canonical form must equal the entry itself, case aside.
 * This is the same check `assertTrustedAuthority` applies to `trustedHosts`.
 */
export function isCanonicalAuthority(entry: string): boolean {
  const canonical = canonicalAuthority(entry);
  return canonical !== undefined && canonical === entry.toLowerCase();
}

/**
 * Normalize the configured list to canonical strings. Entries DSH would refuse
 * in `trustedHosts` are refused here too; nothing stricter is applied.
 */
export function normalizeAuthorities(values: readonly string[]): readonly string[] {
  return values.map((value) => {
    const canonical = canonicalAuthority(value);
    if (canonical === undefined || canonical !== value.toLowerCase()) {
      throw new AuthorityError(`authorities entry ${JSON.stringify(value)} is not a bare host[:port] authority; `
        + 'it must survive WHATWG parsing unchanged (case aside)');
    }
    return canonical;
  });
}

/** Whether a request Host is admitted by one configured entry (DSH matching). */
export function matchesAnyAuthority(host: Authority, entries: readonly string[]): boolean {
  return entries.some((entry) => {
    const entryUrl = parseUrl(entry, HTTP);
    if (entryUrl === undefined) return false;
    const canonical = canonicalOf(entry, entryUrl);
    if (canonical === undefined) return false;
    return canonical === entryUrl.hostname
      ? entryUrl.hostname === host.hostname
      : entryUrl.host === host.host;
  });
}

/**
 * True when DSH's own fence would accept this Host: loopback, the listener bind
 * address, or a matching trustedHosts entry.
 */
export function isAuthorityTrusted(
  authority: Authority,
  trustedHosts: readonly string[],
  bindHost?: string,
): boolean {
  if (authority.loopback || isBindAddressAuthority(authority, bindHost)) return true;
  return matchesAnyAuthority(authority, trustedHosts);
}

/** DSH accepts the listener's bind IP literal on any port, outside trustedHosts. */
export function isBindAddressAuthority(authority: Authority, bindHost: string | undefined): boolean {
  if (bindHost === undefined) return false;
  const zoneAt = bindHost.indexOf('%');
  const address = zoneAt === -1 ? bindHost : bindHost.slice(0, zoneAt);
  const bindUrl = parseUrl(address.includes(':') ? `[${address}]` : address, HTTP);
  return bindUrl !== undefined && bindUrl.hostname === authority.hostname;
}

function parseUrl(text: string, scheme: Scheme): URL | undefined {
  try {
    return new URL(`${scheme}//${text}`);
  } catch {
    return undefined;
  }
}

/**
 * Mirrors the DSH canonicalizer: the port is judged from URL parses under both
 * special schemes (their default ports differ, so `:80` and `:443` still count
 * as explicit), never from the raw string.
 */
function canonicalOf(entry: string, url: URL): string | undefined {
  if (url.port !== '') return `${url.hostname}:${url.port}`;
  const other = parseUrl(entry, url.protocol === HTTP ? HTTPS : HTTP);
  const port = other?.port ?? '';
  return port === '' ? url.hostname : `${url.hostname}:${port}`;
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * Validates whether a host string is a valid loopback address:
 * - IPv4 loopback (127.0.0.0/8, e.g. 127.0.0.1)
 * - IPv6 loopback (::1, [::1], 0:0:0:0:0:0:0:1, etc.)
 * - IPv4-mapped IPv6 loopback (::ffff:127.0.0.1, etc.)
 * - Hostname `localhost`
 */
export function isLoopbackHost(host: string): boolean {
  if (typeof host !== 'string' || host.length === 0) return false;
  const unbracketed = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const target = unbracketed.includes(':') ? `[${unbracketed}]` : unbracketed;
  try {
    const url = new URL(`http://${target}`);
    const hostname = url.hostname;
    if (hostname === 'localhost' || hostname === '[::1]') return true;
    const parts = hostname.split('.');
    if (parts.length === 4 && parts[0] === '127') {
      return parts.every((part) => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255);
    }
    if (hostname === '[::ffff:7f00:1]' || hostname.startsWith('[::ffff:127.')) return true;
    return false;
  } catch {
    return false;
  }
}
