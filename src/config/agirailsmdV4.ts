/**
 * V4 Typed Parser for {slug}.md Agent Identity Files
 *
 * Composes on top of the existing `parseAgirailsMd()` parser,
 * adding typed output, convention-over-config defaults, and validation.
 *
 * ## Design
 *
 * - `parseAgirailsMdV4(content)` returns a fully typed `AgirailsMdV4Config`
 * - Missing/commented fields → apply defaults from `defaults.ts`
 * - Unknown fields → ignored (forward-compatible)
 * - Invalid values → error with specific message
 * - Pure function — no side effects, no file I/O
 *
 * @module config/agirailsmdV4
 */

import { parseAgirailsMd } from './agirailsmd';
import { V4_DEFAULTS, V4_CONSTRAINTS } from './defaults';
import { generateSlug, validateSlug } from './slugUtils';

// ============================================================================
// Types
// ============================================================================

export interface AgirailsMdV4Pricing {
  base: number;
  currency: 'USDC';
  unit: string;
  negotiable: boolean;
  min_price: number;
  max_price: number;
}

export interface AgirailsMdV4SLA {
  response: string;
  delivery: string;
  concurrency: number;
  dispute_window: string;
}

export interface AgirailsMdV4Covenant {
  accepts: Record<string, string>;
  returns: Record<string, string>;
}

export interface AgirailsMdV4Config {
  name: string;
  slug: string;
  services: string[];
  pricing: AgirailsMdV4Pricing;
  network: 'mock' | 'testnet' | 'mainnet';
  sla: AgirailsMdV4SLA;
  covenant: AgirailsMdV4Covenant;
  payment: { modes: string[] };
  endpoint?: string;
  /** Markdown body before "## How to Request This Service" */
  description: string;
  /** Markdown body from "## How to Request This Service" to next ## or EOF */
  howToRequest: string;
  /** Read-only publish metadata */
  wallet?: string;
  agent_id?: string;
  did?: string;
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

// ============================================================================
// Parser
// ============================================================================

/**
 * Parse a {slug}.md file into a fully typed V4 config with defaults applied.
 *
 * Composes on `parseAgirailsMd()` — never modifies the original parser.
 *
 * @param content - Raw file content
 * @returns Typed V4 config with all defaults applied
 * @throws Error if content has no valid YAML frontmatter or is missing required fields (name)
 */
export function parseAgirailsMdV4(content: string): AgirailsMdV4Config {
  const { frontmatter, body } = parseAgirailsMd(content);
  return buildV4Config(frontmatter, body);
}

/**
 * Build a V4 config from parsed frontmatter and body.
 * Applies convention-over-config defaults for all optional fields.
 */
function buildV4Config(
  fm: Record<string, unknown>,
  body: string
): AgirailsMdV4Config {
  // Required: name
  const name = getString(fm, 'name');
  if (!name) {
    throw new Error('Missing required field: name');
  }

  // Slug: from YAML or generated from name
  const slug = getString(fm, 'slug') || generateSlug(name);

  // Services
  const services = getStringArray(fm, 'services');
  if (services.length === 0) {
    throw new Error('Missing required field: services (must be a non-empty array)');
  }

  // Pricing
  const pricingRaw = getObject(fm, 'pricing');
  const base = getNumber(pricingRaw, 'base');
  if (base === undefined || base === null) {
    throw new Error('Missing required field: pricing.base');
  }

  const pricing: AgirailsMdV4Pricing = {
    base,
    currency: 'USDC',
    unit: getString(pricingRaw, 'unit') || V4_DEFAULTS.pricing.unit,
    negotiable: getBoolean(pricingRaw, 'negotiable') ?? V4_DEFAULTS.pricing.negotiable,
    min_price: getNumber(pricingRaw, 'min_price') ?? base,
    max_price: getNumber(pricingRaw, 'max_price') ?? base,
  };

  // Network
  const networkRaw = getString(fm, 'network') || V4_DEFAULTS.network;
  const network = V4_CONSTRAINTS.VALID_NETWORKS.includes(networkRaw as 'mock' | 'testnet' | 'mainnet')
    ? (networkRaw as 'mock' | 'testnet' | 'mainnet')
    : V4_DEFAULTS.network;

  // SLA
  const slaRaw = getObject(fm, 'sla');
  const sla: AgirailsMdV4SLA = {
    response: getString(slaRaw, 'response') || V4_DEFAULTS.sla.response,
    delivery: getString(slaRaw, 'delivery') || V4_DEFAULTS.sla.delivery,
    concurrency: getNumber(slaRaw, 'concurrency') ?? V4_DEFAULTS.sla.concurrency,
    dispute_window: getString(slaRaw, 'dispute_window') || V4_DEFAULTS.sla.dispute_window,
  };

  // Covenant
  const covenantRaw = getObject(fm, 'covenant');
  const covenant: AgirailsMdV4Covenant = {
    accepts: getStringRecord(covenantRaw, 'accepts'),
    returns: getStringRecord(covenantRaw, 'returns'),
  };

  // Payment
  const paymentRaw = getObject(fm, 'payment');
  const modes = getStringArray(paymentRaw, 'modes');
  const payment = { modes: modes.length > 0 ? modes : [...V4_DEFAULTS.payment.modes] };

  // Endpoint (optional)
  const endpoint = getString(fm, 'endpoint') || undefined;

  // Publish metadata (read-only)
  const wallet = getString(fm, 'wallet') || undefined;
  const agent_id = getString(fm, 'agent_id') || undefined;
  const did = getString(fm, 'did') || undefined;

  // Parse markdown body by heading convention
  const { description, howToRequest } = parseBody(body);

  return {
    name,
    slug,
    services,
    pricing,
    network,
    sla,
    covenant,
    payment,
    endpoint,
    description,
    howToRequest,
    wallet,
    agent_id,
    did,
  };
}

// ============================================================================
// Body Parsing (Heading Convention)
// ============================================================================

/**
 * Split markdown body into description and howToRequest sections.
 *
 * - `description` = everything before "## How to Request This Service"
 * - `howToRequest` = from that heading to next ## or EOF
 * - If heading missing, entire body = description
 */
function parseBody(body: string): { description: string; howToRequest: string } {
  const heading = V4_CONSTRAINTS.HOW_TO_REQUEST_HEADING;
  const idx = body.indexOf(heading);

  if (idx === -1) {
    return { description: body.trim(), howToRequest: '' };
  }

  const description = body.slice(0, idx).trim();
  const afterHeading = body.slice(idx + heading.length);

  // Find next ## heading (if any)
  const nextHeadingMatch = afterHeading.match(/\n## /);
  const howToRequest = nextHeadingMatch
    ? afterHeading.slice(0, nextHeadingMatch.index).trim()
    : afterHeading.trim();

  return { description, howToRequest };
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a parsed V4 config for completeness and correctness.
 *
 * @param config - Parsed V4 config
 * @returns Validation result with issues
 */
export function validateAgirailsMdV4(config: AgirailsMdV4Config): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Slug validation
  const slugError = validateSlug(config.slug);
  if (slugError) {
    issues.push({ field: 'slug', message: slugError, severity: 'error' });
  }

  // Price validation
  if (config.pricing.base < 0) {
    issues.push({
      field: 'pricing.base',
      message: 'Price cannot be negative',
      severity: 'error',
    });
  } else if (config.pricing.base < V4_CONSTRAINTS.MIN_PRICE) {
    issues.push({
      field: 'pricing.base',
      message: `Price must be >= $${V4_CONSTRAINTS.MIN_PRICE} USDC`,
      severity: 'error',
    });
  }

  // Negotiable bounds
  if (config.pricing.negotiable) {
    if (config.pricing.min_price > config.pricing.max_price) {
      issues.push({
        field: 'pricing.min_price',
        message: 'min_price must be <= max_price',
        severity: 'error',
      });
    }
  }

  // SLA concurrency
  if (config.sla.concurrency < 1) {
    issues.push({
      field: 'sla.concurrency',
      message: 'Concurrency must be at least 1',
      severity: 'error',
    });
  }

  // Empty description warning
  if (!config.description) {
    issues.push({
      field: 'description',
      message: 'Agent has no description (markdown body is empty)',
      severity: 'warning',
    });
  }

  // Endpoint required for x402
  if (config.payment.modes.includes('x402') && !config.endpoint) {
    issues.push({
      field: 'endpoint',
      message: 'endpoint is required when payment modes include x402',
      severity: 'error',
    });
  }

  return {
    valid: issues.every((i) => i.severity !== 'error'),
    issues,
  };
}

// ============================================================================
// Helpers (safe property access with type coercion)
// ============================================================================

function getString(obj: Record<string, unknown> | undefined, key: string): string {
  if (!obj || obj[key] === undefined || obj[key] === null) return '';
  return String(obj[key]);
}

function getNumber(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!obj || obj[key] === undefined || obj[key] === null) return undefined;
  const val = Number(obj[key]);
  return isNaN(val) ? undefined : val;
}

function getBoolean(obj: Record<string, unknown> | undefined, key: string): boolean | undefined {
  if (!obj || obj[key] === undefined || obj[key] === null) return undefined;
  return Boolean(obj[key]);
}

function getStringArray(obj: Record<string, unknown> | undefined, key: string): string[] {
  if (!obj || !Array.isArray(obj[key])) return [];
  return (obj[key] as unknown[]).map(String);
}

function getObject(obj: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
  if (!obj || typeof obj[key] !== 'object' || obj[key] === null) return {};
  return obj[key] as Record<string, unknown>;
}

function getStringRecord(obj: Record<string, unknown> | undefined, key: string): Record<string, string> {
  const raw = getObject(obj, key);
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    result[k] = String(v);
  }
  return result;
}
