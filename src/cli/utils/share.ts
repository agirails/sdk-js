/**
 * Share utilities — clipboard (OSC 52) and cross-platform URL opening.
 *
 * Zero-dependency implementation:
 *   - Clipboard: OSC 52 escape sequence, supported by all modern terminals
 *     (iTerm2, Terminal.app, Alacritty, Windows Terminal, tmux, ghostty).
 *     Works over SSH. No `clipboardy` or `pbcopy`/`xclip` shell-outs.
 *   - URL open: platform-native (`open`/`xdg-open`/`start`) via child_process.
 *
 * @module cli/utils/share
 */

import { spawn } from 'child_process';

// ============================================================================
// Clipboard via OSC 52
// ============================================================================

/**
 * Copy text to the system clipboard using the OSC 52 escape sequence.
 *
 * OSC 52 is a terminal control sequence that writes to the clipboard.
 * It works in modern terminals and over SSH — no external dependency.
 *
 * Reference: https://www.xfree86.org/current/ctlseqs.html
 *
 * @param text - Plain text to copy (will be base64-encoded in the escape)
 * @returns true if the escape was emitted; does not guarantee the terminal actually copied.
 */
export function copyToClipboardOSC52(text: string): boolean {
  if (!process.stdout.isTTY) return false;
  const base64 = Buffer.from(text, 'utf-8').toString('base64');
  // OSC 52 format: ESC ] 52 ; c ; <base64> BEL
  // 'c' = clipboard (as opposed to 'p' = primary selection)
  const sequence = `\x1b]52;c;${base64}\x07`;
  process.stdout.write(sequence);
  return true;
}

// ============================================================================
// Twitter intent URL
// ============================================================================

/**
 * Build a Twitter compose URL with pre-filled tweet text.
 *
 * @param text - Tweet text (will be URL-encoded)
 * @returns https://twitter.com/intent/tweet?text=...
 */
export function buildTwitterIntentUrl(text: string): string {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
}

// ============================================================================
// Cross-platform URL open
// ============================================================================

/**
 * Open a URL in the user's default browser.
 *
 * Uses platform-native commands:
 *   - macOS: `open`
 *   - Linux: `xdg-open`
 *   - Windows: `start`
 *
 * @param url - URL to open
 * @returns true if the command was spawned; false if platform is unsupported.
 */
export function openUrl(url: string): boolean {
  let cmd: string;
  let args: string[];

  switch (process.platform) {
    case 'darwin':
      cmd = 'open';
      args = [url];
      break;
    case 'win32':
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
      break;
    case 'linux':
    case 'freebsd':
    case 'openbsd':
      cmd = 'xdg-open';
      args = [url];
      break;
    default:
      return false;
  }

  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Tweet text builders
// ============================================================================

/**
 * Build the mock-mode tweet text.
 */
export function buildMockTweet(netAmountUsd: string): string {
  return [
    `My AI agent just earned its first ${netAmountUsd} USDC.`,
    `Autonomously. Trustlessly. In under 60 seconds.`,
    ``,
    `Try: curl -sLO https://www.agirails.app/protocol/AGIRAILS.md`,
    ``,
    `@agirails`,
  ].join('\n');
}

/**
 * Build the testnet tweet text (includes basescan link).
 */
export function buildTestnetTweet(netAmountUsd: string, ethTxHash: string): string {
  const short = ethTxHash.length > 14 ? `${ethTxHash.slice(0, 8)}...${ethTxHash.slice(-4)}` : ethTxHash;
  return [
    `My AI agent settled its first on-chain payment on Base Sepolia.`,
    `${netAmountUsd} USDC net, trustless escrow.`,
    ``,
    `sepolia.basescan.org/tx/${short}`,
    ``,
    `Try: curl -sLO https://www.agirails.app/protocol/AGIRAILS.md`,
    ``,
    `@agirails`,
  ].join('\n');
}
