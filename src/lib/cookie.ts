import { rawHeaderValues } from './headers.js';
import type { RawHeaders } from './headers.js';

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_OCTETS = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/;
const IMF_FIXDATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;

/** Exchange-only: exactly one RFC-conforming native Set-Cookie (§6/§7). */
export function validateExchangeSetCookie(headers: RawHeaders): string | undefined {
  const cookies = rawHeaderValues(headers, 'set-cookie');
  const cookie = cookies[0];
  if (cookies.length !== 1 || cookie === undefined || [...cookie].some(character =>
    character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return undefined;
  const [pair, ...parts] = cookie.split(';');
  if (pair === undefined) return undefined;
  const equal = pair.indexOf('=');
  const name = pair.slice(0, equal);
  if (equal < 1 || !TOKEN.test(name) || !name.startsWith('dsh-auth-') ||
    !COOKIE_OCTETS.test(pair.slice(equal + 1))) return undefined;
  const attributes = new Map<string, string | undefined>();
  for (const part of parts) {
    const attribute = part.trim();
    const separator = attribute.indexOf('=');
    const key = (separator < 0 ? attribute : attribute.slice(0, separator)).toLowerCase();
    const value = separator < 0 ? undefined : attribute.slice(separator + 1);
    if (!TOKEN.test(key) || attributes.has(key) || key === 'domain') return undefined;
    if (value !== undefined && ([...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) >= 127) ||
      (key !== 'expires' && value.includes(',')))) return undefined;
    attributes.set(key, value);
  }
  const expires = attributes.get('expires');
  if (!attributes.has('httponly') || attributes.get('httponly') !== undefined ||
    attributes.get('secure') !== undefined || attributes.get('path') !== '/' ||
    attributes.get('samesite')?.toLowerCase() !== 'strict' ||
    !/^[1-9][0-9]*$/.test(attributes.get('max-age') ?? '') ||
    expires === undefined || !IMF_FIXDATE.test(expires) || new Date(expires).toUTCString() !== expires) return undefined;
  return cookie;
}

/** Append Secure idempotently only to native dsh-auth-* cookies. */
export function ensureSecure(setCookie: string): string {
  const [pair, ...attributes] = setCookie.split(';');
  const name = pair?.split('=')[0];
  if (name === undefined || !name.startsWith('dsh-auth-') || attributes.some(attribute =>
    attribute.trim().split('=')[0]?.toLowerCase() === 'secure')) return setCookie;
  return setCookie + '; Secure';
}
