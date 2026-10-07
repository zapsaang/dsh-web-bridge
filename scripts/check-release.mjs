import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const expected = process.env.EXPECTED_VERSION;
assert.ok(typeof expected === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.(0|[1-9]\d*)$/.test(expected),
  'expected version must be X.Y.Z-alpha.N without leading zeros');

const ref = process.env.GITHUB_REF ?? '';
const tag = ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : null;
assert.ok(ref === 'refs/heads/main' || (tag !== null && (tag === expected || tag === `v${expected}`)),
  'release ref must be main or a tag naming the released version');

const args = process.argv.slice(2);
let source;
let tarball;
if (args[0] === '--pack-dir') {
  assert.equal(args.length, 2, 'usage: check-release.mjs --pack-dir DIRECTORY');
  const directory = resolve(args[1]);
  const files = readdirSync(directory).filter((name) => name.endsWith('.tgz'));
  assert.equal(files.length, 1, 'pack output must contain exactly one tarball');
  tarball = resolve(directory, files[0]);
  const options = { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 };
  const members = execFileSync('tar', ['-tzf', tarball], options).trim().split('\n');
  assert.equal(members.filter((name) => name === 'package/package.json').length, 1,
    'tarball must contain exactly one package/package.json');
  source = execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], options);
} else {
  assert.ok(args.length <= 1, 'usage: check-release.mjs [MANIFEST]');
  source = readFileSync(args[0] ?? 'package.json', 'utf8');
}

const manifest = JSON.parse(source);
assert.ok(manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest), 'manifest must be an object');
assert.equal(manifest.name, '@zapsaang/dsh-web-bridge', 'release identity mismatch');
assert.equal(manifest.version, expected, 'release version mismatch');
assert.equal(manifest.publishConfig?.access, 'public', 'publishConfig.access must be public');
assert.equal(manifest.publishConfig?.tag, 'alpha', 'publishConfig.tag must be alpha');
assert.equal(manifest.publishConfig?.registry, 'https://registry.npmjs.org/', 'publishConfig.registry must be npm');
if (tarball) console.log(tarball);
