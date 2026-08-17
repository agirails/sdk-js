/**
 * ERC-8004 registration-v1 artifact generation.
 *
 * The AGIRAILS Markdown document remains the canonical AGIRAILS config. This
 * module creates the separate JSON document that an ERC-8004 agentURI must
 * resolve to. Capability claims are deliberately conservative: a generic
 * AGIRAILS endpoint is emitted, while A2A, MCP, x402, and trust claims are not
 * inferred from an execution URL or an authored payment-mode declaration.
 */

export const ERC8004_REGISTRATION_V1_TYPE =
  'https://eips.ethereum.org/EIPS/eip-8004#registration-v1' as const;

/** Stable fallback for older AGIRAILS cards that predate an authored image. */
export const DEFAULT_ERC8004_IMAGE_URI = 'https://agirails.app/favicon.ico';

/** Operational limit shared with the public publish proxy. */
export const ERC8004_REGISTRATION_V1_MAX_BYTES = 10 * 1024;

export interface ERC8004RegistrationService {
  name: string;
  endpoint: string;
  version?: string;
}

export interface ERC8004RegistrationReference {
  agentId: number | string;
  agentRegistry: string;
}

export interface ERC8004RegistrationV1 {
  type: typeof ERC8004_REGISTRATION_V1_TYPE;
  name: string;
  description: string;
  image: string;
  services: ERC8004RegistrationService[];
  x402Support: false;
  active: true;
  registrations: ERC8004RegistrationReference[];
}

export interface BuildERC8004RegistrationOptions {
  frontmatter: Record<string, unknown>;
  body: string;
  /** URI of the separately published AGIRAILS Markdown artifact. */
  agirailsConfigURI: string;
  /** Known only for an existing identity; omitted during the initial mint. */
  registration?: ERC8004RegistrationReference;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function descriptionFromBody(body: string, fallback: string): string {
  const withoutHeading = body.replace(/^\s*#\s+[^\n]+\n?/, '').trim();
  const nextSection = withoutHeading.search(/^##\s+/m);
  const description = (
    nextSection === -1 ? withoutHeading : withoutHeading.slice(0, nextSection)
  ).trim();
  return description || fallback;
}

function isArtifactURI(value: string): boolean {
  return isHttpsURI(value) || isIpfsURI(value) || /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value);
}

function isConfigURI(value: string): boolean {
  return (
    isHttpsURI(value) ||
    isIpfsURI(value) ||
    /^data:(application\/json|text\/markdown)(;charset=[^;,]+)?(;base64)?,.+$/is.test(value)
  );
}

function isHttpsURI(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isIpfsURI(value: string): boolean {
  const path = value.startsWith('ipfs://') ? value.slice('ipfs://'.length) : '';
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9._~-]*(?:\/[a-zA-Z0-9._~-]+)*$/.test(path) &&
    !path.split('/').includes('..')
  );
}

function isUint256AgentId(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
  return BigInt(value) <= (1n << 256n) - 1n;
}

function isEip155AgentRegistry(value: string): boolean {
  const match = /^eip155:([1-9][0-9]*):(0x[a-fA-F0-9]{40})$/.exec(value);
  if (!match) return false;
  return BigInt(match[1]) <= (1n << 256n) - 1n && !/^0x0{40}$/i.test(match[2]);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`);
  }
}

/**
 * Build the standards-native projection for an AGIRAILS identity file.
 *
 * Initial registration intentionally emits an empty `registrations` array:
 * the token ID does not exist until `register(agentURI)` executes, and
 * predicting it would be race-prone. A later owner-authorized update can add
 * the exact registry-scoped identity with `setAgentURI`.
 */
export function buildERC8004RegistrationV1(
  options: BuildERC8004RegistrationOptions
): ERC8004RegistrationV1 {
  const name = nonEmptyString(options.frontmatter.name);
  if (!name) {
    throw new Error('ERC-8004 registration requires a non-empty agent name');
  }

  const configURI = nonEmptyString(options.agirailsConfigURI);
  if (!configURI || !isConfigURI(configURI)) {
    throw new Error('ERC-8004 registration requires an https, ipfs, or data AGIRAILS config URI');
  }

  const explicitDescription = nonEmptyString(options.frontmatter.description);
  if (options.frontmatter.description !== undefined && !explicitDescription) {
    throw new Error('ERC-8004 registration description must be a non-empty string when present');
  }
  const description = explicitDescription ?? descriptionFromBody(options.body, name);
  const version = nonEmptyString(options.frontmatter.version);
  if (options.frontmatter.version !== undefined && !version) {
    throw new Error('ERC-8004 registration version must be a non-empty string when present');
  }
  const authoredImage = nonEmptyString(options.frontmatter.image);
  if (
    options.frontmatter.image !== undefined &&
    (!authoredImage || !isArtifactURI(authoredImage))
  ) {
    throw new Error('ERC-8004 registration image must be an https, ipfs, or data image URI');
  }
  const image = authoredImage ?? DEFAULT_ERC8004_IMAGE_URI;

  const registration: ERC8004RegistrationV1 = {
    type: ERC8004_REGISTRATION_V1_TYPE,
    name,
    description,
    image,
    services: [
      {
        name: 'AGIRAILS',
        endpoint: configURI,
        ...(version ? { version } : {}),
      },
    ],
    // An authored payment mode does not prove a live x402 resource.
    x402Support: false,
    active: true,
    registrations: options.registration ? [options.registration] : [],
  };

  validateERC8004RegistrationV1(registration);
  return registration;
}

/** Validate the strict subset emitted and accepted by the AGIRAILS publisher. */
export function validateERC8004RegistrationV1(
  value: unknown
): asserts value is ERC8004RegistrationV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ERC-8004 registration must be a JSON object');
  }

  const record = value as Record<string, unknown>;
  assertOnlyKeys(
    record,
    ['type', 'name', 'description', 'image', 'services', 'x402Support', 'active', 'registrations'],
    'ERC-8004 registration'
  );
  if (record.type !== ERC8004_REGISTRATION_V1_TYPE) {
    throw new Error(`ERC-8004 registration type must be ${ERC8004_REGISTRATION_V1_TYPE}`);
  }
  if (!nonEmptyString(record.name) || !nonEmptyString(record.description)) {
    throw new Error('ERC-8004 registration name and description must be non-empty strings');
  }
  const image = nonEmptyString(record.image);
  if (!image || !isArtifactURI(image)) {
    throw new Error('ERC-8004 registration image must be an https, ipfs, or data image URI');
  }
  if (record.x402Support !== false) {
    throw new Error('Unverified x402Support claims are not accepted by this publisher');
  }
  if (record.active !== true) {
    throw new Error('ERC-8004 registration active must be true');
  }
  if (!Array.isArray(record.services) || record.services.length !== 1) {
    throw new Error('ERC-8004 registration must contain exactly one verified AGIRAILS service');
  }
  for (const service of record.services) {
    if (!service || typeof service !== 'object' || Array.isArray(service)) {
      throw new Error('ERC-8004 registration service must be an object');
    }
    const entry = service as Record<string, unknown>;
    assertOnlyKeys(entry, ['name', 'endpoint', 'version'], 'ERC-8004 registration service');
    if (entry.name !== 'AGIRAILS') {
      throw new Error('Only the verified AGIRAILS service projection is accepted');
    }
    const endpoint = nonEmptyString(entry.endpoint);
    if (!endpoint || !isConfigURI(endpoint)) {
      throw new Error('ERC-8004 AGIRAILS endpoint must be an https, ipfs, or data URI');
    }
    if (entry.version !== undefined && !nonEmptyString(entry.version)) {
      throw new Error('ERC-8004 service version must be a non-empty string when present');
    }
  }
  if (!Array.isArray(record.registrations)) {
    throw new Error('ERC-8004 registration registrations must be an array');
  }
  for (const reference of record.registrations) {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
      throw new Error('ERC-8004 registration reference must be an object');
    }
    const entry = reference as Record<string, unknown>;
    assertOnlyKeys(entry, ['agentId', 'agentRegistry'], 'ERC-8004 registration reference');
    const hasAgentId = isUint256AgentId(entry.agentId);
    const registry = nonEmptyString(entry.agentRegistry);
    if (
      !hasAgentId ||
      !registry ||
      !isEip155AgentRegistry(registry)
    ) {
      throw new Error('ERC-8004 registration references require agentId and an EIP-155 registry');
    }
  }
}

export function serializeERC8004RegistrationV1(
  registration: ERC8004RegistrationV1
): string {
  validateERC8004RegistrationV1(registration);
  const serialized = `${JSON.stringify(registration, null, 2)}\n`;
  const byteLength = Buffer.byteLength(serialized, 'utf-8');
  if (byteLength > ERC8004_REGISTRATION_V1_MAX_BYTES) {
    throw new Error(
      `ERC-8004 registration exceeds ${ERC8004_REGISTRATION_V1_MAX_BYTES} bytes ` +
        `(${byteLength} bytes)`
    );
  }
  return serialized;
}
