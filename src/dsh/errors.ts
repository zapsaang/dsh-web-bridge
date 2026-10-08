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
    super('dsh web bridge requires the dsh web server bound to 127.0.0.1 with a valid bound port.');
    this.name = 'BridgeLoopbackGuardError';
  }
}

export class BridgeAuthorityTrustError extends Error {
  readonly code = 'ERR_BRIDGE_AUTHORITY_TRUST';
  constructor() {
    super('dsh web bridge authorities must be bare public names accepted by the web runtime trustedHosts.');
    this.name = 'BridgeAuthorityTrustError';
  }
}
