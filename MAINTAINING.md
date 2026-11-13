# Maintaining `@zapsaang/dsh-web-bridge`

Maintainer-only material: local toolchain, the release gate, verification
evidence, and the npm publishing workflow. This file is repository-only and is
**not** part of the npm tarball (`files` ships `lib` and `cordis.patch.yml`);
user documentation lives in [`README.md`](README.md).

## Toolchain

- Node `24.21.0`, npm `>=11.5.1`, pnpm `12.9.1` (development via corepack); `tar` plus the util-linux `flock` binary. The `promote-latest` CI job additionally installs `npm@11.21.1`: OIDC `npm dist-tag` requires npm `>=11.21.0` (or `>=12.2.0`), and Node `24.21.0` bundles npm 11.19.0.
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

## Local release gate (all green before packing)

```sh
set -e                                          # any failed or BLOCKED gate stops before packing
corepack pnpm run typecheck && corepack pnpm run build && corepack pnpm run test
node --test .test-dist/test/dsh/*.test.js
corepack pnpm exec playwright install chromium   # project-pinned Chromium, before browser tests
node --test .test-dist/test/browser/*.test.js
corepack pnpm exec tsc -p tsconfig.test.json --outDir .test-dist-linux
node_path=$(node -p 'process.execPath')           # retain the pinned Node path across sudo
sudo -- env PATH="$PATH" "$node_path" scripts/check-socket-access-linux.mjs  # privileged Linux A7-A9
node scripts/check-examples.mjs                  # deployment examples vs overlay
node scripts/check-pack-files.mjs                # pack allowlist check
```

Run the formal entry on a privileged Linux runner before packing, not as a skipped developer test or a macOS substitute. The foreign-UID workers must be able to traverse every ancestor of the workspace and read the compiled output and `node_modules` — a private home directory (for example `0750` homes, the ubuntu-24.04 default) makes the worker die at module load with a misleading `MODULE_NOT_FOUND`; open the traverse bit (`sudo chmod o+x "$HOME"`) or run from a non-private path first. **BLOCKED is nonzero (exit 2), never PASS**; assertion/runtime failures exit 1. Even a formal A7-A9 PASS leaves deployment A10 NOT RUN until the actual deployment's path ACLs and connector credentials are verified.

`prepack` runs `npm run build` as the pack gate, so `npm pack`/`npm publish` do not require pnpm on PATH.

## Pack, inspect, dry-run

```sh
npm pack                                              # real tarball
tar -tzf ./zapsaang-dsh-web-bridge-0.1.0-rc.3.tgz    # inspect contents
npm publish ./zapsaang-dsh-web-bridge-0.1.0-rc.3.tgz --dry-run --tag rc --access public --registry https://registry.npmjs.org/
```

Do not pass `--provenance` locally; provenance comes from CI OIDC only, and a dry run is not proof of authentication or provenance. Per the npm docs, a relative tarball/folder package-spec must begin with an explicit `./` prefix; absolute paths are also accepted.

A scoped package packs under a **flattened** filename — npm drops the leading `@` and turns the scope separator into a dash — so `@zapsaang/dsh-web-bridge` produces `zapsaang-dsh-web-bridge-<version>.tgz`.

## Verification evidence

### Historical local baseline

Historical local baseline (2026-11-08; Linux, Node 24.21.0, `@deepseek-ai/dsh` `0.2.2-rc.1`, Cordis `4.1.0`, Schemastery `3.19.0`, util-linux `flock` 2.41.5), not current group-feature proof or a current release verdict: `typecheck` and `build` clean; default gate 540 tests → 537 pass, 0 fail, 3 skipped; DSH suite 62/62; browser suite 7/7; `check-pack-files.mjs` PASS (30 packed files). The three skips are T-H14b (needs `setpriv` to drop to a foreign UID), A7-A9 (needs a real Linux `/proc` and Unix DAC), and the foreign-owner A3 case (needs root). A host sandbox that blocks `chmod` of the setgid bit also fails the group-mode fixtures; run that gate outside such a sandbox. The `flock` dependency is the one environment prerequisite that is easy to miss: without it the whole lease layer fails with `ERR_BRIDGE_LEASE_FLOCK` rather than a clear "tool missing" message.

Latest local gate (2026-11-08, authority normalization + header boundary + examples): `typecheck` and `build` clean; default gate **677 tests → 674 pass, 0 fail, 3 skipped** (the example gate has a positive and a negative control); DSH suite **69/69**; browser suite **7/7**; `check-examples.mjs` **PASS**; `check-pack-files.mjs` **PASS (32 packed files)** — the two extra files over the pre-authority baseline are `lib/lib/authority.js` and `lib/lib/authority.d.ts`. The browser fixture now passes `--no-proxy-server` so a host system proxy cannot intercept the offline resolver map. Deployment examples are static-checked only; `nginx -t`, `caddy validate`, and real-environment acceptance remain deployment-side (see the README records table).

### Functional evidence (same UID only)

Fresh compiled configuration/group checks passed **24/24**, and readiness checks passed **27/27**. Independent real-server probes observed zero HTTP response bytes on all four pre-ready events at both chmod and final-stat barriers; after validation, navigation/API returned **200** and WebSocket upgrade returned **101**, with accepted-connection closure and the original successful native close callback observed on disposal. The public built `apply` with real pinned DSH passed native cookie bootstrap and protected `/api/native-probe` checks, **401 without a cookie / 200 with the issued cookie**, for omitted and explicit strict and both group directory modes (`02710`, `02750`). These same-UID results are **not cross-UID acceptance** or production ACL/credential evidence. The pinned DSH and browser regression suites passed **60/60** and **7/7**, respectively.

### Soak status

- **PASS (24h bounded soak)**: Full 24-hour (1,440 minutes / 86,391 s) T-H15 soak completed cleanly under `MALLOC_ARENA_MAX=2` (log `soak-24h-rc1.jsonl`): **11,236,697** stub HTTP requests + **2,787,054** real-DSH navigations (each with native token exchange & session bootstrap) + **1,069,102** DSH API probes, **5,050,525** SSE events across 33,750 sessions, **1,072,337** WebSocket messages across 21,609 sessions, **25,058** slow readers, **1,281,146** mid-upload aborts, **1,439** bridge hot-reloads (1/min) and **479** real DSH cold reloads (1/3 min).
- **0 readiness failures**: Every post-reload readiness probe (testing full 401 $\rightarrow$ token exchange $\rightarrow$ bootstrap $\rightarrow$ cookie issuance $\rightarrow$ clean 200 cycle) and the final shutdown probes passed within milliseconds (`counters.readinessFailures === 0`).
- **Bounded RSS plateau (0.72% second-half growth)**: With `MALLOC_ARENA_MAX=2`, RSS settled into a stable working plateau at ~247.5 MB by hour 2 and grew from 251.0 MB at hour 12 to 252.8 MB at hour 24 (+1.8 MB / +0.72% over the entire second half, well inside the $\le 5\%$ pass threshold). glibc malloc arena fragmentation retention was completely bounded over 24 hours of sustained load.
- **V8 JS heap bounded**: `heapUsed` hovered strictly within the baseline window (20–35 MB; `firstMean` 25.9 MB, `lastMean` 31.7 MB, average ~27.5 MB) with complete garbage collection and zero closure or event listener leaks.
- **FDs flat (zero leak)**: File descriptors stayed flat (`firstMean` 61 vs `lastMean` 62, `growthRatio: 1.006`), closing cleanly with zero lingering sockets or pipes on shutdown.
- Historical note: Prior 2-hour shortened soak (`soak-2h.jsonl`) had confirmed the initial slope reduction under `MALLOC_ARENA_MAX=2`. The 24-hour soak now provides certified empirical production evidence for `0.1.0-rc.1`.
- Harness note: persistent connections register with bounded shutdown; harness exits 0 with complete summary telemetry.
- T-H14b (other-UID DAC denial) passes under root; it is a permanent test that skips in non-privileged environments where `setpriv` cannot drop to a foreign UID.

## Releasing

Maintainer instructions, not a record of completed actions. The package already exists on the registry — the maintainer bootstrapped it interactively (`0.0.0-stage` placeholder, then `0.1.0-alpha.1`), so releases now go through the tag-triggered workflow below. Published versions are immutable; every fix needs a new version — current 0.1.0-rc.3; rolls up one-way cross-channel `latest` promotion (`alpha -> rc -> stable`) in `promote-latest.mjs`, `@deepseek-ai/dsh` `0.2.2-rc.2` baseline synchronization and `sync-dsh`, alongside multi-channel release pipeline generalization, deployment example syntax verification, authority generalization, header boundary enforcement, and HTTP conformance. README changes only reach the npm page if they land before packing/publishing that version.

The published name is **scoped** (`@zapsaang/dsh-web-bridge`). npm rejects the unscoped `dsh-web-bridge` with a 403 because it is too similar to the existing `dsh-webbridge` package, and that similarity check cannot be appealed — so do not "simplify" the name back to unscoped. The scope is also part of the Cordis load contract: the profile loader resolves the patch row's `name` as a bare module specifier, so `package.json`, `cordis.patch.yml`, and the plugin's exported `name` must always move together. The unscoped name has never been published; the bootstrap created the scoped `@zapsaang/dsh-web-bridge`.

### First publication (bootstrap, already done)

The package was bootstrapped once by the maintainer with an interactive login (2FA) and an explicit tarball publish — `0.1.0-alpha.1` and the `0.0.0-stage` placeholder are on the registry — so this step is not needed again:

```sh
npm login --registry=https://registry.npmjs.org/
npm publish ./zapsaang-dsh-web-bridge-0.1.0-alpha.1.tgz --tag alpha --access public --registry https://registry.npmjs.org/
```

### npm Trusted Publisher

Once the package exists, configure the Trusted Publisher on the `@zapsaang/dsh-web-bridge` npm package for the next unpublished version: GitHub owner `zapsaang`, repository `dsh-web-bridge` (the npm scope and the repository name deliberately differ — the package is scoped, the repo is not), workflow filename `publish.yml`, and an **empty** Environment field; on new settings select **Allow npm publish** and also enable **Allow npm dist-tag** (stage-only is the default); the dist-tag permission is what lets the `promote-latest` job move `latest` over OIDC, and it is independent of the publish permission. The workflow deliberately declares no `environment:`, so the two sides must stay consistent — naming an environment here that the job does not use (or the reverse) makes npm reject the OIDC exchange. Existing connections cannot change their provider fields, but their allowed actions can be updated in place; if the settings UI refuses the change, delete and recreate the connection and land the next publish within 48 hours to validate it. An initial successful OIDC release must land within 2 days of configuration or it expires and must be recreated. See https://docs.npmjs.com/trusted-publishers/.

### Release workflow (`.github/workflows/publish.yml`)

- Two triggers: pushing a tag named `v<version>` (for example `v0.1.0-rc.3`) publishes automatically, and manual `workflow_dispatch` stays available. Dispatch inputs: `expected_version` (required, must match `package.json`, format `X.Y.Z-(alpha|rc).N`) and `publish` (boolean, default `false`). A tag trigger always publishes; a dispatch publishes only with `publish: true` on `refs/heads/main`.
- The tag name is the single source of truth for the version. The version-resolution step strips an optional `v` prefix, exports it as `EXPECTED_VERSION`, and `scripts/check-release.mjs` then requires the ref to be either `refs/heads/main` or a tag naming exactly that version, plus a manifest carrying the same version. Tag-only glob filters (`v*`) are deliberate: Actions branch/tag filters are globs, not regexes, so the strict `X.Y.Z-(alpha|rc).N` check lives in the guard.

```sh
git switch main && git pull --ff-only
git tag -a v0.1.0-rc.3 -m "0.1.0-rc.3"
git push origin v0.1.0-rc.3
```

- The tag must point at a commit that is already on `main`: `verify` re-checks ancestry with `git merge-base --is-ancestor` against `origin/main`, which is why its checkout uses `fetch-depth: 0`. It must also contain the workflow file you intend to run — a tag on an older commit runs that commit's workflow revision.
- Keep the trigger in `publish.yml`. The npm Trusted Publisher is bound to that workflow **filename** (plus its empty environment field), so a second workflow file would require reconfiguring the publisher (and an initial OIDC publish within 2 days of that change). That is also why `promote-latest` is a job in this file rather than its own workflow.
- Job `verify`: full gates (typecheck/build/default tests plus the explicit compiled DSH and browser suites), project-pinned Chromium install, and the compiled privileged formal Linux A7-A9 matrix via `sudo` with the pinned Node path, then real `npm pack` and tarball inspection, `npm publish <tarball> --dry-run`, uploads the tarball as an artifact. A BLOCKED formal gate stops the job before packing; deployment A10 is separate.
- Job `publish`: runs when the trigger is a tag, or when a dispatch passes `publish: true` on `main`; permissions `contents: read, id-token: write`; OIDC Trusted Publisher authentication, no `NPM_TOKEN`. Publishes the exact verified tarball artifact (checksum re-verified), never a rebuild.
- Job `promote-latest`: runs only after `publish` succeeded. It reads the registry's current `latest`, derives the channel of the released version from its version string (`alpha` for `-alpha.N`, `rc` for `-rc.N`, `stable` for no suffix), and runs `npm dist-tag add @zapsaang/dsh-web-bridge@<version> latest` when the released version is strictly newer **and** its channel does not regress (`alpha -> rc -> stable` one-way forward promotion is automatic; `rc -> alpha`, `stable -> rc`, or `stable -> alpha` skip with `channel-downgrade`). Any other state — no `latest`, an unparsable current tag such as `0.0.0-stage`, an equal or older version, or a channel downgrade — is a no-op that exits 0 with the reason in the run summary. It authenticates with OIDC (`contents: read, id-token: write`, no `NPM_TOKEN`) and installs `npm@11.21.1` because Node 24.21.0's npm 11.19.0 cannot manage dist-tags over OIDC; the publish job keeps using the bundled npm. npm normally answers the publish request before the version document is readable ("being processed and may take a few minutes"), so the job polls the version document for up to 180 attempts × 10 s (30 minutes; `PROMOTE_LATEST_PUBLISH_ATTEMPTS` / `PROMOTE_LATEST_PUBLISH_DELAY_MS`) before moving `latest`; a version that never appears still fails closed. The job is idempotent, so if it fails after the publish succeeded, `Re-run failed jobs` re-runs only `promote-latest`.
- `latest` never moves backwards across channels (`stable -> rc/alpha` or `rc -> alpha`); reverting `latest` backwards remains a deliberate manual maintainer action with an authenticated CLI:

```sh
npm dist-tag add @zapsaang/dsh-web-bridge@<version> latest
```

- There is no GitHub Environment, so a tag push publishes **unattended** — no approval step, matching the tag-triggered OIDC setup in the other `zapsaang` npm packages. The gates on this path are the deliberate tag push itself, job `verify`, and the release guard's requirement that the tag name equals the reviewed `package.json` version. Restoring a required-reviewer gate means re-adding `environment: npm` here, setting the same environment in the npm Trusted Publisher config, and allowing the `v*` tag pattern under that environment's "Deployment branches and tags" — a `main`-only rule there blocks a tag-triggered job before OIDC runs.
- Automatic provenance applies only when **both** the GitHub repository and the npm package are public.
- After an authorized publish, verify separately, e.g. for `0.1.0-rc.3`:

```sh
npm view @zapsaang/dsh-web-bridge@0.1.0-rc.3 version dist.attestations --json
npm view @zapsaang/dsh-web-bridge dist-tags --json
```

  and inspect the version page (https://www.npmjs.com/package/@zapsaang/dsh-web-bridge/v/0.1.0-rc.3) for the provenance indicator. The `promote-latest` job records the current `latest`, the released version, and the move/skip reason in the run summary; `npm view @zapsaang/dsh-web-bridge dist-tags --json` is the registry-side check.

### Installing from npm

Check what actually exists: `npm view @zapsaang/dsh-web-bridge dist-tags --json`. Prefer explicit versions (`@zapsaang/dsh-web-bridge@0.1.0-rc.3`) or `@rc`; on a first publication the tag layout can vary, so inspect the registry rather than assuming `latest` exists or that `alpha` can never point at the newest version. `latest` is moved forward automatically by CI within the same channel or one-way along `alpha -> rc -> stable`, and never downgrades channels automatically; moving backwards across channels requires a manual maintainer action.
