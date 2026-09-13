import type * as Native from '@number0/iroh/index';
import type { IrohEndpoint } from './DeskIrohTransport';
import { IROH_ALPN } from './DeskIrohTransport';
import { validDeskRelay } from './desk/DeskIrohLink';

/** Kept separate from loading a native module: old editors must never load it. */
export function supportsDeskIroh(version: string, platform: string, arch: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) < 20 || (Number(match[1]) === 20 && Number(match[2]) < 3)) { return false; }
  return (platform === 'darwin' && arch === 'arm64')
    || (['linux', 'win32'].includes(platform) && ['x64', 'arm64'].includes(arch));
}

/**
 * Explicitly injected, reviewed native binding. No loader, environment override,
 * default discovery, public relay fallback, or side effect at module import.
 * The packaged worker owns loading; DeskCrossMachine owns editor authority.
 */
export async function bindDeskIroh(native: typeof Native, relayUrl: string): Promise<IrohEndpoint> {
  if (!supportsDeskIroh(process.versions.node, process.platform, process.arch) || !validDeskRelay(relayUrl)) {
    throw new Error('Desk iroh configuration unsupported');
  }
  const builder = native.Endpoint.builder();
  builder.applyMinimal();
  builder.relayMode(native.RelayMode.customFromUrls([relayUrl]));
  builder.alpns([IROH_ALPN]);
  const endpoint = await builder.bind();
  return {
    id: () => endpoint.id(),
    acceptNext: () => endpoint.acceptNext(),
    connect: id => endpoint.connect(new native.EndpointAddr(native.EndpointId.fromString(id), relayUrl), IROH_ALPN),
    close: () => endpoint.close(),
  };
}
