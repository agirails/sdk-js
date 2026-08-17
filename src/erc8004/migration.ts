/**
 * Read-only planning primitives for migrating legacy ERC-8004 agentURI values.
 *
 * This module never signs or submits a transaction. It turns an observed
 * on-chain identity plus the currently resolved artifact into a reviewable
 * before/after record. An optional target URI is considered ready only when
 * its fetched JSON is byte-equivalent after canonical registration-v1
 * serialization.
 */

import { createHash } from 'crypto';
import { getAddress, ZeroAddress } from 'ethers';
import { parseAgirailsMd } from '../config/agirailsmd';
import {
  buildERC8004RegistrationV1,
  ERC8004_REGISTRATION_V1_TYPE,
  ERC8004RegistrationV1,
  serializeERC8004RegistrationV1,
  validateERC8004RegistrationV1,
} from './registration';

export type ERC8004MigrationStatus =
  | 'needs-upload'
  | 'ready'
  | 'already-registration-v1'
  | 'blocked';

export type ERC8004MigrationReviewStatus = 'pending' | 'approved' | 'rejected';

export interface ERC8004MigrationReview {
  status: ERC8004MigrationReviewStatus;
  reviewedAt?: string;
  reviewedBy?: string;
  notes?: string;
}

export interface ERC8004MigrationInput {
  chainId: number;
  registryAddress: string;
  agentId: string;
  owner: string;
  agentWallet: string;
  currentAgentURI: string;
  currentContent: string;
  targetAgentURI?: string;
  targetContent?: string;
}

export interface ERC8004MigrationRecord {
  agentId: string;
  identity: {
    agentRegistry: string;
    owner: string;
    /** Exact registry observation; zero means no currently verified payment wallet. */
    observedAgentWallet: string;
  };
  status: ERC8004MigrationStatus;
  before: {
    agentURI: string;
    contentSha256: string;
    artifactType: 'agirails-markdown' | 'registration-v1' | 'unknown';
  };
  after?: {
    targetAgentURI?: string;
    registration: ERC8004RegistrationV1;
    serializedRegistration: string;
    contentSha256: string;
    observedAgentWallet: string;
  };
  checks: {
    transactionGenerated: false;
    paymentWalletChanged: false;
    paymentWalletUsable: boolean;
    targetContentVerified: boolean;
  };
  /**
   * Human review state. This planner never changes it to approved. A previous
   * decision survives a resumed run only while the evidence fingerprint is
   * unchanged.
   */
  review: ERC8004MigrationReview;
  blocker?: string;
}

export interface ERC8004MigrationLedger {
  version: 1;
  generatedAt: string;
  records: ERC8004MigrationRecord[];
}

function sha256(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf-8').digest('hex')}`;
}

function parseRegistrationV1(content: string): unknown | undefined {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    return value?.type === ERC8004_REGISTRATION_V1_TYPE ? value : undefined;
  } catch {
    return undefined;
  }
}

function registryReference(chainId: number, registryAddress: string): string {
  return `eip155:${chainId}:${registryAddress}`;
}

function isUint256AgentId(agentId: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(agentId) && BigInt(agentId) <= (1n << 256n) - 1n;
}

function pendingReview(): ERC8004MigrationReview {
  return { status: 'pending' };
}

function beforeRecord(
  input: ERC8004MigrationInput,
  artifactType: ERC8004MigrationRecord['before']['artifactType']
): ERC8004MigrationRecord['before'] {
  return {
    agentURI: input.currentAgentURI,
    contentSha256: sha256(input.currentContent),
    artifactType,
  };
}

function hasIdentityReference(
  registration: ERC8004RegistrationV1,
  agentId: string,
  agentRegistry: string
): boolean {
  return registration.registrations.some(
    (entry) => String(entry.agentId) === agentId && entry.agentRegistry === agentRegistry
  );
}

function assertMigrationUri(uri: string, label: string, allowMarkdownData: boolean): void {
  if (uri.startsWith('https://')) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new Error(`Migration inventory ${label} must be a valid HTTPS URI`);
    }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
      throw new Error(`Migration inventory ${label} must be a credential-free HTTPS URI`);
    }
    return;
  }

  if (uri.startsWith('ipfs://')) {
    const path = uri.slice('ipfs://'.length);
    const segments = path.split('/');
    if (
      segments.some(
        (segment) =>
          !segment || segment === '.' || segment === '..' || !/^[a-zA-Z0-9._~-]+$/.test(segment)
      )
    ) {
      throw new Error(`Migration inventory ${label} must be a valid IPFS URI`);
    }
    return;
  }

  const mediaTypes = allowMarkdownData
    ? '(?:application/json|text/markdown)'
    : 'application/json';
  const dataUriPattern = new RegExp(
    `^data:${mediaTypes}(?:;charset=[^;,]+)?(?:;base64)?,[\\s\\S]*$`,
    'i'
  );
  if (!dataUriPattern.test(uri)) {
    throw new Error(
      `Migration inventory ${label} must be an https, ipfs, or supported data URI`
    );
  }
}

function assertMigrationIdentity(input: ERC8004MigrationInput): void {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new Error('Migration inventory chainId must be a positive safe integer');
  }
  if (!isUint256AgentId(input.agentId)) {
    throw new Error('Migration inventory agentId must be a uint256 decimal string');
  }
  for (const [label, value] of [
    ['registryAddress', input.registryAddress],
    ['owner', input.owner],
    ['agentWallet', input.agentWallet],
  ] as const) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
      throw new Error(`Migration inventory ${label} must be an EVM address`);
    }
  }
  assertMigrationUri(input.currentAgentURI, 'currentAgentURI', true);
  if (input.targetAgentURI !== undefined) {
    assertMigrationUri(input.targetAgentURI, 'targetAgentURI', false);
  }
}

/** Build one evidence-bound migration record. No external I/O occurs here. */
export function createERC8004MigrationRecord(
  input: ERC8004MigrationInput
): ERC8004MigrationRecord {
  assertMigrationIdentity(input);
  const registryAddress = getAddress(input.registryAddress);
  const observedAgentWallet = getAddress(input.agentWallet);
  const identity = {
    agentRegistry: registryReference(input.chainId, registryAddress),
    owner: getAddress(input.owner),
    observedAgentWallet,
  };
  const checks = {
    transactionGenerated: false as const,
    paymentWalletChanged: false as const,
    paymentWalletUsable: observedAgentWallet !== ZeroAddress,
    targetContentVerified: false,
  };

  const currentRegistrationValue = parseRegistrationV1(input.currentContent);
  if (currentRegistrationValue !== undefined) {
    let currentRegistration: ERC8004RegistrationV1;
    try {
      validateERC8004RegistrationV1(currentRegistrationValue);
      currentRegistration = currentRegistrationValue;
    } catch (error) {
      return {
        agentId: input.agentId,
        identity,
        status: 'blocked',
        before: beforeRecord(input, 'registration-v1'),
        checks,
        review: pendingReview(),
        blocker: `Current registration-v1 JSON is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    if (hasIdentityReference(currentRegistration, input.agentId, identity.agentRegistry)) {
      return {
        agentId: input.agentId,
        identity,
        status: 'already-registration-v1',
        before: beforeRecord(input, 'registration-v1'),
        checks,
        review: pendingReview(),
      };
    }

    const reboundRegistration: ERC8004RegistrationV1 = {
      ...currentRegistration,
      registrations: [
        ...currentRegistration.registrations,
        { agentId: input.agentId, agentRegistry: identity.agentRegistry },
      ],
    };
    return finalizeMigrationRecord(
      input,
      identity,
      checks,
      reboundRegistration,
      'registration-v1'
    );
  }

  let parsed: ReturnType<typeof parseAgirailsMd>;
  try {
    parsed = parseAgirailsMd(input.currentContent);
  } catch (error) {
    return {
      agentId: input.agentId,
      identity,
      status: 'blocked',
      before: beforeRecord(input, 'unknown'),
      checks,
      review: pendingReview(),
      blocker: `Current agentURI is neither registration-v1 JSON nor AGIRAILS Markdown: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  let registration: ERC8004RegistrationV1;
  try {
    registration = buildERC8004RegistrationV1({
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      agirailsConfigURI: input.currentAgentURI,
      registration: {
        agentId: input.agentId,
        agentRegistry: identity.agentRegistry,
      },
    });
  } catch (error) {
    return {
      agentId: input.agentId,
      identity,
      status: 'blocked',
      before: beforeRecord(input, 'agirails-markdown'),
      checks,
      review: pendingReview(),
      blocker: `Could not build registration-v1 projection: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return finalizeMigrationRecord(
    input,
    identity,
    checks,
    registration,
    'agirails-markdown'
  );
}

function finalizeMigrationRecord(
  input: ERC8004MigrationInput,
  identity: ERC8004MigrationRecord['identity'],
  checks: ERC8004MigrationRecord['checks'],
  registration: ERC8004RegistrationV1,
  beforeArtifactType: ERC8004MigrationRecord['before']['artifactType']
): ERC8004MigrationRecord {
  const serializedRegistration = serializeERC8004RegistrationV1(registration);
  const after = {
    ...(input.targetAgentURI ? { targetAgentURI: input.targetAgentURI } : {}),
    registration,
    serializedRegistration,
    contentSha256: sha256(serializedRegistration),
    observedAgentWallet: identity.observedAgentWallet,
  };

  if (!input.targetAgentURI) {
    return {
      agentId: input.agentId,
      identity,
      status: 'needs-upload',
      before: beforeRecord(input, beforeArtifactType),
      after,
      checks,
      review: pendingReview(),
    };
  }

  if (input.targetContent === undefined) {
    return {
      agentId: input.agentId,
      identity,
      status: 'blocked',
      before: beforeRecord(input, beforeArtifactType),
      after,
      checks,
      review: pendingReview(),
      blocker: 'Target URI was supplied but its content could not be verified',
    };
  }

  try {
    const target = JSON.parse(input.targetContent) as unknown;
    validateERC8004RegistrationV1(target);
    const canonicalTarget = serializeERC8004RegistrationV1(target);
    if (canonicalTarget !== serializedRegistration) {
      throw new Error('target registration does not match the generated projection');
    }
  } catch (error) {
    return {
      agentId: input.agentId,
      identity,
      status: 'blocked',
      before: beforeRecord(input, beforeArtifactType),
      after,
      checks,
      review: pendingReview(),
      blocker: `Target URI verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return {
    agentId: input.agentId,
    identity,
    status: 'ready',
    before: beforeRecord(input, beforeArtifactType),
    after,
    checks: { ...checks, targetContentVerified: true },
    review: pendingReview(),
  };
}

function migrationKey(record: ERC8004MigrationRecord): string {
  return `${record.identity.agentRegistry}:${record.agentId}`;
}

function evidenceFingerprint(record: ERC8004MigrationRecord): string {
  return sha256(JSON.stringify({
    identity: record.identity,
    status: record.status,
    before: record.before,
    after: record.after
      ? {
          targetAgentURI: record.after.targetAgentURI,
          contentSha256: record.after.contentSha256,
          observedAgentWallet: record.after.observedAgentWallet,
        }
      : undefined,
    blocker: record.blocker,
  }));
}

/**
 * Build or resume a review ledger. Duplicate identities are rejected. A human
 * approval is preserved only when the complete before/after evidence remains
 * unchanged; any changed URI, content hash, wallet, status, or blocker resets
 * review to pending.
 */
export function createERC8004MigrationLedger(
  inputs: ERC8004MigrationInput[],
  previous?: ERC8004MigrationLedger,
  generatedAt = new Date().toISOString()
): ERC8004MigrationLedger {
  if (previous && previous.version !== 1) {
    throw new Error(`Unsupported ERC-8004 migration ledger version: ${String(previous.version)}`);
  }

  const previousByKey = new Map(
    (previous?.records ?? []).map((record) => [migrationKey(record), record])
  );
  const seen = new Set<string>();
  const records = inputs.map((input) => {
    const record = createERC8004MigrationRecord(input);
    const key = migrationKey(record);
    if (seen.has(key)) {
      throw new Error(`Duplicate ERC-8004 migration identity: ${key}`);
    }
    seen.add(key);

    const prior = previousByKey.get(key);
    if (prior && evidenceFingerprint(prior) === evidenceFingerprint(record)) {
      record.review = { ...prior.review };
    }
    return record;
  });

  records.sort((left, right) => migrationKey(left).localeCompare(migrationKey(right)));
  return { version: 1, generatedAt, records };
}
