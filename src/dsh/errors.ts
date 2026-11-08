export class BridgeNotImplementedError extends Error {
  readonly code = 'ERR_BRIDGE_NOT_IMPLEMENTED';
  constructor() {
    super('Bridge behavior is not implemented.');
    this.name = 'BridgeNotImplementedError';
  }
}

export class BridgeLoopbackGuardError extends Error {
  readonly code = 'ERR_BRIDGE_LOOPBACK_GUARD';
  constructor() {
    super('dsh web bridge requires the dsh web server bound to a loopback address with a valid bound port.');
    this.name = 'BridgeLoopbackGuardError';
  }
}

export class BridgeAuthorityTrustError extends Error {
  readonly code = 'ERR_BRIDGE_AUTHORITY_TRUST';
  constructor() {
    super('dsh web bridge authorities must be canonical host, host:port, IPv4, or bracketed IPv6 values accepted by the connection trustedHosts; loopback names and the bind address are exempt.');
    this.name = 'BridgeAuthorityTrustError';
  }
}
