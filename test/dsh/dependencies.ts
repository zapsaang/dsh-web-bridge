import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|rc)\.(?:0|[1-9]\d*))?$/;
const PEER_KEYS = ['@deepseek-ai/dsh', '@deepseek-ai/cordis', '@deepseek-ai/schemastery'] as const;

interface RootManifest {
  readonly name: string;
  readonly version: string;
  readonly peerDependencies: Record<string, string>;
  readonly devDependencies: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as RootManifest;

for (const key of PEER_KEYS) {
  const peer = manifest.peerDependencies[key];
  const dev = manifest.devDependencies[key];
  assert.ok(typeof peer === 'string' && EXACT_VERSION.test(peer), `peerDependencies[${key}] must be an exact version`);
  assert.equal(dev, peer, `devDependencies[${key}] must match peerDependencies[${key}]`);
}

const expectedDsh = manifest.peerDependencies['@deepseek-ai/dsh']!;
const expectedCordis = manifest.peerDependencies['@deepseek-ai/cordis']!;
const expectedSchemastery = manifest.peerDependencies['@deepseek-ai/schemastery']!;

// Resolve shipped transitive packages from the pinned installation, not a
// checkout or a new dependency. Type-only paths follow pnpm's existing layout.
const installed = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'));
export const AppBoot: typeof import('../../node_modules/.pnpm/node_modules/@deepseek-ai/dsh-app-boot/lib/types/plugin-compatibility.js') =
  await import(installed.resolve('@deepseek-ai/dsh-app-boot'));
export const WebApp: typeof import('../../node_modules/.pnpm/node_modules/@deepseek-ai/dsh-web-app/lib/types/index.js') =
  await import(installed.resolve('@deepseek-ai/dsh-web-app'));
const web = createRequire(installed.resolve('@deepseek-ai/dsh-web-app'));
export const WebServerModule: typeof import('../../node_modules/.pnpm/node_modules/@deepseek-ai/dsh-host-webserver/lib/types/index.js') =
  await import(web.resolve('@deepseek-ai/dsh-host-webserver'));
export const Connection: typeof import('../../node_modules/.pnpm/node_modules/@deepseek-ai/dsh-client-connection/lib/types/index.js') =
  await import(web.resolve('@deepseek-ai/dsh-client-connection'));
const base = createRequire(installed.resolve('@deepseek-ai/dsh-base'));
export const Credentials: typeof import('../../node_modules/.pnpm/node_modules/@deepseek-ai/dsh-credentials-local/lib/types/index.js') =
  await import(base.resolve('@deepseek-ai/dsh-credentials-local'));
export const CredentialSeam: typeof import('../../node_modules/.pnpm/node_modules/@deepseek-ai/dsh-credentials/lib/types/index.js') =
  await import(createRequire(base.resolve('@deepseek-ai/dsh-credentials-local')).resolve('@deepseek-ai/dsh-credentials'));
export const Frontend: typeof import('../../node_modules/.pnpm/node_modules/@deepseek-ai/dsh-host-frontend-static/lib/types/index.js') =
  await import(web.resolve('@deepseek-ai/dsh-host-frontend-static'));

for (const [resolver, name, expected] of [
  [installed, '@deepseek-ai/dsh', expectedDsh],
  [installed, '@deepseek-ai/cordis', expectedCordis],
  [installed, '@deepseek-ai/schemastery', expectedSchemastery],
  [web, '@deepseek-ai/dsh-web-app', expectedDsh],
  [web, '@deepseek-ai/dsh-host-webserver', expectedDsh],
  [web, '@deepseek-ai/dsh-host-frontend-static', expectedDsh],
  [web, '@deepseek-ai/dsh-client-connection', expectedDsh],
  [base, '@deepseek-ai/dsh-credentials-local', expectedDsh],
] as const) {
  const metadata: unknown = resolver(`${name}/package.json`);
  assert.ok(typeof metadata === 'object' && metadata !== null && 'version' in metadata);
  assert.equal(metadata.version, expected, `${name} must remain pinned`);
}

assert.equal(AppBoot.evaluatePluginCompatibility(manifest, {}, expectedDsh), undefined,
  `pinned dsh ${expectedDsh} must admit plugin without an exemption`);
assert.equal(AppBoot.evaluatePluginCompatibility(manifest, {}, '0.0.1-rc.1')?.exempted, false,
  'unverified dsh runtime must be rejected unless exempted');
