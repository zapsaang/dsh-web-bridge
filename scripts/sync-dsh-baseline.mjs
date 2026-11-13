#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/*
 * Synchronizes the pinned @deepseek-ai/{dsh,cordis,schemastery} baseline in
 * package.json, README.md, and pnpm-lock.yaml, runs the full verification
 * gates (including @deepseek-ai/dsh-app-boot compatibility admission), and
 * rolls back atomically on any failure.
 *
 * Usage:
 *   node scripts/sync-dsh-baseline.mjs [--version VER | --tag TAG] [--registry URL] [--root DIR] [--dry-run] [--allow-downgrade]
 */

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const DSH_PKG = '@deepseek-ai/dsh';
const CORDIS_PKG = '@deepseek-ai/cordis';
const SCHEMASTERY_PKG = '@deepseek-ai/schemastery';
const PEER_KEYS = [DSH_PKG, CORDIS_PKG, SCHEMASTERY_PKG];
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|rc)\.(0|[1-9]\d*))?$/;
const CHANNEL_RANK = { alpha: 0, rc: 1, stable: 2 };

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const parseVersion = (version) => {
  const match = VERSION_PATTERN.exec(version);
  if (!match) return null;
  return {
    raw: version,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    channel: match[4] ?? 'stable',
    prerelease: match[5] === undefined ? null : Number(match[5]),
  };
};

const compareVersions = (left, right) => {
  for (const part of ['major', 'minor', 'patch']) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  const leftRank = CHANNEL_RANK[left.channel];
  const rightRank = CHANNEL_RANK[right.channel];
  if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
  if (left.prerelease === right.prerelease) return 0;
  return left.prerelease < right.prerelease ? -1 : 1;
};

const satisfiesRange = (candidate, range) => {
  const exact = parseVersion(range);
  if (exact !== null) return compareVersions(candidate, exact) === 0;

  const op = range[0];
  if (op !== '~' && op !== '^') return false;
  const base = parseVersion(range.slice(1));
  if (base === null) return false;
  if (compareVersions(candidate, base) < 0) return false;

  if (candidate.prerelease !== null) {
    if (base.prerelease === null) return false;
    if (candidate.major !== base.major || candidate.minor !== base.minor || candidate.patch !== base.patch) {
      return false;
    }
  }

  if (op === '~') {
    return candidate.major === base.major && candidate.minor === base.minor;
  }
  if (base.major > 0) return candidate.major === base.major;
  if (base.minor > 0) return candidate.major === 0 && candidate.minor === base.minor;
  return candidate.major === 0 && candidate.minor === 0 && candidate.patch === base.patch;
};

const resolveHighestSatisfying = (versions, range, packageName) => {
  let best = null;
  for (const raw of versions) {
    const parsed = parseVersion(raw);
    if (parsed === null || !satisfiesRange(parsed, range)) continue;
    if (best === null || compareVersions(parsed, best) > 0) best = parsed;
  }
  assert.ok(best !== null, `no published ${packageName} version satisfies ${range}`);
  return best.raw;
};

const parseArguments = (argv) => {
  let version;
  let tag;
  let registry;
  let root = process.cwd();
  let dryRun = false;
  let allowDowngrade = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--allow-downgrade') allowDowngrade = true;
    else if (arg === '--version') {
      index += 1;
      assert.ok(argv[index], '--version requires a version string');
      version = argv[index];
    } else if (arg === '--tag') {
      index += 1;
      assert.ok(argv[index], '--tag requires a dist-tag name');
      tag = argv[index];
    } else if (arg === '--registry') {
      index += 1;
      assert.ok(argv[index], '--registry requires a URL');
      registry = argv[index];
    } else if (arg === '--root') {
      index += 1;
      assert.ok(argv[index], '--root requires a directory path');
      root = argv[index];
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  assert.ok(!(version !== undefined && tag !== undefined), '--version and --tag cannot be used together');
  return { version, tag, registry, root: resolve(root), dryRun, allowDowngrade };
};

const requestJson = async (url, accept = 'application/json') => {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const error = new Error(`GET ${url} failed with HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (error?.retryable === false || attempt === 3) break;
      await sleep(250 * attempt);
    }
  }
  throw lastError;
};

const resolveTargetDshVersion = async (baseUrl, options) => {
  if (options.version !== undefined) {
    const parsed = parseVersion(options.version);
    assert.ok(parsed !== null, `invalid target version ${options.version}`);
    return parsed;
  }
  const escapedDsh = encodeURIComponent(DSH_PKG);
  const tags = await requestJson(`${baseUrl}/-/package/${escapedDsh}/dist-tags`);
  assert.ok(tags !== null && typeof tags === 'object' && !Array.isArray(tags),
    'dist-tags response must be an object');
  if (options.tag !== undefined) {
    const tagged = tags[options.tag];
    assert.ok(typeof tagged === 'string', `dist-tag ${options.tag} does not exist on ${DSH_PKG}`);
    const parsed = parseVersion(tagged);
    assert.ok(parsed !== null, `dist-tag ${options.tag} version ${tagged} is not supported`);
    return parsed;
  }
  let best = null;
  for (const name of ['latest', 'next']) {
    if (typeof tags[name] !== 'string') continue;
    const parsed = parseVersion(tags[name]);
    if (parsed === null) continue;
    if (best === null || compareVersions(parsed, best) > 0) best = parsed;
  }
  assert.ok(best !== null, `neither latest nor next dist-tag resolved on ${DSH_PKG}`);
  return best;
};

const resolvePeerTrio = async (baseUrl, targetDsh) => {
  const escapedDsh = encodeURIComponent(DSH_PKG);
  const dshDoc = await requestJson(`${baseUrl}/${escapedDsh}/${encodeURIComponent(targetDsh.raw)}`);
  const deps = dshDoc?.dependencies;
  assert.ok(deps !== null && typeof deps === 'object', `${DSH_PKG}@${targetDsh.raw} missing dependencies`);
  const cordisRange = deps[CORDIS_PKG];
  const schemasteryRange = deps[SCHEMASTERY_PKG];
  assert.ok(typeof cordisRange === 'string', `${DSH_PKG}@${targetDsh.raw} missing ${CORDIS_PKG} dependency`);
  assert.ok(typeof schemasteryRange === 'string', `${DSH_PKG}@${targetDsh.raw} missing ${SCHEMASTERY_PKG} dependency`);

  const fetchVersions = async (pkg) => {
    const doc = await requestJson(
      `${baseUrl}/${encodeURIComponent(pkg)}`,
      'application/vnd.npm.install-v1+json, application/json',
    );
    assert.ok(doc?.versions !== null && typeof doc?.versions === 'object', `${pkg} metadata missing versions`);
    return Object.keys(doc.versions);
  };

  const [cordisVersions, schemasteryVersions] = await Promise.all([
    fetchVersions(CORDIS_PKG),
    fetchVersions(SCHEMASTERY_PKG),
  ]);
  return {
    [DSH_PKG]: targetDsh.raw,
    [CORDIS_PKG]: resolveHighestSatisfying(cordisVersions, cordisRange, CORDIS_PKG),
    [SCHEMASTERY_PKG]: resolveHighestSatisfying(schemasteryVersions, schemasteryRange, SCHEMASTERY_PKG),
  };
};

const updateReadmePeerTable = (readmeText, trio) => {
  let updated = readmeText;
  for (const name of PEER_KEYS) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^(\\|\\s*\`${escaped}\`\\s*\\|\\s*\`)([^\`]+)(\`\\s*\\|)$`, 'm');
    assert.ok(pattern.test(updated), `README.md is missing peer table row for ${name}`);
    updated = updated.replace(pattern, `$1${trio[name]}$3`);
  }
  return updated;
};

const isAlreadySynchronized = (manifest, readmeText, trio) => {
  for (const name of PEER_KEYS) {
    if (manifest.peerDependencies?.[name] !== trio[name]) return false;
    if (manifest.devDependencies?.[name] !== trio[name]) return false;
    if (!readmeText.includes(`| \`${name}\` | \`${trio[name]}\` |`)) return false;
  }
  return true;
};

const cleanChildEnv = () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
};

const runStep = (stepName, command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, env: cleanChildEnv(), stdio: 'inherit' });
  if (result.error) throw new Error(`${stepName} failed to launch: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${stepName} exited with code ${String(result.status ?? result.signal)}`);
  }
};

const listCompiledTests = (root, subdir) => {
  const dir = join(root, '.test-dist/test', subdir);
  assert.ok(existsSync(dir), `missing compiled test directory ${dir}`);
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => join('.test-dist/test', subdir, name));
  assert.ok(files.length > 0, `no compiled tests found in ${dir}`);
  return files;
};

const verifyAppBootAdmission = (root, expectedDsh) => {
  const checkScript = [
    "import assert from 'node:assert/strict';",
    "import { readFileSync, realpathSync } from 'node:fs';",
    "import { createRequire } from 'node:module';",
    "import { join } from 'node:path';",
    "const root = process.cwd();",
    "const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));",
    "const dshPkgPath = join(root, 'node_modules/@deepseek-ai/dsh/package.json');",
    "const dshPkg = JSON.parse(readFileSync(dshPkgPath, 'utf8'));",
    `assert.equal(dshPkg.version, ${JSON.stringify(expectedDsh)});`,
    "const dshRequire = createRequire(realpathSync(dshPkgPath));",
    "const appBoot = await import(dshRequire.resolve('@deepseek-ai/dsh-app-boot'));",
    `assert.equal(appBoot.evaluatePluginCompatibility(manifest, {}, ${JSON.stringify(expectedDsh)}), undefined);`,
  ].join('\n');
  runStep('app-boot-compatibility', process.execPath, ['--input-type=module', '-e', checkScript], root);
};

const runVerificationGates = (root, expectedDsh) => {
  verifyAppBootAdmission(root, expectedDsh);
  runStep('typecheck', 'corepack', ['pnpm', 'run', 'typecheck'], root);
  runStep('build', 'corepack', ['pnpm', 'run', 'build'], root);
  runStep('test', 'corepack', ['pnpm', 'run', 'test'], root);
  runStep('dsh-tests', process.execPath, ['--test', ...listCompiledTests(root, 'dsh')], root);
  if (process.env.SYNC_DSH_SKIP_BROWSER !== '1') {
    runStep('browser-tests', process.execPath, ['--test', ...listCompiledTests(root, 'browser')], root);
  }
  runStep('check-examples', process.execPath, ['scripts/check-examples.mjs'], root);
  runStep('check-pack-files', process.execPath, ['scripts/check-pack-files.mjs'], root);
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  const pkgPath = join(options.root, 'package.json');
  const readmePath = join(options.root, 'README.md');
  const lockPath = join(options.root, 'pnpm-lock.yaml');

  const pkgBefore = readFileSync(pkgPath, 'utf8');
  const readmeBefore = readFileSync(readmePath, 'utf8');
  const lockBefore = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null;
  const manifest = JSON.parse(pkgBefore);

  const registry = options.registry ?? manifest.publishConfig?.registry ?? DEFAULT_REGISTRY;
  assert.ok(typeof registry === 'string' && /^https?:\/\/.+/.test(registry),
    `invalid registry URL ${String(registry)}`);
  const baseUrl = registry.replace(/\/+$/, '');

  const currentDshRaw = manifest.peerDependencies?.[DSH_PKG];
  const currentDsh = typeof currentDshRaw === 'string' ? parseVersion(currentDshRaw) : null;
  const targetDsh = await resolveTargetDshVersion(baseUrl, options);

  if (currentDsh !== null && compareVersions(targetDsh, currentDsh) < 0 && !options.allowDowngrade) {
    if (options.version !== undefined) {
      throw new Error(`refusing downgrade from ${currentDsh.raw} to older ${targetDsh.raw} without --allow-downgrade`);
    }
    console.log(`sync-dsh-baseline: action=skip reason=not-newer current=${currentDsh.raw} target=${targetDsh.raw}`);
    return;
  }

  const trio = await resolvePeerTrio(baseUrl, targetDsh);
  if (isAlreadySynchronized(manifest, readmeBefore, trio)) {
    console.log(
      `sync-dsh-baseline: action=skip reason=already-at-baseline dsh=${trio[DSH_PKG]} cordis=${trio[CORDIS_PKG]} schemastery=${trio[SCHEMASTERY_PKG]}`,
    );
    return;
  }

  if (options.dryRun) {
    console.log(
      `sync-dsh-baseline: action=upgrade target=${trio[DSH_PKG]} cordis=${trio[CORDIS_PKG]} schemastery=${trio[SCHEMASTERY_PKG]} (dry run, no files modified)`,
    );
    return;
  }

  const nextManifest = structuredClone(manifest);
  nextManifest.peerDependencies ??= {};
  nextManifest.devDependencies ??= {};
  for (const name of PEER_KEYS) {
    nextManifest.peerDependencies[name] = trio[name];
    nextManifest.devDependencies[name] = trio[name];
  }

  let installStarted = false;
  let failedStep = 'update-files';
  try {
    writeFileSync(pkgPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
    const nextReadme = updateReadmePeerTable(readmeBefore, trio);
    writeFileSync(readmePath, nextReadme);

    failedStep = 'pnpm-install';
    installStarted = true;
    runStep('pnpm-install', 'corepack', ['pnpm', 'install', '--no-frozen-lockfile'], options.root);

    failedStep = 'verification-gates';
    runVerificationGates(options.root, trio[DSH_PKG]);
  } catch (error) {
    writeFileSync(pkgPath, pkgBefore);
    writeFileSync(readmePath, readmeBefore);
    if (lockBefore !== null) writeFileSync(lockPath, lockBefore);
    else if (existsSync(lockPath)) rmSync(lockPath, { force: true });

    if (installStarted && lockBefore !== null) {
      spawnSync('corepack', ['pnpm', 'install', '--frozen-lockfile'], { cwd: options.root, stdio: 'inherit' });
      spawnSync('corepack', ['pnpm', 'run', 'build'], { cwd: options.root, stdio: 'inherit' });
    }
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`sync-dsh-baseline: action=rollback reason=${failedStep}: ${detail}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `sync-dsh-baseline: action=upgrade target=${trio[DSH_PKG]} cordis=${trio[CORDIS_PKG]} schemastery=${trio[SCHEMASTERY_PKG]}`,
  );
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
