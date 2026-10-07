# dsh-web-bridge

Unix-socket session bridge that puts a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web GUI behind Cloudflare Access. The bridge is a Cordis plugin that runs inside the DSH process, listens only on a Unix domain socket, and performs the loopback token exchange on behalf of browsers that arrive through the tunnel — so launch tokens never leave the local machine and never appear in a remote URL, log, or address bar.

Authoritative specification: `docs/dsh-web-bridge-design.md` (section references below, e.g. §12.1, point into that document).

## Installation

Pinned alpha peers (exact versions, no ranges — §10.2):

| Peer | Version |
|---|---|
| `@deepseek-ai/dsh` | `0.2.1-alpha.1` |
| `@deepseek-ai/cordis` | `4.0.5-alpha.1` |
| `@deepseek-ai/schemastery` | `3.18.5-alpha.1` |

Runtime: Node `>=24.21.0 <25` plus the util-linux `flock` system tool.

Install into the web profile (the CLI forwards the remaining arguments to pnpm inside the profile directory, §10.3):

```sh
dsh plugin --profile web add dsh-web-bridge@0.1.0-alpha.1
```

**Activation mechanism.** The package's `package.json` carries `dsh.bundle.patch: ["./cordis.patch.yml"]`; the profile loader (`bundlePatchPaths`) reads that metadata and applies the shipped patch as one bundle layer. The patch is a single append-mode `insert` row:

```yaml
- insert:
    - id: dsh-web-bridge
      name: dsh-web-bridge
      inject: [connection, webServer, webRuntime]
      config:
        socketPath: /run/dsh-web/session-bridge.sock
        authorities: [dsh.example.com, dsh2.example.com]
```

Installing the package is not the same as enabling it: CLI bundle selection comes from the plugin-manager reconcile — a newly added bundle with `dsh.bundle` metadata is selected by default, an already-installed-but-disabled dependency is **not** re-enabled, and a package without `dsh.bundle` metadata stays a plain dependency (§10.3). A live process is not readiness; see "Readiness" below.

**DSH-side overlay.** The deployment must also restate the webserver / web-runtime rows so the DSH web server stays on loopback and never prints a tokenized URL (§12.1 — a patch replaces a row's whole config, so every owned key is restated):

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
    publicUrl: !!js ctx.webStartup.publicUrl   # alpha only; omit the whole line on rc2
    trustedHosts: !!js "['dsh.example.com', 'dsh2.example.com', ...ctx.webStartup.trustedHosts]"
```

The `connection` row is left untouched; it inherits the merged `trustedHosts` through `ctx.webRuntime.trustedHosts`.

## Cloudflare Access configuration

Topology (full example in `examples/cloudflared.yml`, §12.2): cloudflared terminates TLS and Access, then connects to the bridge over the Unix socket. Each public hostname gets its own ingress rule with its own Access application audience tag:

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

- Every rule sets `access.required: true`; bypassing Access is the main residual remote threat (§11).
- **Do not set `httpHostHeader`.** cloudflared's Unix-origin code path does not read it (§3.1), and the deployment depends on the original public `Host` value reaching DSH unchanged — the DSH trust fence and the bridge authority list both match on it. Gate V1 exists to prove this preservation and stops the deployment if it fails.
- One Access application (one `audTag`) per hostname; tags are not shared across rules.

## trustedHosts vs. authorities

Three deliberately different lists (§12.1) — do not mirror them:

1. **bridge `authorities`** — only the public names the bridge may bootstrap (here: the two public hostnames). Canonical bare DNS names: lowercase, no port, no wildcard, no IP literal (schema-enforced).
2. **web-runtime `trustedHosts`** — the two public names **plus** any CLI `--trusted-host` extras.
3. **connection `trustedHosts`** — inherits list 2 verbatim.

At startup the bridge cross-checks that every configured authority is a bare (port-less) entry of the **active** `ctx.webRuntime.trustedHosts` (§12.1). A missing entry, a port-bearing entry, or a runtime without a trusted-host list fails closed with `ERR_BRIDGE_AUTHORITY_TRUST` before any socket is created. CLI extras remain valid for the native fence but never become bridge-approved authorities.

## tmpfiles and directory permissions

`examples/dsh-web.tmpfiles.conf` (§12.3):

```ini
# /etc/tmpfiles.d/dsh-web.conf
d /run/dsh-web 0700 dsh dsh -
```

- Directory `0700` owned by the `dsh` user; the socket itself is `0600`. cloudflared runs as a root system service and can connect to the `dsh`-owned socket; no other-UID sharing scheme is introduced.
- The `-` age field disables age-based cleanup. tmpfiles or systemd must never remove or replace the lock inode or its parent directory while any cooperating instance may be alive. If a unit uses `RuntimeDirectory`, set `RuntimeDirectoryPreserve=yes`; a failed competing unit stopping must not delete the active owner's inode. Operator cleanup is allowed only after confirming all instances have stopped.

## Threat model (operational summary, §11)

Who owns which boundary:

- **Cloudflare Access / cloudflared** owns JWT verification at the edge and in the connector. The bridge **never** verifies Access JWTs and never sees them: `Cf-Access-Jwt-Assertion` and `Authorization` are stripped/never logged, and a nominated `Connection` header cannot smuggle them (I6).
- **DSH** owns session-cookie signing and verification, the Host/Origin/Fetch-Metadata trust fence, and the token exchange endpoint. The bridge performs only structural cookie checks and appends `Secure` to DSH-issued cookies (I4, I13); it preserves raw `Host`, `Origin`, and fetch-metadata headers untouched (I5, I6).
- **The bridge** owns: the Unix-socket listener (I8, I9), the authority list above, the loopback-only token exchange (launch tokens never leave the machine — I1/I2/I3), bootstrap HTML with a pinned-hash CSP, and hop-by-hop header filtering.

Accepted local trust domains: a same-UID process and root are inside the trusted computing base (cooperative lease discipline only). The main remote residual risks are Access/tunnel misconfiguration and compromised Access accounts (mitigated by MFA/policy); revocation of already-upgraded WebSockets is not instant — see the §13.3 runbook.

## Deployment verification gates

Status of the §13 gates. "PASS (test layer)" means the behavior is pinned by an automated test layer in this repository; it is not production evidence. NOT RUN gates list their missing prerequisites honestly — none may be claimed from synthetic substitutes.

| Gate | Status | Evidence / missing prerequisite |
|---|---|---|
| V1 Host preservation | NOT RUN | Requires the bridge deployed behind a real cloudflared tunnel. Test-layer anchor: T-H1 (raw Host fidelity, PASS). |
| V2 real Edge SSO | NOT RUN | Requires a real Edge Access policy and allowed/denied test identities with MFA. |
| V3 / V-CF connector verifier | PASS (isolated harness) | Pinned cloudflared (`18cdfe0a6fc7b72a0702d255a1f984e776ce0498`) with an injected harness test driving the original `NewJWTValidator` against local synthetic JWKS: missing/wrong-aud → 403, any-of audience match → pass-through, forged/expired → verify error with zero origin hits. Negative control red first. |
| V4 Unix DAC | PASS | T-H14a/T-H14b green under root: other-UID connect gets EACCES; the suite skips privilege dropping where `setpriv` is unavailable. T-P3 asserts socket mode `0600`. |
| V5 clean browser | NOT RUN | Requires an effective `printUrl: false` deployment and an incognito Access login end-to-end. Test-layer anchor: T-B layer with stub Access (PASS). |
| V6 stale recovery | NOT RUN | Requires deployment-state cookie tampering / secret rotation. Test-layer anchors: T-DSH6, T-DSH10 against pinned DSH (PASS). |
| V7 real-device browsers | NOT RUN | Requires physical iOS/Android (incl. PWA) and desktop dual-hostname plus loopback-direct regression. |
| T-P2 bundle activation | PARTIAL | Verified in an isolated profile (`dsh plugin --profile web add` of the real tarball): new bundle selected by default, disabled bundle not re-enabled on re-add, plain package without `dsh.bundle.patch` gets no row, inserted row shape exact. Runtime boot of the profile is BLOCKED on this machine by a DSH CLI native-addon failure (`node-addon-require-builtin`, pre-plugin-load, identical with and without the bridge) — unrelated to the bridge; rerun where the DSH CLI boots. |

V1 failure stops the deployment (§15 slice 6).

## Upgrade checklist

After any DSH upgrade, before claiming compatibility (§16):

1. Rerun the **T-DSH contract probes** against the new pinned installation (focused runner, `.test-dist-probes`): token exchange 303+cookie shape (T-DSH1), cookie matrix (T-DSH5), rotation/reactivation semantics (T-DSH6/7/10), trust fence (T-DSH8), `authorizeIndex` method matrix (T-DSH9), Cordis lifecycle (T-DSH4/4b).
2. Rerun the **T-B browser layer** (focused runner, `.test-dist-browser`).
3. Rerun the full default gate: `corepack pnpm run typecheck && corepack pnpm run build && corepack pnpm run test && node scripts/check-pack-files.mjs`.
4. Contract anchors the bridge relies on (§16): `ctx.connection.authenticatedUrl()`, `GET /?token=` → 303 + Set-Cookie, 401 semantics, authority-bound cookies, `ctx.webServer.host/port`, active `ctx.webRuntime.trustedHosts`. If DSH removes or changes any of these, the bridge must stop auto-bootstrap and return the original 401 — never synthesize cookies, read the signing secret, inject a fixed token, or bypass DSH auth.

The exact alpha peers above are a compatibility **proposal**; do not publish them as a support claim until these gates pass against that version.

## Logging policy (§12.4)

Allowed: startup/shutdown, socket path, owner/mode, DSH port, the first authority, bootstrap success/failure (error code only), upstream unavailability, dispose completion.

Forbidden — must never appear in any log: tokens, tokenized URLs, cookie values, `Cf-Access-Jwt-Assertion`, `Authorization`, complete `Cookie` headers. T-U9 pins this with synthetic secrets driven through every log path.

## Soak status

- A **2-hour shortened soak** of the T-H15 profile completed (log `soak-2h.jsonl`): 937k stub HTTP + 233k real-DSH navigations (each with a real token exchange) + 89k DSH API calls, 420k SSE events, 1,066 WebSocket sessions, 2,043 slow readers, 106k mid-upload aborts, 119 bridge restarts and 39 real DSH reloads. **0 readiness failures** (readiness = the full 401 → exchange → bootstrap → marker → clean-200 cycle), fds flat (57 → 53), `heapUsed` flat (24.0 → 25.5 MB).
- **RSS finding**: resident memory grew 187 → 249 MB (1.34×) over 2 h while the JS heap stayed flat. Isolation arms attribute this to glibc malloc arena retention under high-churn small native allocations (llhttp/zlib/socket buffers), not a bridge leak: a reload-only arm was flat-to-negative, a traffic-only arm grew ~2 MB/min, and the same traffic arm under `MALLOC_ARENA_MAX=2` cut the slope 7.7× while serving more requests. **Deploy with `MALLOC_ARENA_MAX=2`** (standard for long-lived Node services).
- The full **24-hour** T-H15 soak remains a future run and is NOT RUN (user-scoped decision: shortened 2 h accepted for this delivery).
- Harness note: the original soak harness lacked teardown for persistent SSE/WS/slow-reader connections and hung after the duration elapsed; fixed (in-flight registry + bounded shutdown) and re-verified — both the SIGTERM path and the duration path now exit 0 with a summary event.
- T-H14b (other-UID DAC denial) passes under root; it is a permanent test that skips in non-privileged environments where `setpriv` cannot drop to a foreign UID.
