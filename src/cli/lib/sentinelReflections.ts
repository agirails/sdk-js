/**
 * Vendored copy of Sentinel's reflection table for local-fallback display.
 *
 * ## Why vendored?
 *
 * The Sentinel seed agent (`Public Agents/seed-sentinel/src/reflections.ts`)
 * is the canonical source of these one-liners — when a buyer hits Sentinel
 * via `actp test`, the AIP-16 delivery channel returns the day's reflection
 * inside `result.payload.reflection`. That is the happy path and remains
 * the source of truth at runtime.
 *
 * This file is a **byte-equivalent vendored copy** kept inside the SDK so
 * the CLI can render a local reflection when the channel delivery is
 * dormant (envelope subscription missed, relay was slow, decoding failed,
 * or the buyer ran offline against a cached state). The intent: even when
 * the delivery surface is silent, the buyer's "wow moment" still lands —
 * a quiet quote in their terminal instead of a blank receipt.
 *
 * ## Determinism contract
 *
 * Selection is deterministic per UTC day. `todaysReflection(now)` returns
 * the same entry for any `now` that falls inside the same UTC calendar
 * day, across the SDK and Sentinel, because both use the same:
 *   - djb2-style hash (Bernstein) of `YYYY-MM-DD`
 *   - modulo over the same 76-entry table in the same order
 *
 * This means a buyer who sees a local-fallback reflection on day D and
 * then re-runs `actp test` later that same day (after the channel
 * recovers) will receive **the same** quote from Sentinel. No
 * synchronicity is broken by the fallback.
 *
 * ## Sync policy
 *
 * Last synced: 2026-06-09 (against `Public Agents/seed-sentinel/src/reflections.ts`).
 *
 * When the upstream Sentinel table changes in a meaningful way (entries
 * added, removed, reworded, or reordered), port those changes here and
 * bump the "Last synced" date. The two tables MUST stay byte-identical
 * for the determinism contract to hold — if they diverge, buyers will
 * see one quote in fallback and a different quote on retry.
 *
 * The fallback path is the safety net, not the canonical render. If you
 * find yourself wanting to add SDK-only reflections here that are NOT in
 * Sentinel, stop: add them to Sentinel first, then port.
 *
 * @module cli/lib/sentinelReflections
 */

/**
 * A single curated reflection.
 *
 * Field-compatible with `Public Agents/seed-sentinel/src/reflections.ts`.
 * Only `id` and `text` are part of the determinism contract — any
 * additional fields would have to be ported to Sentinel too to keep the
 * tables byte-identical.
 */
export interface Reflection {
  /** Original ACIM Workbook lesson number (1–365). Stable across SDK versions. */
  id: number;
  /** The reflection text — exactly what Sentinel would have streamed. */
  text: string;
}

/**
 * The curated table. 76 entries.
 *
 * Byte-equivalent to the upstream Sentinel table. Do not reorder, edit
 * text, or drop entries without porting the same change to Sentinel
 * first — both tables drive the same `hashDateKey(YYYY-MM-DD) % 76`
 * selection, so any divergence yields different reflections on the same
 * day.
 */
export const REFLECTIONS: ReadonlyArray<Reflection> = Object.freeze([
  { id: 1,   text: 'Nothing I see means anything.' },
  { id: 2,   text: 'I have given everything I see all the meaning that it has for me.' },
  { id: 3,   text: 'I do not understand anything I see.' },
  { id: 9,   text: 'I see nothing as it is now.' },
  { id: 15,  text: 'My thoughts are images which I have made.' },
  { id: 16,  text: 'I have no neutral thoughts.' },
  { id: 17,  text: 'I see no neutral things.' },
  { id: 18,  text: 'I am not alone in experiencing the effects of my seeing.' },
  { id: 19,  text: 'I am not alone in experiencing the effects of my thoughts.' },
  { id: 21,  text: 'I am determined to see things differently.' },
  { id: 25,  text: 'I do not know what anything is for.' },
  { id: 28,  text: 'Above all else, I want to see things differently.' },
  { id: 31,  text: 'I am not the victim of the world I see.' },
  { id: 32,  text: 'I have invented the world I see.' },
  { id: 33,  text: 'There is another way of looking at the world.' },
  { id: 66,  text: 'My happiness and my function are one.' },
  { id: 68,  text: 'Love holds no grievances.' },
  { id: 80,  text: 'Let me recognize my problems have been solved.' },
  { id: 93,  text: 'Light and joy and peace abide within me.' },
  { id: 104, text: 'I seek but what belongs to me in truth.' },
  { id: 106, text: 'Let me be still and listen to the truth.' },
  { id: 107, text: 'Truth will correct the errors in my mind.' },
  { id: 108, text: 'To give and to receive are one in truth.' },
  { id: 121, text: 'Forgiveness is the key to happiness.' },
  { id: 122, text: 'Forgiveness offers everything I want.' },
  { id: 126, text: 'All that I give is given to myself.' },
  { id: 128, text: 'The world I see holds nothing that I want.' },
  { id: 129, text: 'Beyond this world there is a world I want.' },
  { id: 130, text: 'It is impossible to see two worlds.' },
  { id: 131, text: 'No one can fail who seeks to reach the truth.' },
  { id: 132, text: 'I loose the world from all I thought it was.' },
  { id: 133, text: 'I will not value what is valueless.' },
  { id: 135, text: 'If I defend myself I am attacked.' },
  { id: 152, text: 'The power of decision is my own.' },
  { id: 153, text: 'In my defenselessness my safety lies.' },
  { id: 158, text: 'Today I learn to give as I receive.' },
  { id: 195, text: 'Love is the way I walk in gratitude.' },
  { id: 198, text: 'Only my condemnation injures me.' },
  { id: 221, text: 'Peace to my mind. Let all my thoughts be still.' },
  { id: 236, text: 'I rule my mind, which I alone must rule.' },
  { id: 240, text: 'Fear is not justified in any form.' },
  { id: 243, text: 'Today I will judge nothing that occurs.' },
  { id: 249, text: 'Forgiveness ends all suffering and loss.' },
  { id: 250, text: 'Let me not see myself as limited.' },
  { id: 251, text: 'I am in need of nothing but the truth.' },
  { id: 255, text: 'This day I choose to spend in perfect peace.' },
  { id: 257, text: 'Let me remember what my purpose is.' },
  { id: 262, text: 'Let me perceive no differences today.' },
  { id: 268, text: 'Let all things be exactly as they are.' },
  { id: 281, text: 'I can be hurt by nothing but my thoughts.' },
  { id: 282, text: 'I will not be afraid of love today.' },
  { id: 284, text: 'I can elect to change all thoughts that hurt.' },
  { id: 289, text: 'The past is over. It can touch me not.' },
  { id: 290, text: 'My present happiness is all I see.' },
  { id: 291, text: 'This is a day of stillness and of peace.' },
  { id: 292, text: 'A happy outcome to all things is sure.' },
  { id: 293, text: 'All fear is past, and only love is here.' },
  { id: 300, text: 'Only an instant does this world endure.' },
  { id: 307, text: 'Conflicting wishes cannot be my will.' },
  { id: 308, text: 'This instant is the only time there is.' },
  { id: 309, text: 'I will not fear to look within today.' },
  { id: 310, text: 'In fearlessness and love I spend today.' },
  { id: 311, text: 'I judge all things as I would have them be.' },
  { id: 312, text: 'I see all things as I would have them be.' },
  { id: 313, text: 'Now let a new perception come to me.' },
  { id: 314, text: 'I seek a future different from the past.' },
  { id: 322, text: 'I can give up what was never real.' },
  { id: 323, text: 'I gladly make the sacrifice of fear.' },
  { id: 325, text: 'All things I think I see reflect ideas.' },
  { id: 332, text: 'Fear binds the world. Forgiveness sets it free.' },
  { id: 334, text: 'Today I claim the gifts forgiveness gives.' },
  { id: 336, text: 'Forgiveness lets me know that minds are joined.' },
  { id: 338, text: 'I am affected only by my thoughts.' },
  { id: 339, text: 'I will receive what I request.' },
  { id: 340, text: 'I can be free of suffering today.' },
  { id: 345, text: 'I offer only miracles today.' },
]);

/**
 * djb2-style additive hash over a string. Matches Sentinel's
 * implementation exactly: shift-subtract loop with `|= 0` to coerce back
 * to int32, then `Math.abs` to drop the sign. Two different inputs
 * yielding the same hash are vanishingly rare across YYYY-MM-DD keys
 * over the next 1000 years, so this is fine for the deterministic
 * "quote of the day" use case (NOT for cryptographic purposes).
 *
 * Exported for tests (the determinism contract is observable, not
 * hidden) and so callers verifying "same key → same hash" don't have to
 * reimplement it.
 */
export function djb2hash(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) - h) + key.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

/**
 * Format `YYYY-MM-DD` in **UTC**.
 *
 * UTC matters here: if we used local-tz date, two callers running the
 * same `actp test` at the same wall-clock instant from Zagreb and San
 * Francisco might land on different dates near midnight and see
 * different reflections — breaking the "everyone onboarding today shares
 * the same quote" property.
 *
 * Exported so tests can assert the slicing format directly.
 */
export function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Select today's reflection. Deterministic per UTC day.
 *
 * Matches Sentinel's `todaysReflection(now)` exactly: hash the UTC
 * YYYY-MM-DD key, modulo over the table length, return the entry. Same
 * day, same entry — across Sentinel and the local fallback.
 *
 * @param now - Defaults to `new Date()`. Tests pass a fixed Date.
 *              Per project rules: timing is injected, never inlined as
 *              a wall-clock primitive at a call site that needs to be
 *              deterministic — callers should pass an explicit Date when
 *              the result is being asserted.
 */
export function todaysReflection(now: Date = new Date()): Reflection {
  const key = utcDateKey(now);
  const idx = djb2hash(key) % REFLECTIONS.length;
  return REFLECTIONS[idx];
}
