# Cloudflare Tunnel + Access deployment example

This example shows one way to put the bridge behind Cloudflare: `cloudflared`
terminates TLS and Cloudflare Access, then connects to the bridge over the Unix
domain socket. Nothing here is Cloudflare-specific inside the plugin — the same
socket, the same authority list, and the same session bootstrap serve Nginx,
Caddy, HAProxy, or a trusted local client.

`examples/` files are repository-only: they are **not** part of the npm tarball
(`files` ships `lib` and `cordis.patch.yml` only).

**Status of this example.** It is an operator starting point, not CI-verified
end-to-end. Gates V1 (Host preservation through a real tunnel), V2 (real Access
SSO), V5 (clean browser), and V7 (real-device browsers) are **NOT RUN**; see the
gate table in the README. The tunnel-side behavior depends on your Cloudflare
zone, Access applications, and MFA policy.

`scripts/check-examples.mjs` statically checks this file and
[`cloudflared.yml`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/cloudflared.yml)
on every CI run: the socket path and authority must match
[`overlay.example.yml`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/overlay.example.yml),
each hostname rule must require Access with its own `audTag`, the catch-all 404
must stay last, and `httpHostHeader` must remain absent. It does not contact
Cloudflare.

## Prerequisites

- The DSH web server bound to `127.0.0.1` with a valid port. This is a hard
  requirement: the bridge fails closed with `ERR_BRIDGE_LOOPBACK_GUARD`
  otherwise. A DSH listening on `::1` or a LAN address cannot use it as-is.
- The bridge installed into the DSH profile and enabled, with an overlay that
  supplies `authorities`. The shipped bundle carries only `socketPath`, so the
  plugin fails to load until the overlay exists; start from
  [`overlay.example.yml`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/overlay.example.yml).

  ```sh
  dsh plugin --profile web add @zapsaang/dsh-web-bridge@0.1.0-alpha.6
  ```

- A Cloudflare tunnel with one ingress rule per public hostname, and one Access
  application (one audience tag) per hostname. Access is the **remote**
  authentication boundary; the bridge never verifies Access JWTs.
- A Linux host with `/run/dsh-web` provisioned from
  [`dsh-web.tmpfiles.conf`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/dsh-web.tmpfiles.conf).
  Strict mode (default) creates the directory `0700`, owner `dsh`; the socket is
  `0600`. A root-run `cloudflared` can still connect to a `dsh`-owned socket.

## Topology

```text
Browser ──HTTPS──► Cloudflare edge (TLS + Access policy)
                       │
                       ▼
                   cloudflared (connector, verifies Access JWT)
                       │  unix:/run/dsh-web/session-bridge.sock
                       ▼
                   DSH Web Bridge (inside the DSH process)
                       │  127.0.0.1:<dsh port>
                       ▼
                   DSH Web Server
```

The bridge sees only the UDS connection. It forwards the verified public `Host`
and, when a root document navigation returns 401, performs the DSH-native token
exchange over loopback and answers with a fixed CSP page that re-navigates.

## 1. Bridge overlay

Cordis patch config is replaced **wholesale**, not deep-merged, so the overlay
row must restate every key it needs. `socketAccess` may be omitted to select the
strict default.

```yaml
- id: dsh-web-bridge
  name: '@zapsaang/dsh-web-bridge'
  inject: [connection, webServer]
  config:
    socketPath: /run/dsh-web/session-bridge.sock
    authorities: [dsh.example.com, dsh2.example.com]
```

`authorities` follows the same WHATWG rule DSH applies to `trustedHosts`:
`host`, `host:port`, IPv4, bracketed IPv6, and `localhost` all work. A bare name
matches any port and `host:port` is exact. Cloudflare forwards the public `Host`
without a port, so the bare names above are the right shape unless the tunnel
terminates on a non-standard port.

## 2. DSH-side overlay

Keep the web server on loopback and give the connection row the Host/Origin
fence list. Every non-loopback bridge authority must be covered by
`connection.trustedHosts` under DSH semantics — a bare name covers any port, a
`host:port` entry is exact, and a port-specific entry does not cover a port-less
authority. Otherwise startup fails with `ERR_BRIDGE_AUTHORITY_TRUST` before a
socket is created.

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
    trustedHosts: !!js "['dsh.example.com', 'dsh2.example.com', ...ctx.webStartup.trustedHosts]"
```

## 3. Ingress

Full file: [`cloudflared.yml`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/cloudflared.yml).

```yaml
ingress:
  - hostname: dsh.example.com
    service: unix:/run/dsh-web/session-bridge.sock
    originRequest:
      access:
        required: true
        teamName: <team>
        audTag: [<aud-dsh-example-com>]
  - hostname: dsh2.example.com
    service: unix:/run/dsh-web/session-bridge.sock
    originRequest:
      access:
        required: true
        teamName: <team>
        audTag: [<aud-dsh2-example-com>]
  - service: http_status:404
```

- Every public hostname gets `access.required: true`. A tunnel ingress without
  an Access application is an unauthenticated path to the DSH session.
- One Access application (one `audTag`) per hostname; tags are not shared across
  rules.
- **Do not set `originRequest.httpHostHeader`.** cloudflared's Unix-origin code
  path does not apply it, and the deployment depends on the original public
  `Host` reaching DSH unchanged — both the bridge authority list and the DSH
  Host fence match on it. Gate V1 exists to prove this preservation.
- Keep the final catch-all rule (`http_status:404`) so unknown hostnames never
  reach the socket.

## 4. Permissions

Provision the runtime directory before first start; the plugin never creates,
chowns, or chmods it. Strict mode (one active line):

```ini
d /run/dsh-web 0700 dsh dsh -
```

Group mode is opt-in and needs **both** the `socketAccess: group` overlay key
and the matching `02710` (or `02750`) tmpfiles line from the same configuration
owner. Enabling one without the other fails closed. See the README "Security
Model" for ancestor, lock, ACL, and revocation rules.

## 5. Verification

Start DSH, then probe the socket directly — this isolates the bridge from
Cloudflare:

```sh
# Wrong authority: bridge rejects before any upstream connection.
curl --unix-socket /run/dsh-web/session-bridge.sock \
  -H 'Host: other.example.com' -i http://localhost/          # expect 403

# Non-navigation client: forwarded, upstream 401 is relayed untouched.
curl --unix-socket /run/dsh-web/session-bridge.sock \
  -H 'Host: dsh.example.com' -i http://localhost/            # expect 401

# Navigation client (no Sec-Fetch-* headers, Accept: text/html): bootstrap.
curl --unix-socket /run/dsh-web/session-bridge.sock \
  -H 'Host: dsh.example.com' -H 'Accept: text/html' -i http://localhost/
# expect 200 + text/html + a dsh-auth-* Set-Cookie carrying Secure
```

Then repeat through the tunnel with an unauthenticated browser:

1. **First visit** — Access login appears; after it, DSH loads. The address bar
   never contains `?token=` (the exchange runs over loopback only).
2. **Session expiry** — clear the `dsh-auth-*` cookie, reload `/`: one exchange,
   a `200` bootstrap page, then a `303` to `/` and a working page. Other paths
   keep their native `401`.
3. **Refresh** — repeated reloads do not loop; the `__dsh_bridge_retry` marker is
   stripped on the re-navigation.
4. **SSE** — streaming responses arrive incrementally (no proxy buffering).
5. **WebSocket** — upgrade returns `101` and messages flow both ways.
6. **Host preservation (V1)** — the same probes above must return the same
   status through the tunnel; a rewritten `Host` yields `403` from the bridge
   or a rejection from DSH.

Record the Cloudflare-side results with date, `cloudflared` version, and zone;
"the page loaded" is not V1/V2/V5/V7 evidence.

## Security notes

- **Access is the boundary for remote users.** Revoking an identity at Cloudflare
  does not close already-upgraded WebSockets instantly, and does not revoke DSH
  cookies already issued. Treat connection draining and cookie revocation as
  separate operational steps.
- **The bridge does not trust identity headers.** `Cf-Access-Jwt-Assertion` is
  stripped in both directions as defensive sanitation; it never grants standing,
  and the bridge never verifies an Access JWT. Cloudflare's own verifier does.
  `Authorization` is stripped on the request direction as of `0.1.0-alpha.8`
  (the response direction is untouched).
- **Cookies pass through.** The bridge forwards the `Cookie` header untouched and
  appends `Secure` to `dsh-auth-*` `Set-Cookie` values. It does not strip a
  `CF_Authorization` cookie. Keep that separation in mind when auditing what
  reaches DSH.
- **Do not expose the ingress without Access.** The plugin adds no remote user
  authentication of its own; a plain tunnel is only transport encryption.
- **Never configure a loopback authority on a public tunnel.** DSH accepts
  `Host: localhost`, `127.0.0.1`, `[::1]`, and its own bind address
  unconditionally. If a public proxy forwards `Host` unchanged and the bridge
  also allows a loopback authority, an external request can pass both fences and
  receive a loopback-audience cookie. Keep `authorities` to the public hostnames
  and let the proxy deliver them unchanged.
