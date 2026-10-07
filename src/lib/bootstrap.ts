import { ensureSecure } from './cookie.js';

export const BOOTSTRAP_SCRIPT = "location.replace('/?__dsh_bridge_retry=1');";
export const BOOTSTRAP_CSP = "default-src 'none'; script-src 'sha256-fzR2DpUp+SGGmfdsTMFXcRfMU2s3ZuPDzG6rEFV1qWY='; base-uri 'none'";
export const BOOTSTRAP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>DSH Web</title></head>
<body>
<p>Session restoration is in progress. If you are not redirected automatically,
<a href="/">continue to DSH Web</a>.</p>
<script>location.replace('/?__dsh_bridge_retry=1');</script>
</body></html>`;

export interface BootstrapResponse {
  readonly statusCode: 200;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Fixed no-store response; never inherit upstream body/framing or interpolate. */
export function createBootstrapResponse(setCookie: string): BootstrapResponse {
  return {
    statusCode: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': BOOTSTRAP_CSP,
      'set-cookie': ensureSecure(setCookie),
    },
    body: BOOTSTRAP_HTML,
  };
}
