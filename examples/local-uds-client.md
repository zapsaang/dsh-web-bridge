# Local Unix-socket client example

Minimal verification of the bridge without any reverse proxy, for a trusted
local process. `curl` needs the socket path from `socketPath` and the public
authority from `authorities` (see
[`overlay.example.yml`](https://github.com/zapsaang/dsh-web-bridge/blob/main/examples/overlay.example.yml)).

Repository-only file: it is NOT part of the npm tarball.

## Why this is safe to run locally

The socket's owner, mode, and parent-directory rules are the local access-control
boundary: a same-UID process can already read the DSH process memory, and group
mode deliberately extends that trust to the bridge group. These probes bypass
any access-layer authentication, so run them only on the machine that owns the
socket.

## Probes

```sh
SOCKET=/run/dsh-web/session-bridge.sock
HOST=dsh.example.com

# Wrong authority: rejected by the bridge before any upstream connection (403).
curl --unix-socket "$SOCKET" -H "Host: other.example.com" -i http://localhost/

# Non-navigation client: forwarded, the native 401 is relayed untouched.
curl --unix-socket "$SOCKET" -H "Host: $HOST" -i http://localhost/

# Navigation client (no Sec-Fetch-* headers, Accept: text/html): bootstrap.
# Expect 200 + text/html, a fixed CSP, and a dsh-auth-* Set-Cookie with Secure.
curl --unix-socket "$SOCKET" -H "Host: $HOST" -H 'Accept: text/html' -i http://localhost/
```

Expected statuses: `403` for the wrong `Host`, `401` for the non-navigation
request, `200` for the bootstrap probe. A `400` means the `Host` value does not
survive WHATWG URL parsing (see the README's authority rules).

## WebSocket

`curl` cannot complete a WebSocket upgrade; use a browser through a reverse
proxy (see the Nginx/Caddy/Cloudflare examples) or a client that can connect to
a Unix domain socket and send the handshake. The bridge validates the handshake
and relays `101` both ways.
