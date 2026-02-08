/**
 * AGIRAILS.md Parser + Canonical Hash
 *
 * Parses AGIRAILS.md files (YAML frontmatter + markdown body),
 * computes deterministic canonical hashes for on-chain verification.
 *
 * ## Canonical Hash Algorithm
 *
 * 1. Parse YAML frontmatter into a plain object
 * 2. **Strip publish metadata keys** (config_hash, published_at, config_cid, arweave_tx)
 *    — these are written back by the publish pipeline and must not affect the hash
 * 3. Canonicalize frontmatter:
 *    - Object keys: sorted lexicographically (recursive)
 *    - Primitive arrays: sorted lexicographically by `String(value).localeCompare()`
 *    - Object arrays: order preserved (semantic ordering matters)
 *    - Date objects: converted to ISO-8601 string (`.toISOString()`)
 *    - null/undefined: preserved as-is
 * 4. `structuredHash = keccak256(JSON.stringify(canonical))`
 * 5. Normalize body: CRLF→LF, strip trailing whitespace per line, trim
 * 6. `bodyHash = keccak256(normalizedBody)`
 * 7. `configHash = keccak256(structuredHash ++ bodyHash)` (byte concatenation)
 *
 * @module config/agirailsmd
 */

import { ethers } from 'ethers';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// ============================================================================
// Types
// ============================================================================

export interface AgirailsMdConfig {
  /** Parsed YAML frontmatter as a plain object */
  frontmatter: Record<string, unknown>;
  /** Markdown body (everything after the closing ---) */
  body: string;
}

export interface AgirailsMdHashResult {
  /** Final configHash = keccak256(structuredHash + bodyHash) */
  configHash: string;
  /** Hash of the canonical JSON representation of frontmatter */
  structuredHash: string;
  /** Hash of the normalized markdown body */
  bodyHash: string;
}

// ============================================================================
// Publish Metadata (excluded from hash computation)
// ============================================================================

/**
 * Frontmatter keys written by the publish pipeline.
 * These are stripped before hash computation to prevent self-reference drift:
 * publish writes config_hash back → changes frontmatter → changes hash → never in sync.
 */
export const PUBLISH_METADATA_KEYS = [
  'config_hash',
  'published_at',
  'config_cid',
  'arweave_tx',
  'template_source',
] as const;

/**
 * Strip publish metadata keys from a frontmatter object.
 * Returns a shallow copy with the metadata keys removed.
 */
export function stripPublishMetadata(
  frontmatter: Record<string, unknown>
): Record<string, unknown> {
  const stripped = { ...frontmatter };
  for (const key of PUBLISH_METADATA_KEYS) {
    delete stripped[key];
  }
  return stripped;
}

// ============================================================================
// Parser
// ============================================================================

/**
 * Parse an AGIRAILS.md file into frontmatter + body.
 *
 * @param content - Raw file content (string)
 * @returns Parsed config with frontmatter object and body string
 * @throws Error if content has no valid YAML frontmatter
 */
export function parseAgirailsMd(content: string): AgirailsMdConfig {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith('---')) {
    throw new Error('AGIRAILS.md must start with YAML frontmatter (---)');
  }

  // Find closing ---
  const closingIndex = trimmed.indexOf('\n---', 3);
  if (closingIndex === -1) {
    throw new Error('AGIRAILS.md frontmatter is not closed (missing closing ---)');
  }

  const yamlContent = trimmed.slice(4, closingIndex); // skip opening ---\n
  const body = trimmed.slice(closingIndex + 4); // skip \n---

  // Parse YAML
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseYaml(yamlContent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse YAML frontmatter: ${message}`);
  }

  if (typeof frontmatter !== 'object' || frontmatter === null) {
    throw new Error('YAML frontmatter must be an object');
  }

  return {
    frontmatter,
    body: body.startsWith('\n') ? body.slice(1) : body,
  };
}

// ============================================================================
// Canonical Hash
// ============================================================================

/**
 * Recursively canonicalize a value for deterministic JSON serialization.
 *
 * - Object keys: sorted lexicographically
 * - Primitive arrays: sorted by String(x).localeCompare()
 * - Object arrays: order preserved
 * - Date objects: converted to ISO-8601 string
 * - null/undefined: preserved
 */
export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // Handle Date objects deterministically (YAML parser may auto-create these)
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    // Canonicalize each element, then sort arrays of primitives lexicographically
    const canonicalized = value.map(canonicalize);

    // Only sort arrays of primitives (strings, numbers, booleans)
    // Arrays of objects maintain order (e.g., onboarding questions have semantic ordering)
    const allPrimitive = canonicalized.every(
      (item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
    );

    if (allPrimitive) {
      return canonicalized.sort((a, b) => String(a).localeCompare(String(b)));
    }

    return canonicalized;
  }

  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  return value;
}

/**
 * Normalize markdown body for deterministic hashing.
 * - Strip trailing whitespace from each line
 * - Ensure \n line endings
 * - Trim leading/trailing whitespace
 */
function normalizeBody(body: string): string {
  return body
    .replace(/\r\n/g, '\n') // CRLF → LF
    .replace(/\r/g, '\n') // CR → LF
    .split('\n')
    .map((line) => line.trimEnd()) // strip trailing whitespace per line
    .join('\n')
    .trim(); // trim leading/trailing
}

/**
 * Compute the canonical config hash from raw AGIRAILS.md content.
 *
 * @param content - Raw AGIRAILS.md file content
 * @returns Hash result with configHash, structuredHash, and bodyHash
 */
export function computeConfigHash(content: string): AgirailsMdHashResult {
  const { frontmatter, body } = parseAgirailsMd(content);
  return computeConfigHashFromParts(frontmatter, body);
}

/**
 * Compute the canonical config hash from parsed parts.
 *
 * Publish metadata keys (config_hash, published_at, config_cid, arweave_tx)
 * are automatically stripped before hashing to prevent self-reference drift.
 *
 * @param frontmatter - Parsed YAML frontmatter object
 * @param body - Markdown body string
 * @returns Hash result with configHash, structuredHash, and bodyHash
 */
export function computeConfigHashFromParts(
  frontmatter: Record<string, unknown>,
  body: string
): AgirailsMdHashResult {
  // Step 0: Strip publish metadata to prevent self-reference drift
  const stripped = stripPublishMetadata(frontmatter);

  // Step 1: Canonical JSON of frontmatter (with metadata stripped)
  const canonical = canonicalize(stripped);
  const canonicalJson = JSON.stringify(canonical);
  const structuredHash = ethers.keccak256(ethers.toUtf8Bytes(canonicalJson));

  // Step 2: Normalized body hash
  const normalized = normalizeBody(body);
  const bodyHash = ethers.keccak256(ethers.toUtf8Bytes(normalized));

  // Step 3: Combined hash
  const configHash = ethers.keccak256(
    ethers.concat([ethers.getBytes(structuredHash), ethers.getBytes(bodyHash)])
  );

  return { configHash, structuredHash, bodyHash };
}

// ============================================================================
// Serializer
// ============================================================================

/**
 * Serialize config back to AGIRAILS.md format.
 *
 * @param frontmatter - YAML frontmatter object
 * @param body - Markdown body string
 * @returns Complete AGIRAILS.md file content
 */
export function serializeAgirailsMd(
  frontmatter: Record<string, unknown>,
  body: string
): string {
  const yamlStr = stringifyYaml(frontmatter, {
    lineWidth: 120,
    singleQuote: false,
  }).trimEnd();

  const normalizedBody = body.startsWith('\n') ? body : `\n${body}`;

  return `---\n${yamlStr}\n---\n${normalizedBody}`;
}
