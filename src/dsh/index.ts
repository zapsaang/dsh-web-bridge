import z from '@deepseek-ai/schemastery';
import { createServer } from 'node:http';
import { defaultIo, type SocketAccess } from '../lib/socket.js';
import { AuthorityError, normalizeAuthorities } from '../lib/authority.js';
import { makeApply } from './apply.js';
export { BridgeNotImplementedError, BridgeLoopbackGuardError, BridgeAuthorityTrustError } from './errors.js';

export const name = '@zapsaang/dsh-web-bridge';
export const inject = ['connection', 'webServer'];

export interface Config {
  readonly socketPath: string;
  readonly authorities: readonly string[];
  readonly socketAccess: SocketAccess;
}

const fields = z.object({
  socketPath: z.string().default('/run/dsh-web/session-bridge.sock'),
  // Presence and emptiness are checked in the transform so a missing deployment
  // overlay produces an actionable message instead of a generic schema error.
  // The shipped bundle carries no example authorities (D3=A).
  authorities: z.array(z.string()).default([]),
  // socketAccess stays unvalidated at the schema layer so the transform can
  // reject null/non-string/unknown values itself; only OMITTING the key may
  // select the strict default (never a silent fallback).
  socketAccess: z.any(),
});

export const Config: Schemastery<{
  readonly socketPath?: string | null;
  readonly authorities?: string[] | null;
  readonly socketAccess?: unknown;
}, Config> = z.transform(fields, (value): Config => {
  if (Object.keys(value).some((key) => key !== 'socketPath' && key !== 'authorities' && key !== 'socketAccess')) {
    throw new z.ValidationError('Unexpected bridge configuration key.', {});
  }
  const access: unknown = value.socketAccess;
  if (access !== undefined && access !== 'strict' && access !== 'group') {
    throw new z.ValidationError('Invalid bridge socket access mode.', {});
  }
  const rawAuthorities = value.authorities ?? [];
  if (rawAuthorities.length === 0) {
    throw new z.ValidationError(
      "authorities is required; add a bridge overlay with authorities: ['<public-host>'].", {},
    );
  }
  let authorities: readonly string[];
  try {
    authorities = normalizeAuthorities(rawAuthorities);
  } catch (error) {
    if (error instanceof AuthorityError) throw new z.ValidationError(error.message, {});
    throw error;
  }
  return {
    socketPath: value.socketPath ?? '/run/dsh-web/session-bridge.sock',
    authorities,
    socketAccess: access ?? 'strict',
  };
});

export const apply = makeApply({ io: defaultIo, createServer });
