/**
 * fsSafe - minimal filesystem hardening helpers
 *
 * Focus:
 * - Prevent symlink-based path escapes when persisting local state
 * - Avoid clobbering arbitrary files via pre-created symlink temp files
 *
 * NOTE: This is not a complete TOCTOU-proof sandbox, but it eliminates the
 * most common local symlink/hardlink footguns for SDK-managed state files.
 */

import * as fs from 'fs';

export function ensureSafeDir(dirPath: string, mode: number = 0o755): void {
  if (fs.existsSync(dirPath)) {
    const st = fs.lstatSync(dirPath);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to use symlink directory: ${dirPath}`);
    }
    if (!st.isDirectory()) {
      throw new Error(`Expected directory but found non-directory: ${dirPath}`);
    }
    return;
  }

  fs.mkdirSync(dirPath, { recursive: true, mode });

  // Post-create sanity: ensure it didn't become a symlink (defense-in-depth)
  const st = fs.lstatSync(dirPath);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`Created unsafe directory (symlink or non-dir): ${dirPath}`);
  }
}

export function assertSafeFileForRead(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const st = fs.lstatSync(filePath);
  if (st.isSymbolicLink()) {
    throw new Error(`Refusing to read from symlink file: ${filePath}`);
  }
  if (!st.isFile()) {
    throw new Error(`Expected file but found non-file: ${filePath}`);
  }
}

export function ensureSafeFile(
  filePath: string,
  contents: string,
  mode: number = 0o644
): void {
  if (fs.existsSync(filePath)) {
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to use symlink file: ${filePath}`);
    }
    if (!st.isFile()) {
      throw new Error(`Expected file but found non-file: ${filePath}`);
    }
    return;
  }

  // Use exclusive create to avoid clobbering a file that appears between
  // existsSync() and writeFileSync().
  fs.writeFileSync(filePath, contents, {
    encoding: 'utf-8',
    mode,
    flag: 'wx',
  });
}









