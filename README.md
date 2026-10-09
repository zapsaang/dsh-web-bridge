# @zapsaang/dsh-web-bridge

> **Status: experimental alpha.** The pinned alpha peers below are a compatibility proposal, not a support claim, and several deployment verification gates are NOT RUN or PARTIAL — see "Deployment verification gates" before treating any of this as supported.

Unix-socket session bridge that puts a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web GUI behind Cloudflare Access. The bridge is a Cordis plugin that runs inside the DSH process, listens only on a Unix domain socket, and performs the loopback token exchange on behalf of browsers that arrive through the tunnel — so launch tokens never leave the local machine and never appear in a remote URL, log, or address bar.

The `§` section references below (e.g. §12.1) point into an internal design document that is **not published in this repository**, so they are stable labels for the topics they annotate rather than reachable links. The `examples/` files are repository paths, not part of the npm tarball — browse them on GitHub.

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
dsh plugin --profile web add @zapsaang/dsh-web-bridge@0.1.0-alpha.1
```

**Activation mechanism.** The package's `package.json` carries `dsh.bundle.patch: ["./cordis.patch.yml"]`; the profile loader (`bundlePatchPaths`) reads that metadata and applies the shipped patch as one bundle layer. The patch is a single append-mode `insert` row:

```yaml
- insert:
    - id: dsh-web-bridge
      name: '@zapsaang/dsh-web-bridge'
      inject: [connection, webServer, webRuntime]
      config:
        socketPath: /run/dsh-web/session-bridge.sock
        authorities: [dsh.example.com, dsh2.example.com]
```

The shipped bundle intentionally keeps exactly two config keys (`socketPath`, `authorities`). Omitting `socketAccess` selects the default **strict** socket mode; the raw bundle does not carry the key.

**Group mode (opt-in, local overlay only).** Shared-group socket access is **implemented and published since `0.1.0-alpha.3`**, with the privileged Linux cross-UID acceptance gate (A7-A9) **PASS on CI** (`groupPositive=4 strictNegative=2`); deployment verification (A10) is still **NOT RUN**. See "tmpfiles and directory permissions" below. To provision for it, the deployment adds its own overlay row that restates the bridge config with the explicit third key:

```yaml
- id: dsh-web-bridge
  name: '@zapsaang/dsh-web-bridge'
  inject: [connection, webServer, webRuntime]
  config:
    socketPath: /run/dsh-web/session-bridge.sock
    socketAccess: group
    authorities: [dsh.example.com, dsh2.example.com]
```

The overlay only takes effect together with the matching group-mode tmpfiles line; enabling one without the other fails closed at startup.

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

Topology (full example in [`examples/cloudflared.yml`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/cloudflared.yml), §12.2): cloudflared terminates TLS and Access, then connects to the bridge over the Unix socket. Each public hostname gets its own ingress rule with its own Access application audience tag:

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

[`examples/dsh-web.tmpfiles.conf`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/dsh-web.tmpfiles.conf) (§12.3) carries one **active** directive and two commented, mutually exclusive alternatives for the same path:

```ini
# /etc/tmpfiles.d/dsh-web.conf
d /run/dsh-web 0700 dsh dsh -
# group mode (opt-in; enable at most ONE of these, never alongside the strict line):
# d /run/dsh-web 02710 dsh dsh-bridge -   # preferred: group traverse, no list
# d /run/dsh-web 02750 dsh dsh-bridge -   # discovery: group may also list
```

**Strict mode (default).** Directory `0700` owned by the `dsh` user; the socket itself is `0600` and the lock file is `0600`. cloudflared runs as a root system service and can connect to the `dsh`-owned socket; no other-UID sharing is active. Strict deployments may keep `0700`-owned ancestors anywhere on the path.

**Group mode (opt-in, implemented locally; unpublished).** The operator pre-creates the directory as setgid `02710` (preferred: group members traverse but cannot list) or `02750` (discovery: group members may list), owner `dsh`, group a dedicated bridge group such as `dsh-bridge`. No group write, no permissions for others. The socket is created `0660` and inherits the directory GID through setgid; the lock stays `0600`, so group members can connect but cannot create, delete, or rename anything in the directory. Enabling group mode is two coordinated steps from one configuration owner: the `socketAccess: group` overlay row and the matching tmpfiles line (owner, group, path, mode). The plugin never creates, chowns, or chmods the directory itself, and never falls back if the predicates do not match. Mode `02750` is setgid, not sticky.

- **Trust semantics.** Group membership equals full DSH Web access. Any process whose primary or supplementary groups hit the shared group can reach the socket, trigger bootstrap, and read real DSH `Set-Cookie` values; no Cloudflare or cloudflared needs to be present. `Host`, `Accept`, `Sec-Fetch-*`, `Cf-Access-Jwt-Assertion`, and `Authorization` headers are not local identity and grant no standing; the bridge adds no such check. Choose the directory group as the authorization decision and use a dedicated group per bridge so revocation and auditing stay cheap.
- **Ancestors.** In group mode every ancestor on the socket path must be traversable by the connecting service accounts (for example an unprivileged cloudflared) with no group/other write. Private home directories and `/run/user/UID` roots block group peers and must not host the socket.
- **Lock and age discipline.** The `-` age field disables age-based cleanup. tmpfiles or systemd must never remove, replace, truncate, or age-clean the lock inode or its parent directory while any cooperating instance may be alive. If a unit uses `RuntimeDirectory`, set `RuntimeDirectoryPreserve=yes`; a failed competing unit stopping must not delete the active owner's inode. There must be no competing owner or chmod manager for the same path. Operator cleanup is allowed only after confirming all instances have stopped.
- **Mode switch.** Changing strict to group or back is never an online operation. Stop all cooperating instances (every bridge instance and every connector), change the config overlay and the tmpfiles owner/group/mode together, refresh the connecting services' credentials (primary group and supplementary groups), then do a full start. Cordis pending restart, update, and reload do not perform this switch.
- **Shutdown quarantine.** A shutdown that hits its deadline or a close error enters quarantine: the lease is held, no retry or reset is attempted, and replacement is blocked until the entire process stops (the OS then reaps the fds). Plan a full process stop, not a plugin swap, after any quarantined shutdown error.
- **Readiness.** Ready means the lease checks completed: verified directory, lock acquired, bind, chmod, re-check. Listening or a live pid is not readiness, and connections made before ready are not served.
- **Revocation limits.** Removing a member from the group, or any DAC change, does not close existing open connections and does not revoke already issued DSH cookies. Treat connection draining and cookie revocation as separate operational steps.
- **ACL stance (deployment gate).** Every layer of the path, the socket, and the lock must carry only the base `user::` / `group::` / `other::` ACL entries, which are equivalent to the mode. Named entries, mask-only entries, and default ACLs at any layer are unsupported. mode/gid alone cannot exclude mask or named entries, so inspect every layer plus the socket plus the lock, read-only, with `getfacl -p <path>` (`-p` retains the leading slash on absolute paths, not relative paths; `setfacl -m` modifies ACLs and is not an inspection command) together with `stat`. The plugin does not detect ACLs; this is operator-side only, checked before enabling group mode.
- **Functional evidence (same UID only).** Fresh compiled configuration/group checks passed **24/24**, and readiness checks passed **27/27**. Independent real-server probes observed zero HTTP response bytes on all four pre-ready events at both chmod and final-stat barriers; after validation, navigation/API returned **200** and WebSocket upgrade returned **101**, with accepted-connection closure and the original successful native close callback observed on disposal. The public built `apply` with real pinned DSH passed native cookie bootstrap and protected `/api/native-probe` checks, **401 without a cookie / 200 with the issued cookie**, for omitted and explicit strict and both group directory modes (`02710`, `02750`). These same-UID results are **not cross-UID acceptance** or production ACL/credential evidence. The pinned DSH and browser regression suites passed **60/60** and **7/7**, respectively.
- **Gate status (honest).** The formal Linux group gate is `scripts/check-socket-access-linux.mjs` (run with plain node, no test framework) together with `test/http/socket-access-linux.test.ts`; on CI it runs under an explicit `sudo` by the orchestrator and never edits groups or accounts automatically. The gate **passes on CI** (publish workflow, ubuntu-24.04, `groupPositive=4 strictNegative=2`). The local formal command on the maintainer machine still returns **exit 2** (`getfacl` unavailable and UID 1000 cannot drop to a foreign UID — `setpriv` reports operation not permitted), which remains a developer-privilege skip, not a product verdict; run the formal entry on a privileged Linux runner for a local verdict. Deployment-side stat/ACL and connector credential-refresh verification (A10) and any production deployment remain **NOT RUN**.

## Threat model (operational summary, §11)

Who owns which boundary:

- **Cloudflare Access / cloudflared** owns JWT verification at the edge and in the connector. The bridge **never** verifies Access JWTs and never sees them: `Cf-Access-Jwt-Assertion` and `Authorization` are stripped/never logged, and a nominated `Connection` header cannot smuggle them (I6).
- **DSH** owns session-cookie signing and verification, the Host/Origin/Fetch-Metadata trust fence, and the token exchange endpoint. The bridge performs only structural cookie checks and appends `Secure` to DSH-issued cookies (I4, I13); it preserves raw `Host`, `Origin`, and fetch-metadata headers untouched (I5, I6).
- **The bridge** owns: the Unix-socket listener (I8, I9), the authority list above, the loopback-only token exchange (launch tokens never leave the machine — I1/I2/I3), bootstrap HTML with a pinned-hash CSP, and hop-by-hop header filtering.

Accepted local trust domains: a same-UID process and root are inside the trusted computing base (cooperative lease discipline only). The implemented opt-in group mode extends that trust domain to every member of the shared bridge group, with no per-user or per-session isolation inside the group. The main remote residual risks are Access/tunnel misconfiguration and compromised Access accounts (mitigated by MFA/policy); revocation of already-upgraded WebSockets is not instant, see the §13.3 runbook.

## Deployment verification gates

Status of the §13 gates. "PASS (test layer)" means the behavior is pinned by an automated test layer in this repository; it is not production evidence. NOT RUN gates list their missing prerequisites honestly — none may be claimed from synthetic substitutes.

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

## Publishing

Maintainer instructions, not a record of completed actions. The package already exists on the registry — the maintainer bootstrapped it interactively (`0.0.0-stage` placeholder, then `0.1.0-alpha.1`), so releases now go through the tag-triggered workflow below. Published versions are immutable; every fix needs a new version — current `0.1.0-alpha.2`, next new version e.g. `0.1.0-alpha.3`. README changes only reach the npm page if they land before packing/publishing that version.

The published name is **scoped** (`@zapsaang/dsh-web-bridge`). npm rejects the unscoped `dsh-web-bridge` with a 403 because it is too similar to the existing `dsh-webbridge` package, and that similarity check cannot be appealed — so do not "simplify" the name back to unscoped. The scope is also part of the Cordis load contract: the profile loader resolves the patch row's `name` as a bare module specifier, so `package.json`, `cordis.patch.yml`, and the plugin's exported `name` must always move together. The unscoped name has never been published; the bootstrap created the scoped `@zapsaang/dsh-web-bridge`.

### Toolchain

- Node `24.21.0`, npm `>=11.5.1`, pnpm `12.9.1` (development via corepack); `tar` plus the util-linux `flock` binary.
- The formal Linux A7-A9 gate also needs `getfacl` (ACL inspection) and util-linux `setpriv` (cross-UID/group probes), plus privileges sufficient to switch UID/GID and supplementary groups. These are Linux gate tools, not plugin dependencies; the gate does not install tools or change system groups/accounts.
- The deployment target is Linux. The lease layer spawns the `flock(1)` helper, so the test suite needs it on `PATH`; on macOS it comes from Homebrew, which installs util-linux keg-only and therefore does **not** link `flock` into `PATH` for you:

```sh
export PATH="$(brew --prefix)/opt/util-linux/bin:$PATH"   # macOS only
flock --version                                           # must resolve before running tests
```

- Frozen install: `corepack pnpm install --frozen-lockfile`.
- Tests that bind a private `XDG_RUNTIME_DIR` need a private directory whose ancestor chain is real directories (`$HOME` works). `mktemp -d` already creates it `0700`, which is exactly what the lease directory check requires, so no `umask` change is needed. `/tmp` and `$TMPDIR` do **not** work on macOS: both live under `/var`, which is a symlink to `private/var`, and the ancestor rule rejects symlinks with `ERR_BRIDGE_LEASE_DIRECTORY`.

```sh
export XDG_RUNTIME_DIR="$(mktemp -d "$HOME/.dsh-test.XXXXXX")"
```

### Local release gate (all green before packing)

```sh
set -e                                          # any failed or BLOCKED gate stops before packing
corepack pnpm run typecheck && corepack pnpm run build && corepack pnpm run test
node --test .test-dist/test/dsh/*.test.js
corepack pnpm exec playwright install chromium   # project-pinned Chromium, before browser tests
node --test .test-dist/test/browser/*.test.js
corepack pnpm exec tsc -p tsconfig.test.json --outDir .test-dist-linux
node_path=$(node -p 'process.execPath')           # retain the pinned Node path across sudo
sudo -- env PATH="$PATH" "$node_path" scripts/check-socket-access-linux.mjs  # privileged Linux A7-A9
node scripts/check-pack-files.mjs                # pack allowlist check
```

Run the formal entry on a privileged Linux runner before packing, not as a skipped developer test or a macOS substitute. The foreign-UID workers must be able to traverse every ancestor of the workspace and read the compiled output and `node_modules` — a private home directory (for example `0750` homes, the ubuntu-24.04 default) makes the worker die at module load with a misleading `MODULE_NOT_FOUND`; open the traverse bit (`sudo chmod o+x "$HOME"`) or run from a non-private path first. **BLOCKED is nonzero (exit 2), never PASS**; assertion/runtime failures exit 1. Even a formal A7-A9 PASS leaves deployment A10 NOT RUN until the actual deployment's path ACLs and connector credentials are verified.

`prepack` runs `npm run build` as the pack gate, so `npm pack`/`npm publish` do not require pnpm on PATH.

Historical local baseline (2026-10-07; macOS 15.7.9, Node 24.21.0, util-linux `flock` 2.42.4), not current group-feature proof or a current release verdict: `typecheck` and `build` clean; default gate 423 tests → 422 pass, 0 fail, 1 skipped; DSH suite 60/60; browser suite 7/7; `check-pack-files.mjs` PASS (18 packed files). The single skip is T-H14b, which needs `setpriv` to drop to a foreign UID. The `flock` dependency is the one environment prerequisite that is easy to miss: without it the whole lease layer fails with `ERR_BRIDGE_LEASE_FLOCK` rather than a clear "tool missing" message.

### Pack, inspect, dry-run

```sh
npm pack                                              # real tarball
tar -tzf ./zapsaang-dsh-web-bridge-0.1.0-alpha.1.tgz  # inspect contents
npm publish ./zapsaang-dsh-web-bridge-0.1.0-alpha.1.tgz --dry-run --tag alpha --access public --registry https://registry.npmjs.org/
```

Do not pass `--provenance` locally; provenance comes from CI OIDC only, and a dry run is not proof of authentication or provenance. Per the npm docs, a relative tarball/folder package-spec must begin with an explicit `./` prefix; absolute paths are also accepted.

A scoped package packs under a **flattened** filename — npm drops the leading `@` and turns the scope separator into a dash — so `@zapsaang/dsh-web-bridge` produces `zapsaang-dsh-web-bridge-<version>.tgz`.

### First publication (bootstrap, already done)

The package was bootstrapped once by the maintainer with an interactive login (2FA) and an explicit tarball publish — `0.1.0-alpha.1` and the `0.0.0-stage` placeholder are on the registry — so this step is not needed again:

```sh
npm login --registry=https://registry.npmjs.org/
npm publish ./zapsaang-dsh-web-bridge-0.1.0-alpha.1.tgz --tag alpha --access public --registry https://registry.npmjs.org/
```

### npm Trusted Publisher

Once the package exists, configure the Trusted Publisher on the `@zapsaang/dsh-web-bridge` npm package for the next unpublished version: GitHub owner `zapsaang`, repository `dsh-web-bridge` (the npm scope and the repository name deliberately differ — the package is scoped, the repo is not), workflow filename `publish.yml`, and an **empty** Environment field; on new settings select **Allow npm publish** (stage-only is the default). The workflow deliberately declares no `environment:`, so the two sides must stay consistent — naming an environment here that the job does not use (or the reverse) makes npm reject the OIDC exchange. A separate dist-tag permission exists but is neither needed nor granted for publishing with `--tag alpha`. An initial successful OIDC release must land within 2 days of configuration or it expires and must be recreated. See https://docs.npmjs.com/trusted-publishers/.

### Release workflow (`.github/workflows/publish.yml`)

- Two triggers: pushing a tag named `v<version>` (for example `v0.1.0-alpha.2`) publishes automatically, and manual `workflow_dispatch` stays available. Dispatch inputs: `expected_version` (required, must match `package.json`, format `X.Y.Z-alpha.N`) and `publish` (boolean, default `false`). A tag trigger always publishes; a dispatch publishes only with `publish: true` on `refs/heads/main`.
- The tag name is the single source of truth for the version. The version-resolution step strips an optional `v` prefix, exports it as `EXPECTED_VERSION`, and `scripts/check-release.mjs` then requires the ref to be either `refs/heads/main` or a tag naming exactly that version, plus a manifest carrying the same version. Tag-only glob filters (`v*`) are deliberate: Actions branch/tag filters are globs, not regexes, so the strict `X.Y.Z-alpha.N` check lives in the guard.

```sh
git switch main && git pull --ff-only
git tag -a v0.1.0-alpha.2 -m "0.1.0-alpha.2"
git push origin v0.1.0-alpha.2
```

- The tag must point at a commit that is already on `main`: `verify` re-checks ancestry with `git merge-base --is-ancestor` against `origin/main`, which is why its checkout uses `fetch-depth: 0`. It must also contain the workflow file you intend to run — a tag on an older commit runs that commit's workflow revision.
- Keep the trigger in `publish.yml`. The npm Trusted Publisher is bound to that workflow **filename** (plus its empty environment field), so a second workflow file would require reconfiguring the publisher (and an initial OIDC publish within 2 days of that change).
- Job `verify`: full gates (typecheck/build/default tests plus the explicit compiled DSH and browser suites), project-pinned Chromium install, and the compiled privileged formal Linux A7-A9 matrix via `sudo` with the pinned Node path, then real `npm pack` and tarball inspection, `npm publish <tarball> --dry-run`, uploads the tarball as an artifact. A BLOCKED formal gate stops the job before packing; deployment A10 is separate.
- Job `publish`: runs when the trigger is a tag, or when a dispatch passes `publish: true` on `main`; permissions `contents: read, id-token: write`; OIDC Trusted Publisher authentication, no `NPM_TOKEN`. Publishes the exact verified tarball artifact (checksum re-verified), never a rebuild.
- There is no GitHub Environment, so a tag push publishes **unattended** — no approval step, matching the tag-triggered OIDC setup in the other `zapsaang` npm packages. The gates on this path are the deliberate tag push itself, job `verify`, and the release guard's requirement that the tag name equals the reviewed `package.json` version. Restoring a required-reviewer gate means re-adding `environment: npm` here, setting the same environment in the npm Trusted Publisher config, and allowing the `v*` tag pattern under that environment's "Deployment branches and tags" — a `main`-only rule there blocks a tag-triggered job before OIDC runs.
- Automatic provenance applies only when **both** the GitHub repository and the npm package are public.
- After an authorized publish, verify separately, e.g. for `0.1.0-alpha.2`:

```sh
npm view @zapsaang/dsh-web-bridge@0.1.0-alpha.2 version dist.attestations --json
npm view @zapsaang/dsh-web-bridge dist-tags --json
```

  and inspect the version page (https://www.npmjs.com/package/@zapsaang/dsh-web-bridge/v/0.1.0-alpha.2) for the provenance indicator.

### Installing from npm

Check what actually exists: `npm view @zapsaang/dsh-web-bridge dist-tags --json`. Prefer explicit versions (`@zapsaang/dsh-web-bridge@0.1.0-alpha.1`) or `@alpha`; on a first publication the tag layout can vary, so inspect the registry rather than assuming `latest` exists or that `alpha` can never point at the newest version. There is no promotion-to-`latest` workflow.
