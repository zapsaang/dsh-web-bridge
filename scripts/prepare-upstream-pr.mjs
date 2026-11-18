#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/*
 * Automated helper for upstream DSH tracking under Plan B:
 * 1. Checks npm for newer @deepseek-ai/dsh versions.
 * 2. If newer, bumps the plugin's RC version (e.g. 0.1.0-rc.5 -> 0.1.0-rc.6).
 * 3. Runs sync-dsh-baseline.mjs to update dependencies, pnpm-lock, and run baseline gates.
 * 4. Updates package.json, README.md, and MAINTAINING.md with release candidate metadata.
 * 5. Re-runs packaging and pack-file verification.
 * 6. Emits structured PR metadata for CI automation.
 *
 * Usage:
 *   node scripts/prepare-upstream-pr.mjs [--check-only] [--target-dsh VER] [--root DIR] [--json]
 */

const DSH_PKG = '@deepseek-ai/dsh';
const CORDIS_PKG = '@deepseek-ai/cordis';
const SCHEMASTERY_PKG = '@deepseek-ai/schemastery';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|rc)\.(0|[1-9]\d*))?$/;
const CHANNEL_RANK = { alpha: 0, rc: 1, stable: 2 };

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

const bumpRcVersion = (version) => {
  const parsed = parseVersion(version);
  assert.ok(parsed !== null, `invalid version ${version}`);
  assert.equal(parsed.channel, 'rc', `auto-bump only supports rc channel, got ${parsed.channel}`);
  assert.ok(parsed.prerelease !== null, `rc version must have prerelease number`);
  const nextPrerelease = parsed.prerelease + 1;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}-rc.${nextPrerelease}`;
};

const requestJson = async (url) => {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  }
  return await response.json();
};

const resolveLatestDsh = async (baseUrl) => {
  const escapedDsh = encodeURIComponent(DSH_PKG);
  const tags = await requestJson(`${baseUrl}/-/package/${escapedDsh}/dist-tags`);
  let best = null;
  for (const name of ['latest', 'next']) {
    if (typeof tags[name] !== 'string') continue;
    const parsed = parseVersion(tags[name]);
    if (parsed === null) continue;
    if (best === null || compareVersions(parsed, best) > 0) best = parsed;
  }
  assert.ok(best !== null, 'could not resolve latest/next tag on @deepseek-ai/dsh');
  return best;
};

const updateReadmeReleaseMetadata = (readmeText, currentVersion, nextVersion, targetDsh, cordisVer, schemasteryVer) => {
  let updated = readmeText;

  // 1. Status: Release Candidate (0.1.0-rc.X)
  const statusPattern = new RegExp(`(Release Candidate \\()${currentVersion.replace(/\./g, '\\.')}(\\))`, 'g');
  assert.ok(statusPattern.test(updated), `README missing Release Candidate (${currentVersion}) status`);
  updated = updated.replace(statusPattern, `$1${nextVersion}$2`);

  // 2. Install command: add @zapsaang/dsh-web-bridge@0.1.0-rc.X
  const installPattern = new RegExp(`(@zapsaang/dsh-web-bridge@)${currentVersion.replace(/\./g, '\\.')}`, 'g');
  assert.ok(installPattern.test(updated), `README missing install command with @${currentVersion}`);
  updated = updated.replace(installPattern, `$1${nextVersion}`);

  // 3. New Migration and Specification section at the top of ### Migration notes
  const sectionHeader = `### ${nextVersion} Specifications and Migration`;
  if (!updated.includes(sectionHeader)) {
    const migrationAnchor = '### Migration notes\n';
    assert.ok(updated.includes(migrationAnchor), 'README missing ### Migration notes anchor');

    const newSection = [
      '',
      sectionHeader,
      '',
      `Version \`${nextVersion}\` advances the pinned compatibility baseline to \`@deepseek-ai/dsh\` \`${targetDsh}\` (with Cordis \`${cordisVer}\` and Schemastery \`${schemasteryVer}\`) via automated upstream synchronization.`,
      '',
    ].join('\n');

    updated = updated.replace(migrationAnchor, `${migrationAnchor}${newSection}`);
  }

  return updated;
};

const updateMaintainingMetadata = (maintainingText, currentVersion, nextVersion, targetDsh) => {
  let updated = maintainingText;
  const escapedCurrent = currentVersion.replace(/\./g, '\\.');

  // Replace tarball names and tag commands
  updated = updated.replace(new RegExp(escapedCurrent, 'g'), nextVersion);
  return updated;
};

const parseArguments = (argv) => {
  let checkOnly = false;
  let targetDsh;
  let root = process.cwd();
  let json = false;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check-only') checkOnly = true;
    else if (arg === '--json') json = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--target-dsh') {
      index += 1;
      assert.ok(argv[index], '--target-dsh requires a version string');
      targetDsh = argv[index];
    } else if (arg === '--root') {
      index += 1;
      assert.ok(argv[index], '--root requires a directory');
      root = argv[index];
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return { checkOnly, targetDsh, root: resolve(root), json, dryRun };
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  const pkgPath = join(options.root, 'package.json');
  const readmePath = join(options.root, 'README.md');
  const maintainingPath = join(options.root, 'MAINTAINING.md');
  const lockPath = join(options.root, 'pnpm-lock.yaml');

  const pkgRaw = readFileSync(pkgPath, 'utf8');
  const manifest = JSON.parse(pkgRaw);
  const currentDshRaw = manifest.peerDependencies?.[DSH_PKG];
  assert.ok(currentDshRaw, `package.json missing peerDependencies.${DSH_PKG}`);
  const currentDsh = parseVersion(currentDshRaw);
  assert.ok(currentDsh !== null, `invalid current DSH version ${currentDshRaw}`);

  const registry = manifest.publishConfig?.registry ?? DEFAULT_REGISTRY;
  const baseUrl = registry.replace(/\/+$/, '');

  let targetDsh;
  if (options.targetDsh !== undefined) {
    targetDsh = parseVersion(options.targetDsh);
    assert.ok(targetDsh !== null, `invalid target DSH version ${options.targetDsh}`);
  } else {
    targetDsh = await resolveLatestDsh(baseUrl);
  }

  const isNewer = compareVersions(targetDsh, currentDsh) > 0;
  const currentPluginVersion = manifest.version;
  const nextPluginVersion = isNewer ? bumpRcVersion(currentPluginVersion) : currentPluginVersion;
  const branchName = `chore/sync-dsh-${targetDsh.raw}`;
  const prTitle = `chore(deps): sync DSH ${targetDsh.raw} baseline and bump to ${nextPluginVersion}`;

  const summary = {
    hasUpdate: isNewer,
    currentDsh: currentDsh.raw,
    targetDsh: targetDsh.raw,
    currentPluginVersion,
    nextPluginVersion,
    branchName,
    prTitle,
  };

  if (options.checkOnly || !isNewer) {
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`prepare-upstream-pr: hasUpdate=${isNewer} currentDsh=${currentDsh.raw} targetDsh=${targetDsh.raw}`);
    }
    return;
  }

  console.log(`prepare-upstream-pr: target DSH ${targetDsh.raw} is newer than current ${currentDsh.raw}. Bumping plugin to ${nextPluginVersion}...`);

  // Backup files for atomic rollback if needed
  const readmeBefore = readFileSync(readmePath, 'utf8');
  const maintainingBefore = readFileSync(maintainingPath, 'utf8');
  const lockBefore = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null;

  try {
    // 1. Run sync-dsh-baseline.mjs to update dependencies and run baseline verification gates
    console.log(`prepare-upstream-pr: executing sync-dsh-baseline for ${targetDsh.raw}...`);
    const syncRes = spawnSync(
      process.execPath,
      ['scripts/sync-dsh-baseline.mjs', '--version', targetDsh.raw, '--root', options.root],
      { cwd: options.root, stdio: 'inherit' }
    );
    if (syncRes.status !== 0) {
      throw new Error(`sync-dsh-baseline exited with code ${syncRes.status}`);
    }

    // 2. Read newly synced manifest (peerDependencies have been upgraded)
    const syncedManifest = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const cordisVer = syncedManifest.peerDependencies[CORDIS_PKG];
    const schemasteryVer = syncedManifest.peerDependencies[SCHEMASTERY_PKG];

    // 3. Bump version in package.json
    syncedManifest.version = nextPluginVersion;
    writeFileSync(pkgPath, `${JSON.stringify(syncedManifest, null, 2)}\n`);

    // 4. Update README.md
    const currentReadme = readFileSync(readmePath, 'utf8');
    const updatedReadme = updateReadmeReleaseMetadata(
      currentReadme,
      currentPluginVersion,
      nextPluginVersion,
      targetDsh.raw,
      cordisVer,
      schemasteryVer
    );
    writeFileSync(readmePath, updatedReadme);

    // 5. Update MAINTAINING.md
    const currentMaintaining = readFileSync(maintainingPath, 'utf8');
    const updatedMaintaining = updateMaintainingMetadata(
      currentMaintaining,
      currentPluginVersion,
      nextPluginVersion,
      targetDsh.raw
    );
    writeFileSync(maintainingPath, updatedMaintaining);

    // 6. Build and verify pack allowlist
    console.log('prepare-upstream-pr: re-building and verifying pack-files allowlist...');
    const buildRes = spawnSync('corepack', ['pnpm', 'run', 'build'], { cwd: options.root, stdio: 'inherit' });
    if (buildRes.status !== 0) throw new Error(`build failed after bump`);

    const packCheckRes = spawnSync(process.execPath, ['scripts/check-pack-files.mjs'], { cwd: options.root, stdio: 'inherit' });
    if (packCheckRes.status !== 0) throw new Error(`check-pack-files failed after bump`);

    const rollback = () => {
      writeFileSync(pkgPath, pkgRaw);
      writeFileSync(readmePath, readmeBefore);
      writeFileSync(maintainingPath, maintainingBefore);
      if (lockBefore !== null) writeFileSync(lockPath, lockBefore);
      else if (existsSync(lockPath)) rmSync(lockPath, { force: true });
      spawnSync('corepack', ['pnpm', 'install', '--frozen-lockfile'], { cwd: options.root, stdio: 'inherit' });
    };

    if (options.dryRun) {
      console.log('prepare-upstream-pr: dry-run enabled; rolling back files...');
      rollback();
      console.log(`prepare-upstream-pr: dry-run successful for ${nextPluginVersion} on DSH ${targetDsh.raw}`);
      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
      }
      return;
    }

    console.log(`prepare-upstream-pr: successfully prepared ${nextPluginVersion} for DSH ${targetDsh.raw}`);
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    }
  } catch (error) {
    console.error(`prepare-upstream-pr: error occurred, rolling back: ${error.message}`);
    writeFileSync(pkgPath, pkgRaw);
    writeFileSync(readmePath, readmeBefore);
    writeFileSync(maintainingPath, maintainingBefore);
    if (lockBefore !== null) writeFileSync(lockPath, lockBefore);
    else if (existsSync(lockPath)) rmSync(lockPath, { force: true });
    spawnSync('corepack', ['pnpm', 'install', '--frozen-lockfile'], { cwd: options.root, stdio: 'inherit' });
    process.exitCode = 1;
  }
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
