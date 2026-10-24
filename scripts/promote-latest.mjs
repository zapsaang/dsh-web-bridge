#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/*
 * Keeps `latest` on the release channel it currently points at.
 *
 * alpha  -> only a newer alpha moves `latest`
 * rc     -> only a newer rc moves `latest`
 * stable -> only a newer stable moves `latest`
 *
 * Any other state (no `latest`, an unknown suffix, a channel change) is a
 * deliberate no-op: moving `latest` across channels stays a maintainer action.
 *
 * Usage: node scripts/promote-latest.mjs [--dry-run] [--registry URL] [MANIFEST]
 * Environment: EXPECTED_VERSION (required), GITHUB_STEP_SUMMARY (optional)
 */

const PACKAGE_NAME = '@zapsaang/dsh-web-bridge';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|rc)\.(0|[1-9]\d*))?$/;
const DIST_TAG_HINT = 'enable "Allow npm dist-tag" for the publish.yml trusted publisher of '
  + `${PACKAGE_NAME} (npmjs.com -> package settings -> Trusted publishing)`;

const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

const parseVersion = (version) => {
  const match = VERSION_PATTERN.exec(version);
  if (!match) return null;
  return {
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
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
};

const parseArguments = (argv) => {
  let dryRun = false;
  let registry;
  let manifest;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--registry') {
      index += 1;
      assert.ok(argv[index], '--registry requires a URL');
      registry = argv[index];
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown option ${argument}`);
    } else {
      assert.equal(manifest, undefined, 'only one manifest path is allowed');
      manifest = argument;
    }
  }
  return { dryRun, registry, manifest };
};

const requestJson = async (url, { allowNotFound = false } = {}) => {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 404 && allowNotFound) return null;
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

const assertNpmSupportsDistTagOverOidc = () => {
  const version = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  assert.ok(match, `cannot parse npm version ${version}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const supported = (major === 11 && minor >= 21) || (major === 12 && minor >= 2) || major > 12;
  assert.ok(supported, `npm ${version} cannot manage dist-tags over OIDC; install npm@11.21.0+ or npm@12.2.0+`);
};

const recordSummary = (lines) => {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  } catch {
    // The release outcome must not depend on the step summary being writable.
  }
};

const main = async () => {
  const arguments_ = parseArguments(process.argv.slice(2));
  const manifestPath = resolve(arguments_.manifest ?? 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.ok(manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest),
    'manifest must be an object');
  assert.equal(manifest.name, PACKAGE_NAME, 'package identity mismatch');

  const expectedVersion = process.env.EXPECTED_VERSION;
  assert.ok(typeof expectedVersion === 'string' && expectedVersion.length > 0, 'EXPECTED_VERSION is required');
  const target = parseVersion(expectedVersion);
  assert.ok(target, `EXPECTED_VERSION must be X.Y.Z, X.Y.Z-alpha.N or X.Y.Z-rc.N, got ${expectedVersion}`);
  assert.equal(manifest.version, expectedVersion,
    `manifest version ${manifest.version} does not match the released version ${expectedVersion}`);

  const registry = arguments_.registry ?? manifest.publishConfig?.registry;
  assert.ok(typeof registry === 'string' && /^https?:\/\/.+/.test(registry),
    'registry must be an HTTP(S) URL');
  if (arguments_.registry === undefined) {
    assert.equal(registry, DEFAULT_REGISTRY, `publishConfig.registry must be ${DEFAULT_REGISTRY}`);
  }

  const escapedName = PACKAGE_NAME.replace('/', '%2F');
  const baseUrl = registry.replace(/\/+$/, '');
  const distTagsUrl = `${baseUrl}/-/package/${escapedName}/dist-tags`;

  const tags = await requestJson(distTagsUrl);
  assert.ok(tags !== null && typeof tags === 'object' && !Array.isArray(tags),
    'dist-tags response must be an object');
  const currentVersion = typeof tags.latest === 'string' ? tags.latest : undefined;

  const details = [`released version \`${expectedVersion}\` (${target.channel})`];
  let action;
  let reason;

  if (currentVersion === undefined) {
    action = 'skip';
    reason = 'no-latest';
    details.push('current latest: none');
  } else {
    details.push(`current latest \`${currentVersion}\``);
    const current = parseVersion(currentVersion);
    if (currentVersion === expectedVersion) {
      action = 'skip';
      reason = 'already-latest';
    } else if (current === null) {
      action = 'skip';
      reason = 'unknown-current-channel';
    } else if (current.channel !== target.channel) {
      action = 'skip';
      reason = 'channel-mismatch';
    } else if (compareVersions(target, current) <= 0) {
      action = 'skip';
      reason = 'not-newer';
    } else {
      action = 'move';
    }
  }

  console.log(`promote-latest: version=${expectedVersion} channel=${target.channel}`);
  console.log(`promote-latest: latest=${currentVersion ?? 'none'} current-channel=${currentVersion === undefined
    ? 'none' : (parseVersion(currentVersion)?.channel ?? 'unknown')}`);
  console.log(`promote-latest: action=${action}${reason === undefined ? '' : ` reason=${reason}`}`);

  if (action === 'skip') {
    recordSummary(['### `latest` promotion', '', ...details.map((line) => `- ${line}`),
      `- decision: skip (${reason})`]);
    return;
  }

  if (arguments_.dryRun) {
    console.log('promote-latest: dry run, no registry change');
    recordSummary(['### `latest` promotion', '', ...details.map((line) => `- ${line}`),
      '- decision: move (dry run, not applied)']);
    return;
  }

  assertNpmSupportsDistTagOverOidc();

  const published = await requestJson(`${baseUrl}/${escapedName}/${expectedVersion}`, { allowNotFound: true });
  assert.ok(published !== null, `version ${expectedVersion} is not published on ${registry}`);

  const add = spawnSync('npm',
    ['dist-tag', 'add', `${PACKAGE_NAME}@${expectedVersion}`, 'latest', '--registry', registry],
    { encoding: 'utf8' });
  if (add.status !== 0) {
    process.stderr.write(add.stdout ?? '');
    process.stderr.write(add.stderr ?? '');
    throw new Error(`npm dist-tag add failed with exit ${add.status}; ${DIST_TAG_HINT}`);
  }
  if (add.stdout) process.stdout.write(add.stdout);
  if (add.stderr) process.stderr.write(add.stderr);

  let observed;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const latestTags = await requestJson(distTagsUrl);
    observed = latestTags.latest;
    if (observed === expectedVersion) break;
    if (attempt < 5) await sleep(1000);
  }
  assert.equal(observed, expectedVersion,
    `latest is ${observed ?? 'none'} after the update, expected ${expectedVersion}`);

  console.log(`promote-latest: moved latest to ${expectedVersion}`);
  recordSummary(['### `latest` promotion', '', ...details.map((line) => `- ${line}`),
    `- decision: move (applied, latest is now \`${expectedVersion}\`)`]);
};

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
