import z from '@deepseek-ai/schemastery';
import { createServer } from 'node:http';
import { defaultIo, type SocketAccess } from '../lib/socket.js';
import { makeApply } from './apply.js';
export { BridgeNotImplementedError, BridgeLoopbackGuardError, BridgeAuthorityTrustError } from './errors.js';

export const name = '@zapsaang/dsh-web-bridge';
export const inject = ['connection', 'webServer', 'webRuntime'];

export interface Config {
  readonly socketPath: string;
  readonly authorities: readonly string[];
  readonly socketAccess: SocketAccess;
}

const fields = z.object({
  socketPath: z.string().default('/run/dsh-web/session-bridge.sock'),
  authorities: z.array(z.string().max(253).pattern(
    /^(?![0-9]+(?:\.[0-9]+){3}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
  ).required()).min(1).required(),
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
  return {
    socketPath: value.socketPath ?? '/run/dsh-web/session-bridge.sock',
    authorities: value.authorities ?? [],
    socketAccess: access ?? 'strict',
  };
});

export const apply = makeApply({ io: defaultIo, createServer });
