import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

// Resolve shipped transitive packages from the pinned installation, not a
// checkout or a new dependency. Type-only paths follow pnpm's existing layout.
const installed = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'));
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
  [installed, '@deepseek-ai/dsh', '0.2.1-alpha.1'],
  [installed, '@deepseek-ai/cordis', '4.0.5-alpha.1'],
  [installed, '@deepseek-ai/schemastery', '3.18.5-alpha.1'],
  [web, '@deepseek-ai/dsh-web-app', '0.2.1-alpha.1'],
  [web, '@deepseek-ai/dsh-host-webserver', '0.2.1-alpha.1'],
  [web, '@deepseek-ai/dsh-host-frontend-static', '0.2.1-alpha.1'],
  [web, '@deepseek-ai/dsh-client-connection', '0.2.1-alpha.1'],
  [base, '@deepseek-ai/dsh-credentials-local', '0.2.1-alpha.1'],
] as const) {
  const metadata: unknown = resolver(`${name}/package.json`);
  assert.ok(typeof metadata === 'object' && metadata !== null && 'version' in metadata);
  assert.equal(metadata.version, expected, `${name} must remain pinned`);
}
