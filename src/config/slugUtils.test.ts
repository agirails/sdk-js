/**
 * Slug Utilities Tests
 *
 * @module config/slugUtils.test
 */

import { generateSlug, validateSlug } from './slugUtils';
import { V4_CONSTRAINTS } from './defaults';

// ============================================================================
// generateSlug
// ============================================================================

describe('generateSlug', () => {
  test('converts name to lowercase hyphenated slug', () => {
    expect(generateSlug('Ultimate Lead Master')).toBe('ultimate-lead-master');
  });

  test('strips special characters', () => {
    expect(generateSlug('Code Reviewer Pro!')).toBe('code-reviewer-pro');
  });

  test('collapses multiple hyphens', () => {
    expect(generateSlug('hello---world')).toBe('hello-world');
  });

  test('strips leading and trailing hyphens', () => {
    expect(generateSlug('--hello-world--')).toBe('hello-world');
  });

  test('handles unicode and special chars', () => {
    expect(generateSlug('Agent 🤖 v2.0')).toBe('agent-v2-0');
  });

  test('truncates to max slug length', () => {
    const longName = 'a'.repeat(100);
    const slug = generateSlug(longName);
    expect(slug.length).toBeLessThanOrEqual(V4_CONSTRAINTS.MAX_SLUG_LENGTH);
  });

  test('handles single word', () => {
    expect(generateSlug('translator')).toBe('translator');
  });

  test('handles numbers', () => {
    expect(generateSlug('Agent 42')).toBe('agent-42');
  });

  test('handles already-slugified input', () => {
    expect(generateSlug('code-reviewer')).toBe('code-reviewer');
  });

  test('handles empty string', () => {
    expect(generateSlug('')).toBe('');
  });
});

// ============================================================================
// validateSlug
// ============================================================================

describe('validateSlug', () => {
  test('returns null for valid slug', () => {
    expect(validateSlug('code-reviewer')).toBeNull();
  });

  test('returns null for single character slug', () => {
    expect(validateSlug('a')).toBeNull();
  });

  test('returns null for numeric slug', () => {
    expect(validateSlug('agent42')).toBeNull();
  });

  test('rejects empty string', () => {
    expect(validateSlug('')).toContain('empty');
  });

  test('rejects slug exceeding max length', () => {
    const long = 'a'.repeat(V4_CONSTRAINTS.MAX_SLUG_LENGTH + 1);
    expect(validateSlug(long)).toContain('characters or less');
  });

  test('accepts slug at exact max length', () => {
    const exact = 'a'.repeat(V4_CONSTRAINTS.MAX_SLUG_LENGTH);
    expect(validateSlug(exact)).toBeNull();
  });

  test('rejects uppercase characters', () => {
    expect(validateSlug('Code-Reviewer')).not.toBeNull();
  });

  test('rejects leading hyphen', () => {
    expect(validateSlug('-code-reviewer')).not.toBeNull();
  });

  test('rejects trailing hyphen', () => {
    expect(validateSlug('code-reviewer-')).not.toBeNull();
  });

  test('rejects spaces', () => {
    expect(validateSlug('code reviewer')).not.toBeNull();
  });

  test('rejects special characters', () => {
    expect(validateSlug('code_reviewer')).not.toBeNull();
  });
});
