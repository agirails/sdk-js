/**
 * Read-only ERC-8004 identity inventory collection.
 *
 * The collector reads the canonical registry and resolves the current
 * agentURI artifact. It never requests a signer, uploads content, or submits
 * a transaction. Failures are retained per identity so a partial RPC or URI
 * outage cannot silently remove an agent from the evidence set.
 */

import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { Contract, JsonRpcProvider, getAddress } from 'ethers';
import { getNetwork } from '../config/networks';
import { ERC8004_IDENTITY_ABI } from '../types/erc8004';
import { ERC8004MigrationInput } from './migration';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
const MAX_REDIRECTS = 3;
const MAX_UINT256 = (1n << 256n) - 1n;

export type ERC8004InventoryNetwork = 'base-sepolia' | 'base-mainnet';

export interface ERC8004IdentityReader {
  ownerOf(agentId: string): Promise<string>;
  tokenURI(agentId: string): Promise<string>;
  getAgentWallet(agentId: string): Promise<string>;
}

export interface ERC8004InventoryFailure {
  agentId: string;
  error: string;
}

export interface ERC8004InventoryFile {
  version: 1;
  generatedAt: string;
  network: ERC8004InventoryNetwork;
  /** Origin only; credentials, query parameters, and provider paths are never persisted. */
  rpcEndpoint: string;
  agents: ERC8004MigrationInput[];
  failures: ERC8004InventoryFailure[];
  checks: {
    readOnly: true;
    signaturesRequested: 0;
    transactionsGenerated: 0;
  };
}

export interface ERC8004InventoryOptions {
  network: ERC8004InventoryNetwork;
  agentIds: string[];
  rpcUrl?: string;
  reader?: ERC8004IdentityReader;
  fetchFn?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  maxBytes?: number;
  ipfsGateway?: string;
  /** Explicit HTTPS artifact hosts. IPFS gateway host is allowed automatically. */
  allowedHttpsHosts?: string[];
  generatedAt?: string;
}

function assertAgentId(agentId: string): void {
  if (!/^(0|[1-9][0-9]*)$/.test(agentId)) {
    throw new Error(`ERC-8004 agent ID must be an unsigned decimal string: ${agentId}`);
  }
  if (BigInt(agentId) > MAX_UINT256) {
    throw new Error(`ERC-8004 agent ID exceeds uint256: ${agentId}`);
  }
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) ||
    (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) ||
    (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) ||
    (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) ||
    parts[0] >= 224
  );
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  if (isIP(normalized) === 4) return isPrivateIPv4(normalized);
  if (isIP(normalized) === 6) {
    const mappedIPv4 = /^(?:::ffff:(?:0:)?|::)(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mappedIPv4) return isPrivateIPv4(mappedIPv4[1]);
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:')
    );
  }
  return true;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function assertPublicHttpsUrl(
  rawUrl: string,
  resolveHost: (hostname: string) => Promise<string[]>
): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('agentURI must resolve through credential-free HTTPS');
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('agentURI cannot target a local hostname');
  }
  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error('agentURI cannot target a private, local, or reserved address');
  }
  return url;
}

function decodeDataUri(uri: string, maxBytes: number): string {
  const match = /^data:(application\/json|text\/markdown)(;charset=[^;,]+)?(;base64)?,(.*)$/is.exec(uri);
  if (!match) {
    throw new Error('Unsupported data agentURI; expected JSON or Markdown');
  }
  const buffer = match[3]
    ? Buffer.from(match[4], 'base64')
    : Buffer.from(decodeURIComponent(match[4]), 'utf-8');
  if (buffer.byteLength > maxBytes) {
    throw new Error(`agentURI artifact exceeds ${maxBytes} bytes`);
  }
  return buffer.toString('utf-8');
}

function normalizeAgentUri(uri: string, ipfsGateway: string): string {
  if (!uri.startsWith('ipfs://')) return uri;
  const path = uri.slice('ipfs://'.length);
  if (!/^[a-zA-Z0-9]+(?:\/[a-zA-Z0-9._~-]+)*$/.test(path) || path.includes('..')) {
    throw new Error('Invalid IPFS agentURI');
  }
  let gatewayEnd = ipfsGateway.length;
  while (gatewayEnd > 0 && ipfsGateway.charCodeAt(gatewayEnd - 1) === 0x2f) {
    gatewayEnd -= 1;
  }
  return `${ipfsGateway.slice(0, gatewayEnd)}/${path}`;
}

async function readResponseBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    let result = await reader.read();
    while (!result.done) {
      const { value } = result;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('agentURI artifact exceeds configured size limit');
        throw new Error(`agentURI artifact exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
      result = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf-8');
}

function sanitizeFailureMessage(error: unknown, rpcUrl: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const withoutExactRpcUrl = message.split(rpcUrl).join('[redacted RPC URL]');
  return withoutExactRpcUrl.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate: string) => {
    try {
      return new URL(candidate).origin;
    } catch {
      return '[redacted URL]';
    }
  });
}

/** Resolve an untrusted on-chain URI with SSRF, timeout, and size guards. */
export async function fetchERC8004Artifact(
  agentURI: string,
  options: Pick<
    ERC8004InventoryOptions,
    | 'fetchFn'
    | 'resolveHost'
    | 'timeoutMs'
    | 'maxBytes'
    | 'ipfsGateway'
    | 'allowedHttpsHosts'
  > = {}
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (agentURI.startsWith('data:')) return decodeDataUri(agentURI, maxBytes);

  const fetchFn = options.fetchFn ?? fetch;
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ipfsGateway = options.ipfsGateway ?? DEFAULT_IPFS_GATEWAY;
  let url = normalizeAgentUri(agentURI, ipfsGateway);
  const allowedHosts = new Set(
    [new URL(ipfsGateway).hostname, ...(options.allowedHttpsHosts ?? [])].map((host) =>
      host.toLowerCase()
    )
  );

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const validated = await assertPublicHttpsUrl(url, resolveHost);
    if (!allowedHosts.has(validated.hostname.toLowerCase())) {
      throw new Error(
        `HTTPS agentURI host is not approved: ${validated.hostname}; explicitly allow it before fetching`
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(validated, {
        headers: { Accept: 'application/json, text/markdown;q=0.9, text/plain;q=0.8' },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirect === MAX_REDIRECTS) {
          throw new Error('agentURI redirect is missing or exceeds the redirect limit');
        }
        url = new URL(location, validated).toString();
        continue;
      }
      if (!response.ok) throw new Error(`agentURI fetch failed with HTTP ${response.status}`);
      const declaredSize = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
        throw new Error(`agentURI artifact exceeds ${maxBytes} bytes`);
      }
      return await readResponseBodyCapped(response, maxBytes);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error('agentURI redirect limit exceeded');
}

/** Collect registry and content evidence for explicit agent IDs. */
export async function collectERC8004MigrationInventory(
  options: ERC8004InventoryOptions
): Promise<ERC8004InventoryFile> {
  if (options.agentIds.length === 0) throw new Error('At least one ERC-8004 agent ID is required');
  const agentIds = [...new Set(options.agentIds)];
  if (agentIds.length !== options.agentIds.length) throw new Error('Duplicate ERC-8004 agent ID');
  agentIds.forEach(assertAgentId);

  const network = getNetwork(options.network);
  const registryAddress = network.contracts.erc8004IdentityRegistry;
  if (!registryAddress) throw new Error(`No ERC-8004 registry configured for ${options.network}`);
  const rpcUrl = options.rpcUrl?.trim() || network.rpcUrl;
  const provider = options.reader
    ? undefined
    : new JsonRpcProvider(rpcUrl, network.chainId, { staticNetwork: true });
  const reader =
    options.reader ??
    (new Contract(registryAddress, ERC8004_IDENTITY_ABI, provider) as unknown as ERC8004IdentityReader);

  const agents: ERC8004MigrationInput[] = [];
  const failures: ERC8004InventoryFailure[] = [];
  try {
    for (const agentId of agentIds) {
      try {
        const [ownerValue, currentAgentURI, walletValue] = await Promise.all([
          reader.ownerOf(agentId),
          reader.tokenURI(agentId),
          reader.getAgentWallet(agentId),
        ]);
        const owner = getAddress(ownerValue);
        const agentWallet = getAddress(walletValue);
        if (!currentAgentURI) throw new Error('Registry returned an empty agentURI');
        const currentContent = await fetchERC8004Artifact(currentAgentURI, options);
        agents.push({
          chainId: network.chainId,
          registryAddress: getAddress(registryAddress),
          agentId,
          owner,
          agentWallet,
          currentAgentURI,
          currentContent,
        });
      } catch (error) {
        failures.push({
          agentId,
          error: sanitizeFailureMessage(error, rpcUrl),
        });
      }
    }
  } finally {
    provider?.destroy();
  }

  return {
    version: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    network: options.network,
    rpcEndpoint: new URL(rpcUrl).origin,
    agents,
    failures,
    checks: { readOnly: true, signaturesRequested: 0, transactionsGenerated: 0 },
  };
}
