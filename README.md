# @zapsaang/dsh-web-bridge

> **Unix domain socket reverse proxy and automatic native session bootstrap for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web, packaged as a Cordis plugin.**

> **Status: Release Candidate (0.1.0-rc.2).** Production-ready reverse proxy contract with strict Unix socket lifecycle, native DSH session bootstrap, and multi-channel publishing verification. Pinned peers remain a verified compatibility baseline — see [Compatibility](#compatibility) before treating any of this as supported.

The bridge runs inside the DSH process, listens only on a Unix domain socket, and forwards to the DSH web server over loopback. Any access layer that can speak HTTP/1.1 over a Unix socket can front it: Nginx, Caddy, Cloudflare Tunnel, HAProxy, a local proxy, or a trusted local client. TLS, remote authentication, and access control stay in that layer. The bridge's own job is narrower: expose the socket safely, enforce an explicit Host allowlist, and complete DSH's native token exchange locally when a browser's page navigation hits `401` — so launch tokens never leave the machine and never appear in a remote URL, log, or address bar.

Identifiers such as `T-U9`, `T-P1d`, `T-P4`, and `V1`–`V7` are stable labels used by the test suite and release notes.

Maintainer-only material — local toolchain, the release gate, verification evidence, and the publishing workflow — lives in [`MAINTAINING.md`](https://github.com/zapsaang/dsh-web-bridge/blob/main/MAINTAINING.md). That file is repository-only and is not shipped in the npm tarball.

## Overview

```text
              Browser / API Client
                       │
                 HTTPS / HTTP
                       │
       ┌───────────────┴──────────────┐
       │      Access layer (swap it)  │
       │                              │
       │ Nginx / Caddy / Cloudflared  │
       │ HAProxy / local proxy / ...  │
       │                              │
       │ TLS, external auth, ACLs     │
       └───────────────┬──────────────┘
                       │
                 Unix Domain Socket
                       │
       ┌───────────────┴──────────────┐
       │        DSH Web Bridge        │
       │                              │
       │  UDS lifecycle               │
       │  HTTP / SSE / WS proxy       │
       │  Session auto-bootstrap      │
       │  Host / Origin guard         │
       └───────────────┬──────────────┘
                       │
               HTTP Loopback
                       │
               DSH Web Server
                 127.0.0.1
```

| Client request | Bridge behavior |
|---|---|
| `Host` not in `authorities` | `403`, no upstream connection |
| Malformed `Host`/target, `?token=` in a remote URL, protected `Connection` nomination | `400` |
| Normal request with a valid `Host` | streamed to DSH; verified `Host`, `Origin`, cookies, and fetch metadata are preserved |
| `GET /` document navigation → upstream `401` | one loopback token exchange → `200` bootstrap page carrying the `dsh-auth-*` cookie with `Secure` |
| `GET /?__dsh_bridge_retry=1` → upstream `200` | `303` to `/`, marker stripped |
| API / SSE / WebSocket → upstream `401` | relayed to the client; no exchange |
| WebSocket upgrade | handshake validated, then streamed both ways with `101` |
| Token exchange fails | original `401` relayed unchanged; never an anonymous fallback |

## Features

**Provided**

- **Unix socket listener** with strict filesystem lifecycle: euid-owned parent, `flock` instance exclusion, stale-socket identification, inode and mode verification, and a readiness gate that refuses connections until checks complete.
- **HTTP/1.1 proxying** to `127.0.0.1`, including streaming request/response bodies, SSE, and WebSocket upgrade (`101` relayed, frames piped both ways).
- **Authority allowlist** — an explicit enumeration, matched case-insensitively against the request's single `Host` value.
- **Native session bootstrap** — loopback-only token exchange using DSH's own `authenticatedUrl()` and a fixed-CSP re-navigation page.
- **Header hygiene** — RFC hop-by-hop fields and `Connection`-nominated fields are removed both ways; proxy identity credentials (`Cf-Access-Jwt-Assertion` both ways, `Authorization` on the request direction) are stripped; protected `Connection` nominations are rejected.
- **Bounded resources** — fixed connect/first-header/upload/exchange deadlines, no connection pooling to upstream, and no HTTP trailer support (a request carrying a `Trailer` header is refused with `501`; a response that announces trailers is refused with `502`, and a connection that ends with actual trailers is torn down).

**Not provided, by design**

- TLS termination, certificate automation, or an ACME client.
- Remote user authentication, OIDC/SSO, user databases, RBAC, or multi-tenancy.
- Any Cloudflare, Nginx, or Caddy API integration.
- A custom session format, cookie signing, or token store.
- A way to run without the DSH web server bound to `127.0.0.1`.

## Architecture

The bridge is one Cordis plugin row inside the DSH profile. It injects `connection` and `webServer`, reads `webServer.host`/`webServer.port`, and derives the exchange URL from `connection.authenticatedUrl()`.

### Trust boundaries

**Boundary 1 — Unix socket access.** Any local process that can connect to the socket is a trusted process. It may trigger an automatic session bootstrap whenever an eligible request arrives. Socket owner, UID/GID, file mode, and local process isolation therefore *are* the local access-control boundary. The plugin adds no per-peer identity check beyond the filesystem.

**Boundary 2 — Remote identity.** For public or untrusted networks, the access layer must establish authentication before forwarding to the socket: Nginx Basic Auth or `auth_request`/OIDC, mTLS, Cloudflare Access, or an authenticated internal gateway. Plain HTTPS only encrypts the transport; an unauthenticated public request that reaches the bridge can obtain a DSH session. This is a deployment responsibility — the bridge does not judge proxy credentials.

**Boundary 3 — DSH native session.** DSH issues and validates the session. The bridge only performs the local token exchange, forwards cookies (appending `Secure` to `dsh-auth-*`), and triggers a browser re-navigation. It never reads the signing secret, synthesizes cookies, or bypasses the DSH Host/Origin fence.

## Installation

Pinned peers (exact versions, no ranges):

| Peer | Version |
|---|---|
| `@deepseek-ai/dsh` | `0.2.2-rc.2` |
| `@deepseek-ai/cordis` | `4.1.0` |
| `@deepseek-ai/schemastery` | `3.19.0` |

Runtime: Node `>=24.21.0 <25` plus the util-linux `flock` system tool.

Install into the web profile (the CLI forwards the remaining arguments to pnpm inside the profile directory):

```sh
dsh plugin --profile web add @zapsaang/dsh-web-bridge@0.1.0-rc.2
```

Prefer an explicit version or `@rc`, and check `npm view @zapsaang/dsh-web-bridge dist-tags --json` instead of assuming which tag points at the newest release.

**Activation mechanism.** `package.json` carries `dsh.bundle.patch: ["./cordis.patch.yml"]`; the profile loader reads that metadata and applies the shipped patch as one bundle layer. The patch is a single append-mode `insert` row:

```yaml
- insert:
    - id: dsh-web-bridge
      name: '@zapsaang/dsh-web-bridge'
      inject: [connection, webServer]
      config:
        socketPath: /run/dsh-web/session-bridge.sock
```

The shipped bundle carries **only** `socketPath`. It deliberately ships no example authorities: the row loads, then the plugin fails with an actionable error until a deployment overlay supplies at least one authority, so a placeholder domain can never silently become a real deployment. Copy [`examples/overlay.example.yml`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/overlay.example.yml) and replace the example host. Omitting `socketAccess` selects the default **strict** socket mode.

> **Upgrading from `0.1.0-alpha.6`:** that version ships `authorities: [dsh.example.com, dsh2.example.com]` in the bundle and accepts only bare DNS names. As of `0.1.0-alpha.7`, the bundle ships without default authorities: add a deployment overlay with your own authorities before restarting.

Installing the package is not the same as enabling it: CLI bundle selection comes from the plugin-manager reconcile — a newly added bundle with `dsh.bundle` metadata is selected by default, an already-installed-but-disabled dependency is **not** re-enabled, and a package without `dsh.bundle` metadata stays a plain dependency. A live process is not readiness either; see [Security Model](#security-model).

### Deployment overlays

Cordis patch semantics: **a row's config is replaced wholesale, not deep-merged**. Every overlay below must restate every key it needs. A complete, copyable overlay — bridge row plus the DSH-side rows — lives in [`examples/overlay.example.yml`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/overlay.example.yml).

**Bridge row** (required: your own authorities):

```yaml
- id: dsh-web-bridge
  name: '@zapsaang/dsh-web-bridge'
  inject: [connection, webServer]
  config:
    socketPath: /run/dsh-web/session-bridge.sock
    authorities: [dsh.example.com]
```

**Bridge row, group mode** (opt-in; adds the third key):

```yaml
- id: dsh-web-bridge
  name: '@zapsaang/dsh-web-bridge'
  inject: [connection, webServer]
  config:
    socketPath: /run/dsh-web/session-bridge.sock
    socketAccess: group
    authorities: [dsh.example.com]
```

The group overlay only takes effect together with the matching group-mode tmpfiles line; enabling one without the other fails closed at startup.

**DSH-side rows.** Restate the webserver / web-runtime / connection rows so the DSH web server stays on loopback and never prints a tokenized URL:

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
- id: web-runtime
  name: '@deepseek-ai/dsh-web-app'
  inject: [webStartup]
  config:
    openBrowser: false
    printUrl: false
    surfaceContext: true
    publicUrl: !!js ctx.webStartup.publicUrl   # optional; omit when no public root is advertised
- id: connection
  name: '@deepseek-ai/dsh-client-connection'
  inject: [webStartup]
  config:
    trustedHosts: !!js "['dsh.example.com', ...ctx.webStartup.trustedHosts]"
```

The `connection` row replaces its whole config too: the example shows the only key this deployment overrides. A deployment that also sets `recovery`, `cookieMaxAgeDays`, or `maxRequestBodyBytes` must restate those keys here, or they fall back to the schema defaults.

## Configuration

The plugin accepts exactly three keys; unknown keys are rejected at load time.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `socketPath` | string | `/run/dsh-web/session-bridge.sock` | Absolute UDS path (≤107 UTF-8 bytes, no `..`, no NUL). |
| `socketAccess` | `strict` \| `group` | `strict` | Socket mode: `0600` / `0660`, with matching parent-directory rules. |
| `authorities` | string[] | *required* | Allowed HTTP authorities. Omission or an empty list fails schema validation, so no socket is created. |

`authorities` is a full admission list, not just a bootstrap switch: a request whose `Host` is not in it is rejected with `403` before any upstream connection.

### Authority syntax

`authorities` entries follow the same rule DSH applies to `connection.trustedHosts`: a bare `host[:port]` authority that survives WHATWG URL parsing unchanged, case aside. The bridge adds no rule of its own, so the list cannot be stricter than the fence the request must later pass.

| Entry | Matches |
|---|---|
| `dsh.example.com` | that hostname on any port |
| `dsh.example.com:8443` | that exact authority (HTTP's default port `80` folds into the bare form) |
| `localhost`, `localhost:8080` | loopback; no `connection.trustedHosts` entry needed |
| `192.168.1.10`, `192.168.1.10:8443` | IPv4, any or that port |
| `[::1]`, `[::1]:8443` | bracketed IPv6, any or that port |

Matching mirrors DSH exactly: a bare entry covers any port, `host:port` compares parsed `URL.host` values, and there is no wildcard or subdomain expansion — a `*` in an entry is just a literal character. The wire `Host` is parsed with the same WHATWG rules, so case, IDN punycode, and an explicit default port behave exactly as they do in DSH.

Entries DSH would refuse are refused here too: userinfo, path/query, whitespace or control characters, percent-encoding, IDN spellings that need punycoding, shorthand/hex IPv4, unbracketed or non-canonical IPv6, and dangling, zero-padded, or out-of-range ports. Uppercase, a trailing dot, underscores, `:0`, and wildcard characters survive parsing, so they are accepted as written and normalized to DSH's canonical form.

A missing or empty list fails with `authorities is required; add a bridge overlay with authorities: ['<public-host>']`. Beyond that entry rule there is no bridge-specific restriction on the list.

**Version note.** The syntax above ships in `0.1.0-alpha.7`. `0.1.0-alpha.6` accepts only lowercase, port-less DNS names, ships two example domains in the bundle, and requires every authority as a bare `connection.trustedHosts` entry.

### `trustedHosts` vs. `authorities`

Three deliberately different lists — do not mirror them:

1. **bridge `authorities`** — the authorities the bridge may serve and bootstrap. This deployment's explicit admission list.
2. **webStartup `trustedHosts`** — only the `--trusted-host` values named on this invocation. It is an input to the connection row, not a deployment list.
3. **connection `trustedHosts`** — the active Host/Origin fence list: the public names plus any CLI extras. On DSH `0.2.2-rc` this is the authoritative list; the web-runtime row no longer carries one.

At startup the bridge cross-checks every authority the way DSH's `/api` Host fence will judge the forwarded `Host`:

| Authority | `connection.trustedHosts` | Result |
|---|---|---|
| `dsh.example.com` | `['dsh.example.com']` | pass — a bare name covers any port |
| `dsh.example.com` | `['dsh.example.com:8443']` | **fail** — a port-specific entry cannot cover a port-less authority |
| `dsh.example.com:8443` | `['dsh.example.com:8443']` | pass — exact port |
| `dsh.example.com:8443` | `['dsh.example.com']` | pass — a bare name covers any port |
| `localhost:8080` | `[]` | pass — DSH accepts loopback directly |
| `[::1]:8443` | `[]` | pass — loopback |
| `192.168.1.10:8443` | `['192.168.1.10:8443']` | pass — non-loopback must be listed |
| `192.168.1.10:8443` | `[]` | **fail** — non-loopback and not listed |

A missing or mismatched entry, or a `connection` without a trusted-host list, fails closed with `ERR_BRIDGE_AUTHORITY_TRUST` before any socket is created. CLI extras remain valid for the native fence but never become bridge-approved authorities.

**Security premise for loopback authorities.** DSH accepts `Host: localhost`, `127.0.0.1`, `[::1]`, and its own bind address unconditionally. If one bridge is both reachable through a public proxy and configured with a loopback authority, and that proxy forwards the client's `Host` unchanged, an external request with `Host: localhost` can pass both fences and obtain a loopback-audience session cookie. Configure loopback authorities only when the socket is not fronted by an untrusted proxy; a public proxy must rewrite `Host` or reject names outside the allowlist.

### Startup checks and fixed limits

In order, before the socket is created:

1. `webServer.host === '127.0.0.1'` with an integer port in `1..65535`, otherwise `ERR_BRIDGE_LOOPBACK_GUARD`. A DSH bound to `::1` or a LAN address cannot be bridged today.
2. every authority is trusted under those same fence semantics (loopback and the bind address excepted), otherwise `ERR_BRIDGE_AUTHORITY_TRUST`.
3. the socket lease: path constraints → parent directory trust → lock identity → `flock` → stale reclaim → bind → chmod → inode/mode re-verification. See [Security Model](#security-model).

Fixed, non-configurable budgets (overridable only by the internal runtime type, never by plugin config):

| Budget | Value | On expiry |
|---|---|---|
| upstream connect | 2 s | `502` |
| upload (request body) | 300 s | `408` |
| first response header | 30 s | `504` |
| token exchange (total) | 2 s | exchange failure → original `401` |

`Expect: 100-continue` is supported; any other `Expect` value gets `417`. HTTP trailers are not supported: see [Features](#features).

## Security Model

### Socket permissions and lifecycle

[`examples/dsh-web.tmpfiles.conf`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/dsh-web.tmpfiles.conf) carries one **active** directive and two commented, mutually exclusive alternatives for the same path:

```ini
# /etc/tmpfiles.d/dsh-web.conf
d /run/dsh-web 0700 dsh dsh -
# group mode (opt-in; enable at most ONE of these, never alongside the strict line):
# d /run/dsh-web 02710 dsh dsh-bridge -   # preferred: group traverse, no list
# d /run/dsh-web 02750 dsh dsh-bridge -   # discovery: group may also list
```

**Strict mode (default).** Directory `0700` owned by the `dsh` user; the socket itself is `0600` and the lock file is `0600`. A root-run connector (cloudflared, a system Nginx worker) can connect to the `dsh`-owned socket; no other-UID sharing is active. Strict deployments may keep `0700`-owned ancestors anywhere on the path.

**Group mode (opt-in, implemented and published since `0.1.0-alpha.3`).** The operator pre-creates the directory as setgid `02710` (preferred: group members traverse but cannot list) or `02750` (discovery: group members may list), owner `dsh`, group a dedicated bridge group such as `dsh-bridge`. No group write, no permissions for others. The socket is created `0660` and inherits the directory GID through setgid; the lock stays `0600`, so group members can connect but cannot create, delete, or rename anything in the directory. Enabling group mode is two coordinated steps from one configuration owner: the `socketAccess: group` overlay row and the matching tmpfiles line (owner, group, path, mode). The plugin never creates, chowns, or chmods the directory itself, and never falls back if the predicates do not match. Mode `02750` is setgid, not sticky.

- **Lease rules.** The path must be absolute, `..`-free, NUL-free and at most 107 UTF-8 bytes. The parent must be an euid-owned real directory — strict: no group/other permission bits at all (`mode & 0o077 === 0`); group: exactly `02710` or `02750`. Every ancestor must be a real directory owned by root or the effective UID with no group/other write. The adjacent `<socket>.lock` must be the same euid-owned regular inode with mode `0600`, seen both through its descriptor and through its path, and must be held with `flock` (exit `75` means another instance owns it).
- **Stale-socket reclaim.** An existing path is only reclaimed when it is an euid-owned socket, a connect probe fails with `ECONNREFUSED` (proving no live listener), and a re-`lstat` shows the same device/inode; then it is unlinked. Anything else fails closed.
- **Bind verification.** After bind the socket is chmodded to the target mode and re-inspected: it must still be a socket, same device/inode, same euid, exact mode, and (in group mode) the parent directory's GID. Any drift aborts startup and disposes the lease.
- **Trust semantics.** Group membership equals full DSH Web access. Any process whose primary or supplementary groups hit the shared group can reach the socket, trigger bootstrap, and read real DSH `Set-Cookie` values; no Cloudflare or cloudflared needs to be present. `Host`, `Accept`, `Sec-Fetch-*`, `Cf-Access-Jwt-Assertion`, and `Authorization` headers are not local identity and grant no standing; the bridge adds no such check. Choose the directory group as the authorization decision and use a dedicated group per bridge so revocation and auditing stay cheap.
- **Ancestors.** In group mode every ancestor on the socket path must be traversable by the connecting service accounts (for example an unprivileged cloudflared) with no group/other write. Private home directories and `/run/user/UID` roots block group peers and must not host the socket.
- **Lock and age discipline.** The `-` age field disables age-based cleanup. tmpfiles or systemd must never remove, replace, truncate, or age-clean the lock inode or its parent directory while any cooperating instance may be alive. If a unit uses `RuntimeDirectory`, set `RuntimeDirectoryPreserve=yes`; a failed competing unit stopping must not delete the active owner's inode. There must be no competing owner or chmod manager for the same path. Operator cleanup is allowed only after confirming all instances have stopped.
- **Mode switch.** Changing strict to group or back is never an online operation. Stop all cooperating instances (every bridge instance and every connector), change the config overlay and the tmpfiles owner/group/mode together, refresh the connecting services' credentials (primary group and supplementary groups), then do a full start. Cordis pending restart, update, and reload do not perform this switch.
- **Shutdown quarantine.** A shutdown that hits its deadline or a close error enters quarantine: the lease is held, no retry or reset is attempted, and replacement is blocked until the entire process stops (the OS then reaps the fds). Plan a full process stop, not a plugin swap, after any quarantined shutdown error.
- **Readiness.** Ready means the lease checks completed: verified directory, lock acquired, bind, chmod, re-check. Listening or a live pid is not readiness, and connections made before ready are not served (they are destroyed).
- **Revocation limits.** Removing a member from the group, or any DAC change, does not close existing open connections and does not revoke already issued DSH cookies. Treat connection draining and cookie revocation as separate operational steps.
- **ACL stance (deployment gate).** Every layer of the path, the socket, and the lock must carry only the base `user::` / `group::` / `other::` ACL entries, which are equivalent to the mode. Named entries, mask-only entries, and default ACLs at any layer are unsupported. mode/gid alone cannot exclude mask or named entries, so inspect every layer plus the socket plus the lock, read-only, with `getfacl -p <path>` (`-p` retains the leading slash on absolute paths, not relative paths; `setfacl -m` modifies ACLs and is not an inspection command) together with `stat`. The plugin does not detect ACLs; this is operator-side only, checked before enabling group mode.
- **Evidence status.** Same-UID checks passed (configuration/group **24/24**, readiness **27/27**, and native pinned-DSH bootstrap **401 without a cookie / 200 with the issued cookie** for strict and both group directory modes), and the formal Linux group gate passes on CI (`groupPositive=4`, `strictNegative=2`). Cross-UID acceptance and deployment ACL/credential verification (A10) remain **NOT RUN**; full evidence and the gate tooling are in [`MAINTAINING.md`](https://github.com/zapsaang/dsh-web-bridge/blob/main/MAINTAINING.md#verification-evidence).

### Request admission

Every HTTP request, `checkContinue` request, and WebSocket upgrade passes the same admission step before any upstream connection:

- a first `Host` header that WHATWG URL parsing accepts (Node keeps the first duplicate and DSH parses that same value), and an origin-form target (`/…`, not `//…`, no `#`, `\`, control characters, or spaces) — otherwise `400`;
- no `token` query parameter — otherwise `400` (a remote request can never use a launch token);
- no `Connection` nomination of `host`, `origin`, `cookie`, `authorization`, `sec-fetch-*`, or `sec-websocket-*` — otherwise `400`;
- `Host` must equal an `authorities` entry (case-insensitive) — otherwise `403`.

Then: a request `Trailer` header → `501`; a WebSocket upgrade that is not `websocket` → `501`; a malformed upgrade handshake (method, `Connection: Upgrade`, version `13`, a valid 16-byte base64 key, no body) → `400`.

Verified `Host`, `Origin`, and fetch-metadata values are forwarded **unchanged**. The bridge never reads or rewrites `X-Forwarded-Host`, `X-Forwarded-Proto`, or `Forwarded`, and those headers never extend the trust lists.

### Header handling

- **Hop-by-hop (RFC):** `connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade` — removed in both directions, together with any field named by `Connection`.
- **Proxy identity token:** `cf-access-jwt-assertion` is stripped in both directions as defensive sanitation. The bridge never verifies an Access JWT and never treats that header as proof of identity.
- **`Authorization`:** stripped on the request direction as of `0.1.0-alpha.7`; the response direction is deliberately untouched. It is never an input to the bootstrap decision and only needed protection from `Connection` smuggling. The DSH web stack (`dsh-client-connection`, `dsh-host-webserver`, `dsh-web-app`) does not consume the header for authentication today; stripping it keeps proxy Basic/OIDC credentials out of the DSH process. If DSH ever introduces `Authorization`-based auth, land a DSH contract test before relaxing this. Proxies should still terminate and clear it explicitly (Nginx `proxy_set_header Authorization "";`, Caddy `header_up -Authorization`) as defense in depth.
- **Cookies:** request `Cookie` headers are forwarded untouched and never parsed. On responses, the only change to any `Set-Cookie` value is an idempotently appended `Secure` on `dsh-auth-*` names; the rest of the value is preserved byte-for-byte.

### Session bootstrap security rules

1. Only an eligible root document navigation triggers an exchange (exact predicate in [Authentication Bootstrap](#authentication-bootstrap)).
2. API, SSE, and WebSocket requests keep DSH's native `401`; the bridge never manufactures a session for them.
3. Remote `?token=` is rejected outright.
4. The token exchange is loopback-only: `127.0.0.1:<dsh port>`, `Host` set to the browser's raw `Host` value, no other headers, `agent: false`.
5. Only a structurally valid native session cookie is accepted (exactly one `Set-Cookie`, `dsh-auth-*`, `HttpOnly` with no value, no incoming `Secure`, `Path=/`, `SameSite=Strict`, positive `Max-Age`, canonical `Expires`, no `Domain`, no control characters).
6. Re-retry is bounded by the `__dsh_bridge_retry` marker: a marked navigation that still gets `401` is relayed, never re-exchanged.
7. A failed exchange returns the original unauthenticated response; there is no degraded or anonymous grant.
8. `HttpOnly`, `SameSite`, and the `Secure` policy are preserved as described above.
9. Tokens, cookies, and full authenticated requests are never logged (see [Logging policy](#logging-policy)).

### HTTPS policy

There is no explicit protocol check in the code. What actually enforces HTTPS in production is the unconditional `Secure` attribute appended to every `dsh-auth-*` `Set-Cookie`. This has a practical consequence: DSH's own loopback listener is plain HTTP and issues cookies without `Secure`; whether `http://localhost` can still store the rewritten cookie depends on each browser's loopback exception rules and has **not** been verified across browsers. Treat plain-HTTP localhost as a development-only experiment. Do not weaken the `Secure` policy for production.

### Threat model (operational summary)

The bridge strips proxy identity credentials before they can reach DSH (`Cf-Access-Jwt-Assertion` in both directions, `Authorization` on the request direction) and never logs credential material; the access layer's identity is not an input to the bootstrap decision. Accepted local trust domains: a same-UID process and root are inside the trusted computing base (cooperative lease discipline only). The implemented opt-in group mode extends that trust domain to every member of the shared bridge group, with no per-user or per-session isolation inside the group. The main remote residual risks are access-layer misconfiguration (an ingress without Access, a bypass policy, a missing `auth_request`) and compromised remote accounts; revocation of already-upgraded WebSockets is not instant.

### Logging policy

`src/` contains no logging calls at all. The only log-context helper, `redactLogContext`, unconditionally returns `[redacted]`, and `T-U9` pins that function — it does **not** pin "every log path", because there are none.

If logging is ever added, this stays the contract:

- **Allowed:** startup/shutdown, socket path, owner/mode, DSH port, the first authority, bootstrap success/failure (error code only), upstream unavailability, dispose completion.
- **Forbidden — must never appear in any log:** tokens, tokenized URLs, cookie values, `Cf-Access-Jwt-Assertion`, `Authorization`, complete `Cookie` headers.

## Reverse Proxy Integration

### Unified access contract

Whatever fronts the bridge must satisfy all of these:

- connect to a Unix domain socket;
- pass the client's `Host` through unchanged (or explicitly rewrite it to an allowed authority);
- preserve `Origin` and the `Sec-Fetch-*` metadata needed for the bootstrap predicate;
- support HTTP/1.1 `Upgrade` for WebSocket;
- support long-lived streaming responses (SSE) with backpressure — disable proxy buffering;
- never cache; bootstrap responses are `no-store` and must stay uncached;
- terminate external authentication and **not** forward proxy credentials as `Authorization`.

### Deployment examples

Every example is repository-only (D4): `examples/` is **not** part of the npm tarball. [`scripts/check-examples.mjs`](https://github.com/zapsaang/dsh-web-bridge/blob/main/scripts/check-examples.mjs) statically checks each file against [`examples/overlay.example.yml`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/overlay.example.yml) — same socket path and authority, plus the TLS/authentication/SSE/WebSocket directives each layer needs — on every CI run. It does **not** run `nginx -t` or `caddy validate`, so validate the copied file on the deployment host.

| Access layer | Files | TLS | External authentication | Streaming |
|---|---|---|---|---|
| Nginx | [`examples/nginx.conf`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/nginx.conf) | `listen 443 ssl` | Basic auth, or `auth_request` to an OIDC gateway | `proxy_buffering off` + Upgrade map |
| Caddy | [`examples/Caddyfile`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/Caddyfile) | automatic | `basic_auth`, or `forward_auth` to an OIDC gateway | `flush_interval -1` |
| Cloudflare Tunnel | [`examples/cloudflared.md`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/cloudflared.md), [`examples/cloudflared.yml`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/cloudflared.yml) | edge | Access (`required: true`, one `audTag` per hostname) | edge-supported |
| Local UDS client | [`examples/local-uds-client.md`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/local-uds-client.md) | n/a | socket DAC only | `curl` probes; WebSocket via a browser |

Rules that apply regardless of the layer:

- **Preserve `Host`.** Nginx must forward `$http_host` (not `$host`) when an authority carries an explicit port; Caddy forwards the original `Host` by default and must not rewrite it with `{host}`.
- **Keep `Origin` and `Sec-Fetch-*`.** The bootstrap predicate and DSH's fence both depend on them.
- **Terminate and clear proxy credentials.** The bridge strips request-direction `Authorization` and both-direction `Cf-Access-Jwt-Assertion`; clearing at the proxy is defense in depth.
- **Do not buffer or cache.** SSE needs immediate flushing, and bootstrap responses are `no-store`.
- **Support HTTP/1.1 Upgrade** for WebSocket and validate the handshake end to end.

### Cloudflare Tunnel

Topology, `httpHostHeader` warning, Access prerequisites, overlay rows, and verification steps live in [`examples/cloudflared.md`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/cloudflared.md); the ingress file is [`examples/cloudflared.yml`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/cloudflared.yml). In short: cloudflared terminates TLS and Access, forwards to `unix:/run/dsh-web/session-bridge.sock`, each hostname gets its own Access application and `audTag`, `access.required` is always `true`, and `originRequest.httpHostHeader` is never set.

### Other UDS clients

Any client that can connect to a Unix socket and speak HTTP/1.1 works; [`examples/local-uds-client.md`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/local-uds-client.md) has copyable probes. Minimal check:

```sh
curl --unix-socket /run/dsh-web/session-bridge.sock \
  -H 'Host: dsh.example.com' -i http://localhost/
```

`401` here is expected for a non-navigation client and proves the request reached DSH; `403` means the `Host` is not an authority. Add `-H 'Accept: text/html'` to exercise the bootstrap path (no `Sec-Fetch-*` headers present).

## Authentication Bootstrap

```text
Client navigation to /
        │
        ▼
    UDS Proxy ──► DSH native session
        │              │
        │        ┌─────┴─────┐
        │      valid      401
        │        │          │
        │        ▼          ▼
        │   page returned  eligible navigation?
        │                     │
        │                     ▼
        │        local token exchange (loopback)
        │                     │
        │                     ▼
        │        DSH issues session + Set-Cookie
        │                     │
        │                     ▼
        │        fixed-CSP 200 page (no-store)
        │                     │
        │                     ▼
        └──────────► browser re-navigates to /?__dsh_bridge_retry=1
                              │
                              ▼
                     DSH 200 → 303 to / (marker stripped)
```

**Eligibility is deliberately narrow.** An exchange happens only when *all* of the following hold:

- upstream status is exactly `401`;
- method is `GET`;
- the path is `/` (a query string is allowed);
- no `Upgrade` header and no `Transfer-Encoding`;
- `Content-Length` is absent or exactly `0`;
- the request does not already carry the `__dsh_bridge_retry` marker;
- and either the request carries `Sec-Fetch-*` metadata, in which case `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document` are required (with `Sec-Fetch-Site` and `Sec-Fetch-User` strictly validated when present), or — when no fetch metadata is present at all — `Accept` lists exactly one `text/html` range with `q > 0` and every listed range and parameter parses cleanly.

Everything else — API calls, SSE, WebSocket upgrades, sub-pages, POSTs, uploads — is relayed without any exchange, so an unauthenticated one keeps DSH's native `401`.

**The exchange.** The bridge asks `connection.authenticatedUrl()` for a fresh process-token URL, extracts `token`, and issues one `GET /?token=…` to `127.0.0.1:<dsh port>` with only `Host: <browser's raw Host>` as a header, on a fresh connection, with a 2 s total deadline. It accepts the result only if the response is `303` with `Location: ./`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and exactly one structurally valid `dsh-auth-*` `Set-Cookie`. The response body is never read.

**On success** the browser receives a fixed `200` page: `text/html; charset=utf-8`, `cache-control: no-store`, `referrer-policy: no-referrer`, a CSP pinning the SHA-256 of its single inline script (`default-src 'none'`, `base-uri 'none'`), and the session cookie with `Secure` appended. The inline script calls `location.replace('/?__dsh_bridge_retry=1')`.

**On failure** (factory error, non-`303`, invalid cookie, transport error, timeout, or cancellation) the original upstream `401` is relayed untouched. Nothing is cached and no partial session is stored.

**Retry guard.** A navigation carrying `__dsh_bridge_retry=1` is never exchanged again; if DSH answers it with `200`, the bridge converts that to `303 /` and strips the marker, so a successful bootstrap leaves a clean URL and a failed one cannot loop.

## Troubleshooting

| Symptom / code | Likely cause | Fix |
|---|---|---|
| `ERR_BRIDGE_LOOPBACK_GUARD` | DSH web server is not on `127.0.0.1`, or has no valid port | set `webserver.host: '127.0.0.1'`; `::1` is not supported |
| `ERR_BRIDGE_AUTHORITY_TRUST` | an authority is not covered by `connection.trustedHosts` under DSH semantics, or the list is absent/not a string array | add a covering entry (a bare name covers any port); restart |
| `ERR_BRIDGE_AUTHORITY_TRUST` while a port-specific trusted entry exists | a `host:port` trusted entry cannot cover a port-less authority | add the bare name too, or make the authority carry the port |
| `ValidationError: authorities is required; ...` | the overlay omitted `authorities` | add at least one authority, e.g. the public hostname |
| `authorities entry "..." is not a bare host[:port] authority` | the entry is a spelling WHATWG parsing would rewrite or refuse (userinfo, path, percent-encoding, IDN, shorthand IPv4, non-canonical IPv6, zero-padded or out-of-range port) | write the parsed form exactly, e.g. `host`, `host:port`, or `[v6]:port` |
| `ERR_BRIDGE_LEASE_PATH` | path not absolute, contains `..`, exceeds 107 UTF-8 bytes, or contains NUL | use a short absolute path |
| `ERR_BRIDGE_LEASE_DIRECTORY` | parent/ancestor owner or mode mismatch, or a symlinked ancestor | real directory, euid-owned, strict `0700` (no group/other bits); ancestors root/euid-owned, no group/other write |
| `ERR_BRIDGE_LEASE_LOCK` | lock file is not the same euid-owned `0600` regular inode (a second manager may be replacing it) | stop all instances before touching the lock; keep one owner per path |
| `ERR_BRIDGE_LEASE_CONFLICT` | another instance holds the `flock` | stop the other instance; never delete a live lock |
| `ERR_BRIDGE_LEASE_FLOCK` | util-linux `flock` missing or unusable | install util-linux; on macOS add its keg bin to `PATH` |
| `ERR_BRIDGE_LEASE_STATE` | socket path exists but is not an euid-owned socket, has a live listener, drifted, or bind/chmod failed | inspect the path and the process; do not force-unlink while an instance may be alive |
| `ERR_BRIDGE_DISPOSE_TIMEOUT` / quarantined shutdown | close deadline hit or a close error occurred | plan a full process stop; replacement is blocked until exit |
| `403` for a host that looks valid | not covered by `authorities` (a port-specific entry does not cover a port-less `Host`), or the proxy rewrote `Host` | add a covering entry, or fix `Host` preservation |
| `400` for a `Host` | WHATWG URL parsing refuses the value: whitespace/control characters, an invalid or out-of-range port, unbracketed IPv6 | send a parseable `Host` |
| External clients can authenticate as `localhost` | a loopback authority is configured behind a public proxy that forwards `Host` unchanged | remove the loopback authority, or force the proxy to rewrite/reject `Host` |
| Page loads but never authenticates | request is not a document navigation (missing or invalid `Sec-Fetch-*`, or no single `text/html` in `Accept`), or the exchange is failing, or a `Secure` cookie is rejected on plain HTTP | check the DSH-side `303`/`Set-Cookie` contract; use HTTPS |
| Bootstrap loops `/?__dsh_bridge_retry=1` | DSH keeps answering `401` after a valid exchange | inspect the exchange contract (cookie shape, Host) rather than retrying |

## Compatibility

The exact peers above are a compatibility **proposal**; do not publish them as a support claim until the gates pass against that version.

### DSH contract anchors

The bridge relies on exactly these DSH behaviors and fails closed if they change:

- `ctx.connection.authenticatedUrl()` returns a tokenized loopback URL;
- `GET /?token=<t>` answers `303` with `Location: ./`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and one `dsh-auth-*` cookie;
- `401` semantics for unauthenticated requests;
- authority-bound cookies;
- `ctx.webServer.host`/`ctx.webServer.port`, with the web server bound to `127.0.0.1`;
- the active `connection` trusted-host list that drives the Host/Origin fence.

If DSH removes or changes any of these, the bridge must stop auto-bootstrap and return the original `401` — never synthesize cookies, read the signing secret, inject a fixed token, or bypass DSH auth.

### Migration notes

**DSH 0.2.1-rc migration.** The web-runtime row (`@deepseek-ai/dsh-web-app`) no longer owns `trustedHosts`, and the `webRuntime` service is gone. The connection row (`@deepseek-ai/dsh-client-connection`) owns the Host/Origin fence and its active `trustedHosts` list. This bridge therefore injects `[connection, webServer]` and cross-checks `authorities` against the live connection list. A deployment overlay written for an older alpha that still puts `trustedHosts` on the web-runtime row must move that key to the `connection` row; current web-runtime schemas reject the old key.

**DSH 0.2.2-rc.1 migration.** The 0.2.1-rc contract is unchanged: the connection-owned Host/Origin fence, `authenticatedUrl()`, `ctx.webServer.host/port`, and the token-exchange/401 semantics all still match. The peer pins move together to DSH `0.2.2-rc.1`, Cordis `4.1.0`, and Schemastery `3.19.0`. Cordis 4.1.0 fixes the `ctx.plugin()` wrapper-`restart()` defect that T-DSH4b used to pin, so that test now asserts the fixed ordering (consumers see the service only after its async `Service.init` settles).

### 0.1.0-rc.2 Specifications and Migration

Version `0.1.0-rc.2` advances the pinned compatibility baseline to `@deepseek-ai/dsh` `0.2.2-rc.2` (with Cordis `4.1.0` and Schemastery `3.19.0`) and introduces `pnpm run sync-dsh` (`scripts/sync-dsh-baseline.mjs`) for automated latest-baseline synchronization with full gate verification and atomic rollback.

### 0.1.0-rc.1 Specifications and Migration

Version `0.1.0-rc.1` is the Release Candidate baseline for production deployment, solidifying:
1. **Multi-channel release pipeline & guards:** Formal release gate generalizing across `alpha` and `rc` distribution channels with strict channel-matching tags and provenance.
2. **Reverse proxy grammar validation:** Optional binary syntax verification (`nginx -t`, `caddy validate`) for deployment examples, preventing configuration drift.
3. **Architecture & Header boundaries:** Request-direction `Authorization` stripping to isolate proxy credentials from DSH, RFC 9110 `Via: 1.1 dsh-web-bridge` upstream tracing, strict RFC 9112 duplicate Host rejection, and seamless IPv4/IPv6 loopback upstream forwarding.
4. **Filesystem DAC & Socket security:** Strict `0600`/`0700` and group `0660`/`02710`/`02750` Unix domain socket leasing with euid validation, `flock` mutual exclusion, and parent directory traversal verification.

### 0.1.0-alpha.7 Migration (from 0.1.0-alpha.6)

Version `0.1.0-alpha.7` rolls up architecture improvements since `0.1.0-alpha.6`:
1. **Authority syntax & empty bundle default:** `authorities` now accepts ports, IPv4, bracketed IPv6, and `localhost`. The shipped bundle no longer carries placeholder example domains; a deployment overlay is mandatory.
2. **Header boundary:** Inbound `Authorization` is stripped on the request direction to keep proxy credentials out of DSH; response direction is untouched. Inbound `Via: 1.1 dsh-web-bridge` is appended upstream per RFC 9110.
3. **Network conformance:** Strict 400 rejection on duplicate Host headers (RFC 9112 Section 7.2) and seamless IPv6 loopback (`::1`) upstream proxying.
4. **Socket permissions:** Socket directory permissions admit `0770` / `02770` group sharing and Linux sticky `/tmp`.

### Upgrade checklist

After any DSH upgrade, before claiming compatibility:

1. Rerun the **T-DSH contract probes** against the new pinned installation (focused runner, `.test-dist-probes`): token exchange `303`+cookie shape (T-DSH1), cookie matrix (T-DSH5), rotation/reactivation semantics (T-DSH6/7/10), trust fence (T-DSH8), `authorizeIndex` method matrix (T-DSH9), Cordis lifecycle (T-DSH4/4b).
2. Rerun the **T-B browser layer** (focused runner, `.test-dist-browser`).
3. Rerun the full local release gate — commands, prerequisites, and what counts as PASS/BLOCKED are in [`MAINTAINING.md`](https://github.com/zapsaang/dsh-web-bridge/blob/main/MAINTAINING.md#local-release-gate-all-green-before-packing).
4. Recheck the contract anchors above.

### Deployment verification gates

Status of the deployment verification gates. "PASS (test layer)" means the behavior is pinned by an automated test layer in this repository; it is not production evidence. NOT RUN gates list their missing prerequisites honestly — none may be claimed from synthetic substitutes.

| Gate | Status | Evidence / missing prerequisite |
|---|---|---|
| V1 Host preservation | NOT RUN | Requires the bridge deployed behind a real cloudflared tunnel. Test-layer anchor: T-H1 (raw Host fidelity, PASS). |
| V2 real Edge SSO | NOT RUN | Requires a real Edge Access policy and allowed/denied test identities with MFA. |
| V3 / V-CF connector verifier | PASS (isolated harness) | Pinned cloudflared (`18cdfe0a6fc7b72a0702d255a1f984e776ce0498`) with an injected harness test driving the original `NewJWTValidator` against local synthetic JWKS: missing/wrong-aud → 403, any-of audience match → pass-through, forged/expired → verify error with zero origin hits. Negative control red first. |
| V4 Unix DAC (strict) | PASS | Strict mode only. T-H14a/T-H14b green under root: other-UID connect gets EACCES; the suite skips privilege dropping where `setpriv` is unavailable. T-P3 asserts socket mode `0600`. |
| V4-group socket access | PASS (CI) | Formal Linux gate (`scripts/check-socket-access-linux.mjs` + `test/http/socket-access-linux.test.ts`, explicit sudo on CI, publish workflow ubuntu-24.04) green: `groupPositive=4 strictNegative=2`. Published since `0.1.0-alpha.3`. A10 deployment ACL/credential verification remains NOT RUN. |
| V5 clean browser | NOT RUN | Requires an effective `printUrl: false` deployment and an incognito Access login end-to-end. Test-layer anchor: T-B layer with stub Access (PASS). |
| V6 stale recovery | NOT RUN | Requires deployment-state cookie tampering / secret rotation. Test-layer anchors: T-DSH6, T-DSH10 against pinned DSH (PASS). |
| V7 real-device browsers | NOT RUN | Requires physical iOS/Android (incl. PWA) and desktop dual-hostname plus loopback-direct regression. |
| T-P2 bundle activation | PARTIAL | Verified in an isolated profile (`dsh plugin --profile web add` of the real tarball): new bundle selected by default, disabled bundle not re-enabled on re-add, plain package without `dsh.bundle.patch` gets no row, inserted row shape exact. Runtime boot of the profile is BLOCKED on this machine by a DSH CLI native-addon failure (`node-addon-require-builtin`, pre-plugin-load, identical with and without the bridge) — unrelated to the bridge; rerun where the DSH CLI boots. |

V1 failure stops the deployment. The gate table was last reviewed on 2026-11-08.

### Real-environment acceptance records

Date-stamped deployment evidence. Test-layer PASS and static example checks are not production evidence; each NOT RUN row names the missing prerequisite.

| Item | Status | Date | Missing prerequisite |
|---|---|---|---|
| Nginx + HTTPS + Basic Auth + UDS (login, expiry recovery, SSE, WS) | NOT RUN | 2026-11-08 | no `nginx` binary on the maintainer machine; `examples/nginx.conf` passes the static checker only |
| Caddy + HTTPS + access control + UDS (login, expiry recovery, SSE, WS) | NOT RUN | 2026-11-08 | no `caddy` binary; static checker only |
| Cloudflare Tunnel + Access regression | NOT RUN | 2026-11-08 | no `cloudflared`/zone; V1, V2, V5 remain NOT RUN |
| Denied external identity reaches zero bridge requests | NOT RUN | 2026-11-08 | requires a live access layer and request accounting |
| Local UDS client probes against a real deployment | NOT RUN | 2026-11-08 | socket/DAC test suites PASS; deployment A10 NOT RUN |
| V4 strict DAC / group socket access | PASS (test + CI) | 2026-11-08 | same-UID and CI evidence only; deployment path ACLs A10 NOT RUN |
| V6 stale-session recovery | NOT RUN | 2026-11-08 | requires deployment cookie tampering / secret rotation |
| V7 real-device browsers (desktop, iOS/Android, PWA) | NOT RUN | 2026-11-08 | physical devices |

No row may be upgraded from synthetic substitutes. Deployment A10 (path ACLs, connector credentials, access-layer policy) remains **NOT RUN**.

Recording an acceptance run: date, access-layer version and config hash, bridge/DSH versions, `nginx -t` or `caddy validate` output for the copied file, and the four probes (first visit, session-expiry recovery, SSE, WebSocket). For a denied identity, record that the access layer rejected the request and that the bridge observed **zero** requests.

### Stability evidence

A shortened **2-hour soak** of the HTTP/SSE/WebSocket profile completed with **0 readiness failures**, flat file descriptors, and a flat JS heap; the full **24-hour** soak is **NOT RUN**. Under sustained high-churn traffic, deploy with `MALLOC_ARENA_MAX=2`: the resident-memory growth observed in that soak was attributed to glibc malloc arena retention, not a bridge leak. Full evidence, toolchain, and reproduction notes live in [`MAINTAINING.md`](https://github.com/zapsaang/dsh-web-bridge/blob/main/MAINTAINING.md#verification-evidence).

## License

MIT — see [`LICENSE`](https://github.com/zapsaang/dsh-web-bridge/blob/main/LICENSE).
