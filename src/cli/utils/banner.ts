/**
 * Banner — AGIRAILS ASCII logo rendering for CLI.
 *
 * Two renderings of the wireframe tetrahedron logo:
 *   - renderBanner()   full 6-line block, used by `actp init`
 *   - inlineBanner()   single-line ◬ glyph + wordmark, used by --help and actp test
 *
 * Both gracefully degrade to monochrome on terminals without color support.
 *
 * @module cli/utils/banner
 */

import { fmt } from './output';

// ============================================================================
// Full wireframe banner — `actp init`
// ============================================================================

/**
 * Render the full AGIRAILS banner (V3 wireframe tetrahedron).
 *
 * Six-line block. Renders all 4 tetrahedron vertices and 6 edges, plus the
 * AGIRAILS wordmark and tagline to the right of the logo.
 *
 * @returns multi-line string suitable for console.log
 */
export function renderBanner(): string {
  // All vertex nodes — cyan bullet (U+2022). Uniform size across all 4 vertices
  // matches the original SVG logo where every node is the same dot.
  const dot = fmt.cyan('•');
  // Edge characters — dim cyan
  const v = fmt.cyan(fmt.dim('│'));
  const slUp = fmt.cyan(fmt.dim('╱'));
  const slDown = fmt.cyan(fmt.dim('╲'));
  const hr = fmt.cyan(fmt.dim('─'));

  // Wordmark: AGI bold, RAILS normal weight
  const wordmark = fmt.bold('AGI') + 'RAILS';
  const tagline = fmt.dim('Trustless rails for AI agents');

  // Frame width aligned with receipt (outerWidth=54 → total 58 chars with ╔╗)
  const outerWidth = 54;
  const pad = (visibleLen: number, content: string) =>
    content + ' '.repeat(Math.max(0, outerWidth - visibleLen));

  // Logo column plan (apex at col 6, base corners at cols 1 and 11):
  //   Row 0: •                               col 6
  //   Row 1: ╱│╲                            cols 5, 6, 7
  //   Row 2: ╱ │ ╲          AGIRAILS        logo + wordmark (text starts col 15)
  //   Row 3: ╱  •  ╲         tagline         logo + tagline
  //   Row 4: ╱ ╱   ╲ ╲
  //   Row 5: •─────────•
  // Visible lengths (no ANSI) per row:
  //   Row 0: 7
  //   Row 1: 8
  //   Row 2: 23 (10 logo + 10 padding + 8 "AGIRAILS")
  //   Row 3: 44 (11 logo + 9 padding + 29 tagline + 0)
  //   Actually let me recompute below.
  // Visible lengths (no ANSI) per row — used for right-padding to outerWidth
  const contentRows = [
    { visibleLen: 7,  content: `      ${dot}` },
    { visibleLen: 8,  content: `     ${slUp}${v}${slDown}` },
    { visibleLen: 27, content: `    ${slUp} ${v} ${slDown}          ${wordmark}` },   // 11 logo+pad + 8 AGIRAILS = wait, see below
    { visibleLen: 48, content: `   ${slUp}  ${dot}  ${slDown}         ${tagline}` },
    { visibleLen: 11, content: `  ${slUp} ${slUp}   ${slDown} ${slDown}` },
    { visibleLen: 12, content: ` ${dot}${hr}${hr}${hr}${hr}${hr}${hr}${hr}${hr}${hr}${dot}` },
  ];

  const frameTop = `${fmt.cyan('╔')}${fmt.cyan('═'.repeat(outerWidth + 2))}${fmt.cyan('╗')}`;
  const frameBot = `${fmt.cyan('╚')}${fmt.cyan('═'.repeat(outerWidth + 2))}${fmt.cyan('╝')}`;
  const emptyLine = `${fmt.cyan('║')}  ${' '.repeat(outerWidth)}${fmt.cyan('║')}`;

  const framedRows = contentRows.map(
    ({ visibleLen, content }) => `${fmt.cyan('║')}  ${content}${' '.repeat(Math.max(0, outerWidth - visibleLen))}${fmt.cyan('║')}`
  );

  return [frameTop, emptyLine, ...framedRows, emptyLine, frameBot].join('\n');
}

// ============================================================================
// Inline banner — `actp --help`, `actp test`
// ============================================================================

/**
 * Render the inline AGIRAILS banner (V4 glyph + wordmark).
 *
 * Single line. Uses the ◬ glyph (U+25EC "white up-pointing triangle with dot")
 * which approximates the tetrahedron-with-inner-node motif.
 *
 * @param tagline - optional tagline to append after the wordmark
 * @returns single-line string suitable for console.log
 */
export function inlineBanner(tagline?: string): string {
  const glyph = fmt.cyan('◬');
  const wordmark = fmt.bold('AGI') + 'RAILS';

  if (tagline) {
    return `${glyph}  ${wordmark}  ${fmt.dim(tagline)}`;
  }
  return `${glyph}  ${wordmark}`;
}
