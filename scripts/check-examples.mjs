import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Deployment-example gate. It verifies that every example targets the same
// socket path and authority as examples/overlay.example.yml and keeps the
// directives each access layer needs for TLS, external authentication, SSE
// and WebSocket. Additionally performs optional binary syntax validation
// (nginx -t / caddy validate) when the respective binaries exist on PATH.

class ExamplesGateError extends Error {
  code = 'ERR_EXAMPLES';
}

function requireCondition(condition, message) {
  if (!condition) throw new ExamplesGateError(message);
}

function read(path) {
  requireCondition(lstatSync(path).isFile(), `Missing example file: ${path}`);
  return readFileSync(path, 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const dshRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'));
const yaml = dshRequire('js-yaml');
// Cordis overlays use the custom !!js tag; treat it as its source text here.
const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (value) => ({ js: value }),
});
const schema = yaml.DEFAULT_SCHEMA.extend([jsTag]);

function checkOverlay() {
  const rows = yaml.load(read('examples/overlay.example.yml'), { schema });
  requireCondition(Array.isArray(rows) && rows.length > 0, 'overlay must be a patch row list');
  const bridge = rows.find((row) => row?.id === 'dsh-web-bridge');
  const connection = rows.find((row) => row?.id === 'connection');
  requireCondition(bridge !== undefined, 'overlay must contain the dsh-web-bridge row');
  requireCondition(connection !== undefined, 'overlay must contain the connection row');
  const socketPath = bridge.config?.socketPath;
  const authorities = bridge.config?.authorities;
  requireCondition(typeof socketPath === 'string' && socketPath.startsWith('/'), 'overlay socketPath must be absolute');
  requireCondition(Array.isArray(authorities) && authorities.length > 0, 'overlay must list at least one authority');
  const trustedSource = String(connection.config?.trustedHosts?.js ?? '');
  for (const authority of authorities) {
    if (authority === 'localhost' || authority === '[::1]' || authority.startsWith('127.')) continue;
    requireCondition(trustedSource.includes(authority),
      `overlay connection.trustedHosts must name the non-loopback authority ${authority}`);
  }
  return { socketPath, authority: authorities[0] };
}

function checkNginx(socketPath, authority) {
  const text = read('examples/nginx.conf');
  for (const [needle, message] of [
    [`server unix:${socketPath};`, 'nginx upstream must target the overlay socket'],
    ['proxy_pass http://dsh_bridge;', 'nginx must proxy to the bridge upstream'],
    ['proxy_set_header Host $http_host;', 'nginx must preserve the exact Host (including an explicit port)'],
    ['proxy_set_header Authorization "";', 'nginx must clear access-layer credentials'],
    ['proxy_buffering off;', 'nginx must disable response buffering for SSE'],
    ['proxy_set_header Upgrade $http_upgrade;', 'nginx must forward the WebSocket Upgrade header'],
    ['proxy_set_header Connection $dsh_connection_upgrade;', 'nginx must map Connection for WebSocket'],
    ['listen 443 ssl;', 'nginx example must terminate TLS'],
  ]) {
    requireCondition(text.includes(needle), message);
  }
  requireCondition(/ssl_certificate\s+\S/.test(text), 'nginx example must configure a certificate');
  requireCondition(/auth_basic|auth_request/.test(text), 'nginx example must terminate external authentication');
  requireCondition(new RegExp(`server_name\\s+${escapeRegExp(authority)}\\s*;`).test(text),
    'nginx server_name must name the example authority');
}

function checkCaddy(socketPath, authority) {
  const text = read('examples/Caddyfile');
  for (const [needle, message] of [
    [`reverse_proxy unix/${socketPath}`, 'Caddy must proxy to the overlay socket'],
    ['header_up -Authorization', 'Caddy must clear access-layer credentials'],
    ['flush_interval -1', 'Caddy must stream without response buffering'],
  ]) {
    requireCondition(text.includes(needle), message);
  }
  requireCondition(/basic_auth|forward_auth/.test(text), 'Caddy example must terminate external authentication');
  requireCondition(new RegExp(`^${escapeRegExp(authority)}\\s*\\{`, 'm').test(text),
    'Caddy site address must name the example authority');
}

function checkCloudflared(socketPath, authority) {
  const source = read('examples/cloudflared.yml');
  requireCondition(!source.includes('httpHostHeader'), 'cloudflared.yml must never set httpHostHeader');
  const ingress = yaml.load(source)?.ingress;
  requireCondition(Array.isArray(ingress) && ingress.length >= 2, 'cloudflared.yml must list ingress rules');
  const hostnames = ingress.filter((rule) => typeof rule?.hostname === 'string');
  const services = ingress.filter((rule) => typeof rule?.service === 'string' && rule.service.startsWith('unix:'));
  requireCondition(hostnames.length > 0, 'cloudflared.yml must list at least one hostname');
  requireCondition(services.length === hostnames.length, 'every hostname rule must use the bridge socket');
  requireCondition(services.every((rule) => rule.service === `unix:${socketPath}`),
    'cloudflared service must target the overlay socket');
  requireCondition(hostnames.every((rule) => rule.originRequest?.access?.required === true),
    'every cloudflared hostname rule must require Access');
  requireCondition(hostnames.every((rule) => Array.isArray(rule.originRequest?.access?.audTag)
    && rule.originRequest.access.audTag.length > 0), 'every cloudflared hostname rule needs its own audTag');
  requireCondition(hostnames.some((rule) => rule.hostname === authority),
    'cloudflared.yml must include the example authority');
  requireCondition(ingress[ingress.length - 1]?.service === 'http_status:404',
    'cloudflared.yml must end with the catch-all 404 rule');

  const doc = read('examples/cloudflared.md');
  requireCondition(doc.includes(socketPath), 'cloudflared.md must reference the overlay socket');
  requireCondition(doc.includes(authority), 'cloudflared.md must reference the example authority');
  requireCondition(doc.includes('httpHostHeader'), 'cloudflared.md must warn against httpHostHeader');
}

function checkLocalClient(socketPath, authority) {
  const text = read('examples/local-uds-client.md');
  requireCondition(text.includes(`SOCKET=${socketPath}`), 'local client example must define SOCKET from the overlay');
  requireCondition(text.includes(`HOST=${authority}`), 'local client example must define HOST from the overlay');
  requireCondition(text.includes('--unix-socket "$SOCKET"'), 'local client example must use the Unix socket probe');
  requireCondition(text.includes('curl '), 'local client example must use curl');
}

function checkReadmeAndManifest() {
  const readme = read('README.md');
  for (const path of ['examples/nginx.conf', 'examples/Caddyfile', 'examples/cloudflared.md',
    'examples/local-uds-client.md', 'examples/overlay.example.yml', 'scripts/check-examples.mjs']) {
    requireCondition(readme.includes(path), `README must reference ${path}`);
  }
  const manifest = JSON.parse(read('package.json'));
  requireCondition(Array.isArray(manifest.files) && manifest.files.length === 2
    && manifest.files.includes('lib') && manifest.files.includes('cordis.patch.yml'),
  'examples/ must stay out of the npm package (D4)');
  requireCondition(lstatSync('examples').isDirectory(), 'examples/ directory is missing');
}

function checkNoKeyMaterial() {
  for (const path of ['examples/nginx.conf', 'examples/Caddyfile', 'examples/cloudflared.yml',
    'examples/cloudflared.md', 'examples/local-uds-client.md', 'examples/overlay.example.yml']) {
    requireCondition(!read(path).includes('BEGIN PRIVATE KEY'), `Example must not embed key material: ${path}`);
  }
}

function checkOptionalNginxSyntax() {
  const probe = spawnSync('which', ['nginx'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    console.log('SKIP: nginx syntax validation (nginx binary not found on PATH)');
    return;
  }
  const opensslProbe = spawnSync('which', ['openssl'], { encoding: 'utf8' });
  const dir = mkdtempSync(join(tmpdir(), 'nginx-check-'));
  try {
    const certPath = join(dir, 'fullchain.pem');
    const keyPath = join(dir, 'privkey.pem');
    const htpasswdPath = join(dir, 'dsh.htpasswd');
    writeFileSync(htpasswdPath, 'user:test\n');

    if (opensslProbe.status === 0) {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath, '-days', '1',
        '-subj', '/CN=dsh.example.com',
      ], { stdio: 'pipe' });
    } else {
      writeFileSync(certPath, 'dummy cert\n');
      writeFileSync(keyPath, 'dummy key\n');
    }

    let conf = read('examples/nginx.conf');
    conf = conf.replaceAll('/etc/ssl/dsh/fullchain.pem', certPath);
    conf = conf.replaceAll('/etc/ssl/dsh/privkey.pem', keyPath);
    conf = conf.replaceAll('/etc/nginx/dsh.htpasswd', htpasswdPath);

    const fragmentPath = join(dir, 'dsh.conf');
    writeFileSync(fragmentPath, conf);

    const rootConfPath = join(dir, 'nginx.conf');
    writeFileSync(rootConfPath, `events { worker_connections 1024; }\nhttp {\n    include ${fragmentPath};\n}\n`);

    const result = spawnSync('nginx', ['-t', '-c', rootConfPath], { encoding: 'utf8' });
    requireCondition(result.status === 0, `nginx syntax validation failed: ${result.stderr || result.stdout}`);
    console.log('PASS: nginx syntax validation (nginx -t)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkOptionalCaddySyntax() {
  const probe = spawnSync('which', ['caddy'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    console.log('SKIP: caddy syntax validation (caddy binary not found on PATH)');
    return;
  }
  const result = spawnSync('caddy', ['validate', '--config', 'examples/Caddyfile', '--adapter', 'caddyfile'], { encoding: 'utf8' });
  requireCondition(result.status === 0, `caddy syntax validation failed: ${result.stderr || result.stdout}`);
  console.log('PASS: caddy syntax validation (caddy validate)');
}

try {
  const { socketPath, authority } = checkOverlay();
  checkNginx(socketPath, authority);
  checkCaddy(socketPath, authority);
  checkCloudflared(socketPath, authority);
  checkLocalClient(socketPath, authority);
  checkReadmeAndManifest();
  checkNoKeyMaterial();
  checkOptionalNginxSyntax();
  checkOptionalCaddySyntax();
  console.log(`PASS: deployment examples (socket ${socketPath}, authority ${authority})`);
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`${error instanceof ExamplesGateError ? error.code : error.name}: ${error.message}`);
  process.exitCode = 1;
}
