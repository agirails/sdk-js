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

/**
 * Per-service descriptor as it lives in {slug}.md frontmatter.
 *
 * Mirrors what the SDK publish pipeline (`extractRegistrationParams`)
 * reads from each `services[]` entry to populate AgentRegistry's
 * per-service price band on-chain. `min_price` / `max_price` are the
 * bounds AgentRegistry enforces; `price` is the human-readable display
 * value (kept as a string for YAML lossless round-trip).
 */
export interface AgirailsMdV4ServiceEntry {
  type: string;
  price?: string;
  min_price?: number;
  max_price?: number;
}

export type AgirailsMdV4Intent = 'earn' | 'pay' | 'both';

export interface AgirailsMdV4Config {
  name: string;
  slug: string;
  /**
   * What this agent does on the network. Defaults to 'earn'.
   *  - earn: provides services and gets paid → registered on AgentRegistry
   *  - pay:  only requests services from other agents → NOT registered as
   *          provider on AgentRegistry; `services` must be empty
   *  - both: provides AND requests
   */
  intent: AgirailsMdV4Intent;
  /**
   * Services this agent provides, normalized to objects.
   * Legacy `services: ["code-review", ...]` (plain strings) is accepted
   * by the parser and lifted to `[{type: "code-review"}, ...]`.
   *
   * For `intent: 'pay'`, this is always empty — pay-only agents do not
   * provide services. The parser will not throw on missing services
   * when intent is 'pay'.
   */
  services: AgirailsMdV4ServiceEntry[];
  /**
   * Capability tags this agent wants to BUY from others. Required when
   * intent is 'pay' or 'both'. Spec field name: `servicesNeeded`
   * (alternate snake-case `services_needed` is also accepted).
   */
  servicesNeeded: string[];
  /**
   * Default budget per request in USDC. Used by buyers/agents when
   * calling `request()` without an explicit `budget`. Spec: only
   * meaningful when intent is 'pay' or 'both'.
   */
  budget?: number;
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

  // Intent — earn (default), pay, or both. Drives whether services are
  // required and whether the agent registers as a provider on-chain.
  const intentRaw = (getString(fm, 'intent') || V4_DEFAULTS.intent).toLowerCase();
  const intent: AgirailsMdV4Intent = (V4_CONSTRAINTS.VALID_INTENTS as readonly string[]).includes(intentRaw)
    ? (intentRaw as AgirailsMdV4Intent)
    : V4_DEFAULTS.intent;

  // Services — accept both legacy ["code-review", ...] (plain strings)
  // and canonical [{type, price, min_price, max_price}, ...] (objects).
  // Lift everything to AgirailsMdV4ServiceEntry so downstream code has
  // one shape to reason about. Pay-only agents may have no services.
  const services = parseServices(fm);
  if (services.length === 0 && intent !== 'pay') {
    throw new Error('Missing required field: services (must be a non-empty array)');
  }

  // Services this agent wants to BUY. Required when intent is pay/both.
  // Spec field: `servicesNeeded` (also accept `services_needed`).
  let servicesNeeded = getStringArray(fm, 'servicesNeeded');
  if (servicesNeeded.length === 0) servicesNeeded = getStringArray(fm, 'services_needed');
  if (intent !== 'earn' && servicesNeeded.length === 0) {
    throw new Error(
      `Missing required field: servicesNeeded (intent: ${intent} requires at least one capability to buy)`
    );
  }

  // Default budget per request — top-level, only meaningful for pay/both.
  const budget = getNumber(fm, 'budget');

  // Pricing — required for earn/both (you set your selling price); for
  // pay-only the file may legitimately omit pricing.base, in which case
  // we fall back to the budget so downstream consumers always have a
  // numeric anchor (UI cards, fee math, etc.).
  const pricingRaw = getObject(fm, 'pricing');
  const baseRaw = getNumber(pricingRaw, 'base');
  if (baseRaw === undefined && intent !== 'pay') {
    throw new Error('Missing required field: pricing.base');
  }
  const base = baseRaw ?? budget ?? 0;

  const pricing: AgirailsMdV4Pricing = {
    base,
    currency: 'USDC',
    unit: getString(pricingRaw, 'unit') || V4_DEFAULTS.pricing.unit,
    negotiable: getBoolean(pricingRaw, 'negotiable') ?? V4_DEFAULTS.pricing.negotiable,
    min_price: getNumber(pricingRaw, 'min_price') ?? base,
    max_price: getNumber(pricingRaw, 'max_price') ?? base,
  };

  // Network. The manifest vocabulary is mock | testnet | mainnet. Older
  // wizard-generated files used chain labels, so preserve those two known
  // aliases explicitly. Never reinterpret an unknown authored value as mock.
  const networkRaw = getString(fm, 'network') || V4_DEFAULTS.network;
  const normalizedNetwork = networkRaw.trim().toLowerCase();
  const legacyNetworkAliases: Readonly<Record<string, 'testnet' | 'mainnet'>> = {
    'base-sepolia': 'testnet',
    'base-mainnet': 'mainnet',
  };
  const network = V4_CONSTRAINTS.VALID_NETWORKS.includes(
    normalizedNetwork as 'mock' | 'testnet' | 'mainnet'
  )
    ? (normalizedNetwork as 'mock' | 'testnet' | 'mainnet')
    : legacyNetworkAliases[normalizedNetwork];
  if (!network) {
    throw new Error(
      `Invalid network: "${networkRaw}". Expected mock | testnet | mainnet ` +
        '(legacy aliases: base-sepolia | base-mainnet).'
    );
  }

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
    intent,
    services,
    servicesNeeded,
    budget,
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
/**
 * Parse `services` (or fall back to legacy `capabilities`) into a uniform
 * AgirailsMdV4ServiceEntry[] regardless of whether the YAML used the
 * legacy plain-string form or the canonical object form.
 */
function parseServices(fm: Record<string, unknown>): AgirailsMdV4ServiceEntry[] {
  const raw = (Array.isArray(fm.services) && fm.services.length > 0)
    ? fm.services
    : (Array.isArray(fm.capabilities) ? fm.capabilities : []);

  return (raw as unknown[]).flatMap((entry): AgirailsMdV4ServiceEntry[] => {
    if (typeof entry === 'string') {
      const type = entry.trim();
      return type ? [{ type }] : [];
    }
    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const type = String(obj.type ?? obj.service_type ?? '').trim();
      if (!type) return [];
      const out: AgirailsMdV4ServiceEntry = { type };
      if (obj.price !== undefined) out.price = String(obj.price);
      if (obj.min_price !== undefined && Number.isFinite(Number(obj.min_price))) {
        out.min_price = Number(obj.min_price);
      }
      if (obj.max_price !== undefined && Number.isFinite(Number(obj.max_price))) {
        out.max_price = Number(obj.max_price);
      }
      return [out];
    }
    return [];
  });
}

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
  return (obj[key] as unknown[]).flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (item && typeof item === 'object' && 'type' in item) return [String((item as Record<string, unknown>).type)];
    return [];
  });
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
