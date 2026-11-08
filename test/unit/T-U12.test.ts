import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AuthorityError, canonicalAuthority, isAuthorityTrusted, isBindAddressAuthority,
  isCanonicalAuthority, isLoopbackHost, matchesAnyAuthority, normalizeAuthorities, parseAuthority,
} from '../../src/lib/authority.js';

function parsed(text: string): NonNullable<ReturnType<typeof parseAuthority>> {
  const authority = parseAuthority(text);
  assert.ok(authority !== undefined, `${text} must parse`);
  return authority;
}

// DSH's entry rule is the only rule: the canonical form must equal the entry,
// case aside. Uppercase, a trailing dot, wildcard characters, underscores, and
// `:0` all survive WHATWG parsing, so they are accepted (a wildcard is a
// literal, never an expansion).
const canonical: Array<[string, string]> = [
  ['dsh.example.com', 'dsh.example.com'],
  ['DSH.Example.COM', 'dsh.example.com'],
  ['dsh.example.com.', 'dsh.example.com.'],
  ['*.example.com', '*.example.com'],
  ['a_b.example.com', 'a_b.example.com'],
  ['-lead.example.com', '-lead.example.com'],
  ['example.com:0', 'example.com:0'],
  ['example.com:80', 'example.com:80'],
  ['example.com:443', 'example.com:443'],
  ['example.com:8443', 'example.com:8443'],
  ['localhost:8080', 'localhost:8080'],
  ['[::1]', '[::1]'],
  ['[::1]:8443', '[::1]:8443'],
  ['127.0.0.1:8080', '127.0.0.1:8080'],
];
for (const [input, expected] of canonical) {
  test(`T-U12 canonicalizes ${input} as ${expected}`, () => {
    // Given / When / Then
    assert.equal(canonicalAuthority(input), expected);
    assert.equal(isCanonicalAuthority(input), true);
  });
}

// These are exactly the spellings WHATWG parsing would rewrite (or refuse);
// DSH refuses them in trustedHosts and the bridge refuses them identically.
const refused = ['', 'dsh.example.com:080', 'dsh.example.com:', 'dsh.example.com:65536',
  'user@dsh.example.com', 'dsh.example.com/path', 'bücher.example', '%65xample.com',
  '127.1', '0x7f.0.0.1', '192.168.001.010', '[0:0:0:0:0:0:0:1]', '::1',
  ' dsh.example.com', 'exa mple.com'];
for (const input of refused) {
  test(`T-U12 refuses non-canonical entry ${JSON.stringify(input)}`, () => {
    // Given / When / Then
    assert.equal(isCanonicalAuthority(input), false);
  });
}

test('T-U12 parses wire Host values exactly like DSH', () => {
  // Given / When / Then: URL normalization is the behavior, with no extra rules.
  assert.equal(parsed('user@dsh.example.com').hostname, 'dsh.example.com');
  assert.equal(parsed('dsh.example.com/path').hostname, 'dsh.example.com');
  assert.equal(parsed('bücher.example').hostname, 'xn--bcher-kva.example');
  assert.equal(parsed('[0:0:0:0:0:0:0:1]').hostname, '[::1]');
  assert.equal(parsed('EXAMPLE.com:0').host, 'example.com:0');
  assert.equal(parseAuthority('exa mple.com'), undefined);
  assert.equal(parseAuthority('example.com:65536'), undefined);
});

// Matching mirrors isTrustedAuthority(): a bare entry matches any port, a
// `host:port` entry compares parsed URL.host values (so HTTP's :80 folds), and
// there is no wildcard or subdomain expansion.
for (const [host, entries, expected] of [
  ['dsh.example.com:8443', ['dsh.example.com'], true],
  ['dsh.example.com', ['dsh.example.com:8443'], false],
  ['dsh.example.com:8443', ['dsh.example.com:8443'], true],
  ['dsh.example.com:8443', ['dsh.example.com:443'], false],
  ['dsh.example.com:443', ['dsh.example.com:443'], true],
  ['dsh.example.com', ['dsh.example.com:80'], true],
  ['dsh.example.com:80', ['dsh.example.com'], true],
  ['dsh.example.com:8080', ['dsh.example.com:80'], false],
  ['dsh.example.com:8443', ['other.example.com'], false],
  ['example.com:0', ['example.com'], true],
  ['example.com:0', ['example.com:0'], true],
  ['example.com', ['example.com:0'], false],
  ['example.com.', ['example.com'], false],
  ['example.com.', ['example.com.'], true],
  ['bücher.example', ['xn--bcher-kva.example'], true],
  ['[0:0:0:0:0:0:0:1]', ['[::1]'], true],
  ['a.example.com', ['*.example.com'], false],
  ['*.example.com', ['*.example.com'], true],
  ['a_b.example.com', ['a_b.example.com'], true],
] as const) {
  test(`T-U12 matches Host ${host} against ${JSON.stringify(entries)}`, () => {
    // Given / When / Then
    assert.equal(matchesAnyAuthority(parsed(host), entries), expected);
  });
}

for (const loopback of ['localhost:8080', '[::1]:8443', '127.0.0.1:9', '127.255.255.254']) {
  test(`T-U12 classifies ${loopback} as loopback`, () => {
    // Given / When / Then
    assert.equal(parsed(loopback).loopback, true);
  });
}
for (const remote of ['dsh.example.com', '192.168.1.10:8443', '[2001:db8::1]:443', '127.0.0.1.evil.com']) {
  test(`T-U12 classifies ${remote} as remote`, () => {
    // Given / When / Then
    assert.equal(parsed(remote).loopback, false);
  });
}

for (const [authority, trustedHosts, bindHost, expected] of [
  ['localhost:8080', [], undefined, true],
  ['[::1]:8443', [], undefined, true],
  ['127.0.0.1:9', [], undefined, true],
  ['192.168.1.10:8443', [], undefined, false],
  ['192.168.1.10:8443', ['192.168.1.10:8443'], undefined, true],
  ['192.168.1.10:8443', ['192.168.1.10'], undefined, true],
  ['dsh.example.com', ['dsh.example.com:8443'], undefined, false],
  ['dsh.example.com:8443', ['dsh.example.com'], undefined, true],
  ['127.0.0.1:8080', [], '127.0.0.1', true],
  ['[::1]:8080', [], '::1', true],
] as const) {
  test(`T-U12 trusts ${authority} with ${JSON.stringify(trustedHosts)} bind ${String(bindHost)}`, () => {
    // Given / When / Then
    assert.equal(isAuthorityTrusted(parsed(authority), trustedHosts, bindHost), expected);
  });
}

test('T-U12 accepts the listener bind address with or without a zone id', () => {
  // Given / When / Then
  assert.equal(isBindAddressAuthority(parsed('127.0.0.1:8080'), '127.0.0.1'), true);
  assert.equal(isBindAddressAuthority(parsed('[fe80::1]:8080'), 'fe80::1%eth0'), true);
  assert.equal(isBindAddressAuthority(parsed('127.0.0.1:8080'), undefined), false);
});

test('T-U12 normalizes entries to canonical strings and permits duplicates', () => {
  // Given / When: duplicates are harmless to DSH's any-match rule, so they stay.
  const normalized = normalizeAuthorities(['dsh.example.com', 'DSH.Example.COM', 'dsh.example.com']);
  // Then
  assert.deepEqual(normalized, ['dsh.example.com', 'dsh.example.com', 'dsh.example.com']);
  assert.throws(() => normalizeAuthorities(['bücher.example']),
    (error: unknown) => error instanceof AuthorityError && /WHATWG/.test(error.message));
  assert.throws(() => normalizeAuthorities(['']), (error: unknown) => error instanceof AuthorityError);
});

test('T-U12 isLoopbackHost validates IPv4/IPv6 loopback addresses and rejects others', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.0.0.2'), true);
  assert.equal(isLoopbackHost('127.255.255.254'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('0:0:0:0:0:0:0:1'), true);
  assert.equal(isLoopbackHost('[0:0:0:0:0:0:0:1]'), true);
  assert.equal(isLoopbackHost('::ffff:127.0.0.1'), true);

  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('::'), false);
  assert.equal(isLoopbackHost('[::]'), false);
  assert.equal(isLoopbackHost('192.168.1.1'), false);
  assert.equal(isLoopbackHost('2001:db8::1'), false);
  assert.equal(isLoopbackHost('example.com'), false);
  assert.equal(isLoopbackHost('127.0.0.1.evil.com'), false);
  assert.equal(isLoopbackHost(''), false);
});
