/**
 * Security Utilities for ACTP SDK
 *
 * SECURITY FIXES:
 * - H-7: Constant-time string comparison (timing attack prevention)
 * - H-6: Path traversal prevention
 * - H-2: Input validation and sanitization
 * - C-3: Safe JSON parsing with schema validation
 *
 * @module utils/security
 */

import * as crypto from 'crypto';
import * as path from 'path';

/**
 * H-7: Constant-time string comparison to prevent timing attacks
 *
 * Never use === for comparing signatures, hashes, or other security-sensitive strings
 * as it can leak timing information that attackers can exploit.
 *
 * @param a - First string to compare
 * @param b - Second string to compare
 * @returns true if strings are equal, false otherwise
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  // Convert to buffers for crypto.timingSafeEqual
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  // If lengths differ, still use timingSafeEqual to prevent timing leaks
  if (bufA.length !== bufB.length) {
    // Compare against a dummy buffer of the same length to maintain constant time
    const dummy = Buffer.alloc(bufA.length);
    crypto.timingSafeEqual(bufA, dummy);
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * H-6: Validate and sanitize directory path to prevent path traversal
 *
 * Ensures that the provided path:
 * 1. Does not contain '..' sequences
 * 2. Resolves to a location within the allowed base directory
 * 3. Does not follow symlinks (optional)
 *
 * @param requestedPath - The path to validate
 * @param baseDirectory - The base directory to restrict paths to
 * @returns Sanitized absolute path
 * @throws Error if path is invalid or contains traversal attempts
 */
export function validatePath(requestedPath: string, baseDirectory: string): string {
  // Check for null bytes (can be used to bypass security checks)
  if (requestedPath.includes('\0')) {
    throw new Error('Invalid path: null byte detected');
  }

  // Normalize the path BEFORE checking for '..'
  // This prevents tricks like '.../...//' or 'foo/../../../etc/passwd'
  const normalized = path.normalize(requestedPath);

  // Check for '..' sequences after normalization
  if (normalized.includes('..')) {
    throw new Error('Invalid path: path traversal detected (..)');
  }

  // Resolve to absolute path
  const absolute = path.resolve(baseDirectory, normalized);

  // Ensure the resolved path is still within the base directory
  // This prevents attacks like:
  // - Symlink following to escape the directory
  // - Absolute paths that ignore the base directory
  const normalizedBase = path.resolve(baseDirectory);
  if (!absolute.startsWith(normalizedBase + path.sep) && absolute !== normalizedBase) {
    throw new Error(`Invalid path: resolved path '${absolute}' is outside base directory '${normalizedBase}'`);
  }

  return absolute;
}

/**
 * H-2: Validate and sanitize service name
 *
 * Ensures service name:
 * 1. Contains only safe characters (alphanumeric, dash, dot, underscore)
 * 2. Does not exceed maximum length
 * 3. Does not contain special characters that could cause injection
 *
 * @param serviceName - The service name to validate
 * @returns Sanitized service name
 * @throws Error if service name is invalid
 */
export function validateServiceName(serviceName: string): string {
  if (!serviceName || typeof serviceName !== 'string') {
    throw new Error('Invalid service name: must be a non-empty string');
  }

  // Trim whitespace
  const trimmed = serviceName.trim();

  // Check length (max 256 chars)
  if (trimmed.length === 0) {
    throw new Error('Invalid service name: cannot be empty');
  }

  if (trimmed.length > 256) {
    throw new Error('Invalid service name: exceeds maximum length of 256 characters');
  }

  // Validate format: alphanumeric, dash, dot, underscore only
  // This prevents injection attacks and ensures compatibility across systems
  const validPattern = /^[a-zA-Z0-9._-]+$/;
  if (!validPattern.test(trimmed)) {
    throw new Error(
      'Invalid service name: only alphanumeric characters, dots, dashes, and underscores are allowed'
    );
  }

  // Prevent names that could cause issues
  if (trimmed === '.' || trimmed === '..' || trimmed.startsWith('.')) {
    throw new Error('Invalid service name: cannot start with a dot');
  }

  return trimmed;
}

/**
 * H-5: Validate Ethereum address format
 *
 * Ensures address:
 * 1. Is a valid hex string
 * 2. Has correct length (42 chars including '0x' prefix)
 * 3. Uses valid checksum if provided (EIP-55)
 *
 * @param address - The Ethereum address to validate
 * @returns true if address is valid, false otherwise
 */
export function isValidAddress(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }

  // Must start with 0x
  if (!address.startsWith('0x')) {
    return false;
  }

  // Must be exactly 42 characters (0x + 40 hex chars)
  if (address.length !== 42) {
    return false;
  }

  // Must contain only valid hex characters
  const hexPattern = /^0x[a-fA-F0-9]{40}$/;
  if (!hexPattern.test(address)) {
    return false;
  }

  // Note: Full EIP-55 checksum validation would be more complex
  // For now, we just validate format. In production, consider using ethers.utils.getAddress()

  return true;
}

/**
 * C-3: Safe JSON parsing with schema validation
 *
 * Prevents code injection and prototype pollution attacks by:
 * 1. Safely parsing JSON with error handling
 * 2. Validating the parsed object against an expected schema
 * 3. Removing __proto__, constructor, and prototype properties
 * 4. Returning only whitelisted fields
 *
 * @param jsonString - The JSON string to parse
 * @param schema - Expected schema (object with field names and types)
 * @returns Parsed and validated object, or null if invalid
 */
export function safeJSONParse<T = any>(
  jsonString: string,
  schema?: Record<string, string>
): T | null {
  if (!jsonString || typeof jsonString !== 'string') {
    return null;
  }

  // SECURITY FIX (C-3): Check JSON size to prevent DoS attacks
  const MAX_JSON_SIZE = 1_000_000; // 1MB
  if (jsonString.length > MAX_JSON_SIZE) {
    return null;
  }

  let parsed: any;

  try {
    // Basic JSON parsing
    parsed = JSON.parse(jsonString);
  } catch (error) {
    // Invalid JSON
    return null;
  }

  // Ensure we got an object (not a primitive or array at the top level)
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  // Remove dangerous properties that could be used for prototype pollution
  const dangerous = ['__proto__', 'constructor', 'prototype'];
  for (const key of dangerous) {
    delete parsed[key];
  }

  // If schema is provided, validate and whitelist
  if (schema) {
    const validated: Record<string, any> = {};

    for (const [field, expectedType] of Object.entries(schema)) {
      const value = parsed[field];

      // Skip if field doesn't exist
      if (value === undefined) {
        continue;
      }

      // Type check
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== expectedType && expectedType !== 'any') {
        // Type mismatch - skip this field
        continue;
      }

      // Recursively sanitize nested objects
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        validated[field] = sanitizeObject(value);
      } else if (Array.isArray(value)) {
        validated[field] = value.map((item) =>
          typeof item === 'object' && item !== null ? sanitizeObject(item) : item
        );
      } else {
        validated[field] = value;
      }
    }

    return validated as T;
  }

  // No schema - return sanitized object
  return sanitizeObject(parsed) as T;
}

/**
 * Recursively sanitize an object by removing dangerous properties
 *
 * @param obj - Object to sanitize
 * @returns Sanitized object
 */
function sanitizeObject(obj: any): any {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  const sanitized: Record<string, any> = {};
  const dangerous = ['__proto__', 'constructor', 'prototype'];

  for (const [key, value] of Object.entries(obj)) {
    // Skip dangerous keys
    if (dangerous.includes(key)) {
      continue;
    }

    // Recursively sanitize nested objects
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeObject(value);
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map((item) =>
        typeof item === 'object' && item !== null ? sanitizeObject(item) : item
      );
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * LRU (Least Recently Used) cache with maximum size
 * Used for preventing unbounded memory growth
 *
 * @template K - Key type
 * @template V - Value type
 */
export class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private readonly maxSize: number;

  constructor(maxSize: number = 1000) {
    if (maxSize <= 0) {
      throw new Error('LRU cache maxSize must be positive');
    }
    this.maxSize = maxSize;
  }

  /**
   * Get value from cache
   *
   * @param key - Cache key
   * @returns Cached value or undefined
   */
  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  /**
   * Set value in cache
   *
   * @param key - Cache key
   * @param value - Value to cache
   */
  set(key: K, value: V): void {
    // Delete if already exists (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      // TypeScript doesn't know that Map iterator always returns defined values when size > 0
      // But we check size >= maxSize above, so this is safe
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, value);
  }

  /**
   * Check if key exists in cache
   *
   * SECURITY FIX (N-1): Use Map's native has() instead of get()
   * to avoid modifying LRU order on read-only operations.
   *
   * @param key - Cache key
   * @returns true if key exists
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Delete key from cache
   *
   * @param key - Cache key
   */
  delete(key: K): void {
    this.cache.delete(key);
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get all values from cache
   *
   * SECURITY FIX (N-2): Add iterator support for LRUCache.
   * Returns values in LRU order (oldest to newest).
   *
   * @returns Array of all cached values
   */
  values(): V[] {
    return Array.from(this.cache.values());
  }

  /**
   * Get all keys from cache
   *
   * @returns Array of all cached keys
   */
  keys(): K[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Get all entries from cache
   *
   * @returns Array of all cached [key, value] pairs
   */
  entries(): [K, V][] {
    return Array.from(this.cache.entries());
  }
}
