import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

class PackGateError extends Error {
  code = 'ERR_PACK_FILES';
}

function requireCondition(condition, message) {
  if (!condition) throw new PackGateError(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function walk(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    requireCondition(!stat.isSymbolicLink(), `Symlink is not allowed: ${path}`);
    if (stat.isDirectory()) files.push(...walk(path));
    else {
      requireCondition(stat.isFile(), `Non-regular file: ${path}`);
      files.push(path);
    }
  }
  return files;
}

function exportPaths(value) {
  if (typeof value === 'string') return [value];
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid exports map');
  return Object.values(value).flatMap(exportPaths);
}

function checkPackFiles() {
  const manifest = readJson('package.json');
  requireCondition(Array.isArray(manifest.files)
    && manifest.files.length === 2
    && manifest.files.includes('lib')
    && manifest.files.includes('cordis.patch.yml'), 'files must declare lib and cordis.patch.yml only');
  const config = readJson('tsconfig.json');
  requireCondition(config.compilerOptions?.rootDir === 'src'
    && config.compilerOptions?.outDir === 'lib'
    && config.compilerOptions?.declaration === true, 'Build output contract does not match src → lib + declarations');

  const sources = walk('src').filter((path) => path.endsWith('.ts') && !path.endsWith('.d.ts'));
  requireCondition(sources.length > 0, 'No TypeScript sources');
  const expected = new Set();
  for (const source of sources) {
    const stem = `lib/${source.slice(4, -3)}`;
    expected.add(`${stem}.js`);
    expected.add(`${stem}.d.ts`);
  }
  const generated = walk('lib');
  for (const path of generated) {
    requireCondition(expected.has(path), `Unexpected or stale output: ${path}`);
  }
  const newestInput = [...sources, 'tsconfig.json', 'package.json']
    .map((path) => lstatSync(path, { bigint: true }).mtimeNs)
    .reduce((latest, time) => time > latest ? time : latest, 0n);
  for (const path of expected) {
    requireCondition(generated.includes(path), `Missing generated output: ${path}`);
    requireCondition(lstatSync(path, { bigint: true }).mtimeNs >= newestInput, `Stale generated output: ${path}`);
  }

  const entry = manifest.exports?.['.'];
  requireCondition(entry?.types === './lib/dsh/index.d.ts'
    && entry?.default === './lib/dsh/index.js', 'Missing plugin entry or declaration export');
  for (const path of exportPaths(manifest.exports)) {
    requireCondition(path.startsWith('./') && expected.has(path.slice(2)), `Undeclared export: ${path}`);
  }
  const patch = manifest.dsh?.bundle?.patch;
  const patches = typeof patch === 'string' ? [patch] : patch;
  requireCondition(Array.isArray(patches) && patches.length === 1
    && patches[0] === './cordis.patch.yml', 'Missing bundle patch metadata');
  requireCondition(lstatSync('cordis.patch.yml').isFile(), 'Missing regular bundle patch');

  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
  });
  if (result.error) throw result.error;
  requireCondition(result.status === 0, `Pack listing failed: ${result.stderr}`);
  const listing = JSON.parse(result.stdout);
  requireCondition(Array.isArray(listing) && listing.length === 1
    && Array.isArray(listing[0].files), 'Invalid pack listing');
  const packed = new Set(listing[0].files.map((file) => {
    requireCondition(typeof file.path === 'string', 'Invalid packed path');
    return file.path;
  }));
  const metadata = new Set(['package.json', 'LICENSE', 'README.md']);
  for (const path of packed) {
    requireCondition(!path.split('/').some((part) => ['src', 'test', '.test-dist'].includes(part))
      && !/(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?)$/.test(path)
      && (!path.endsWith('.ts') || path.endsWith('.d.ts')), `Forbidden packed file: ${path}`);
    requireCondition(expected.has(path) || path === 'cordis.patch.yml' || metadata.has(path), `Undeclared packed file: ${path}`);
  }
  for (const path of [...expected, 'cordis.patch.yml', 'package.json', 'README.md']) {
    requireCondition(packed.has(path), `Required file absent from pack listing: ${path}`);
  }
  console.log(`PASS: pack files (${packed.size})`);
  console.log([...packed].sort().join('\n'));
}

try {
  checkPackFiles();
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error instanceof PackGateError ? error.code : error.name}: ${error.message}`);
  process.exitCode = 1;
}
