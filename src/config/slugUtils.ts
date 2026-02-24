/**
 * Slug Utilities for {slug}.md
 *
 * Handles slug generation from agent names and slug validation.
 *
 * @module config/slugUtils
 */

import { V4_CONSTRAINTS } from './defaults';

/**
 * Generate a URL-safe slug from an agent name.
 *
 * - Lowercase
 * - Spaces and special chars → hyphens
 * - Collapse multiple hyphens
 * - Strip leading/trailing hyphens
 * - Max 64 characters
 *
 * @example
 * generateSlug("Ultimate Lead Master") // "ultimate-lead-master"
 * generateSlug("Code Reviewer Pro!") // "code-reviewer-pro"
 */
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // non-alphanumeric → hyphen
    .replace(/-+/g, '-')          // collapse multiple hyphens
    .replace(/^-|-$/g, '')        // strip leading/trailing hyphens
    .slice(0, V4_CONSTRAINTS.MAX_SLUG_LENGTH);
}

/**
 * Validate a slug string.
 *
 * @returns Error message if invalid, null if valid
 */
export function validateSlug(slug: string): string | null {
  if (!slug) return 'Slug cannot be empty';
  if (slug.length > V4_CONSTRAINTS.MAX_SLUG_LENGTH) {
    return `Slug must be ${V4_CONSTRAINTS.MAX_SLUG_LENGTH} characters or less`;
  }
  if (!V4_CONSTRAINTS.SLUG_PATTERN.test(slug)) {
    return 'Slug must contain only lowercase letters, numbers, and hyphens';
  }
  return null;
}
