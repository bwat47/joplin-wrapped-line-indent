# ADR: Wrapped Line Indent — Position-Keyed Cache with Prefix Fallback

**Status:** Accepted  
**Date:** 2025-01-01  
**Component:** `wrappedLineIndentExtension` (`WrappedLineIndentPlugin`)

---

## Context

Soft-wrapped lines in a CodeMirror editor need a hanging indent so that continuation lines align visually with the first non-marker character of the line — past any list marker, blockquote chevron, task checkbox, or leading whitespace. This requires knowing the _pixel width_ of the prefix on each line, which cannot be computed purely from the document text: it depends on font rendering, device pixel ratio, zoom level, tab size, and any inline widgets that may affect glyph positions.

Two caching strategies were considered for storing those pixel measurements.

---

## Decision

We use a **position-keyed primary cache** (`${line.from}:${prefix.text}`) combined with a **prefix-keyed fallback cache** (keyed by normalised prefix text, with task-list checkboxes canonicalised to `[ ]`).

---

## Alternatives Considered

### Option A — Prefix-text-only cache (rejected)

Key measurements solely by the normalised prefix string (e.g. `"  - "`, `"> "`). A cache hit on any line with the same prefix text reuses that measurement for all other lines sharing that prefix.

**Advantages:**

- Simpler implementation (on paper) — one cache, no fallback logic.
- Measurements naturally survive scrolling: a line that leaves and re-enters the viewport reuses its cached value immediately, with no re-measurement round-trip.
- No position-tracking overhead.

**Problems:**

- Two lines with identical prefix text may render at different pixel widths if their surroundings differ — for example, if an inline widget appears earlier in the line, or if font shaping causes different glyph widths for the same character sequence in different contexts. Using a shared measurement in those cases produces incorrect indentation for some lines.
- Without separate pruning or eviction, the cache can hold stale measurements for prefix patterns that no longer appear, growing with the number of distinct prefixes seen over time.
- There is no way to force re-measurement of a specific line without invalidating all lines sharing that prefix, making targeted refresh difficult.
- In practise, these issues end up greatly complicating this approach (unless the decision is made to not handle edge cases like lists inside block quotes).

### Option B — Position-keyed cache with prefix fallback (chosen)

Key the primary cache by `${line.from}:${prefix.text}`. Additionally maintain a secondary cache keyed by normalised prefix text. When a line has no primary measurement yet, consult the fallback cache before falling back further to a character-width estimate.

---

## Rationale

### Correctness of position-based keying

Keying by `line.from` ensures each line gets its own measurement. Lines that share a prefix string but differ in their rendered pixel width — due to surrounding inline widgets, proportional font effects, or other layout influences — receive independent, correct indentation values rather than inheriting a potentially wrong shared value.

### Why the fallback cache is load-bearing, not merely a first-render optimisation

The fallback cache was initially motivated by the cold-cache problem — on first render no measurements exist, so without it lines would briefly show no indentation. But in practice the more severe problem it solves is **per-keystroke flicker across all visible lines below the edit point**.

Every edit shifts `line.from` for all lines after the edit point. A list item that was at position 1500 moves to 1502 after a two-character insertion. Because the primary cache key includes `line.from`, every visible line after the edit point gets a simultaneous cache miss — not just on first render, but on every single keystroke. Without the fallback cache, those visible lines would fall back to a character-width estimate once line padding is known, then snap to the exact width when the measurement round-trip completes. In a document with many visible list items this can be visibly jarring.

The fallback cache survives ordinary doc changes because its key is the normalised prefix text, which is position-independent. `"- "` is still `"- "` regardless of where in the document the line now sits. So even though the primary cache misses on every post-edit render for shifted visible lines, the fallback immediately provides the previous measurement, and the decoration is applied on the same frame as the edit. The measurement round-trip still runs and updates the primary cache, but for ordinary edits elsewhere in the document the fallback value is usually already correct, so there is often nothing visible to snap into place.

This means the fallback cache is what makes position-keyed caching viable at all in a live editor. Without it, position-keyed caching would be strictly worse than prefix-only caching for the common case of ordinary typing, because prefix keys are stable across edits whereas position keys are not. The two caches are complementary: the primary cache provides per-line correctness; the fallback cache provides the stability across edits that the primary cache structurally cannot.

When a line has no primary measurement, `addDecorationsForLine` consults `fallbackPrefixWidths` using the normalised prefix key. Because many lines share common prefixes (`"- "`, `"> "`, `"  * [x] "` → `"  * [ ] "`), the fallback cache is populated quickly from the first few measured lines and provides a good approximation for all others immediately. The `TASK_LIST_CHECKBOX_PATTERN` normalisation (`[x]` and `[X]` → `[ ]`) ensures that checked and unchecked task items share a fallback entry, which avoids a blank or estimated-width frame while direct measurement catches up. If the rendered widths differ in a particular editor state, the position-keyed primary measurement remains authoritative and corrects the fallback on the next refresh.

### Controlled cache growth via pruning

`pruneMeasuredLineWidths` removes primary cache entries for lines no longer in the visible viewport at the end of each `buildDecorations` call. This bounds memory usage in long documents. The fallback cache is intentionally not pruned, because it is small (one entry per distinct prefix pattern) and serves as the warm-start approximation for lines re-entering the viewport.

### Explicit invalidation of stale measurements

The `measurementSignature` — a composite of `defaultCharacterWidth`, `defaultLineHeight`, `scaleX`, `scaleY`, and `tabSize` — is checked on every update. When it changes, the fallback cache is cleared, visible lines are force-remeasured, and `linePadding` is marked stale. Existing visible primary measurements are left in place temporarily so decorations do not disappear while the refreshed measurements are pending. This handles font changes, zoom, and device pixel ratio shifts explicitly while preserving the last known exact widths until replacement measurements arrive.

### Stale-document guard

`measurePrefixes` compares `view.state.doc` against the document captured at schedule time (`measuredDoc`). If they differ — because an edit arrived between `scheduleMeasure` and the `read` callback — the result is discarded as stale and the measurement is retried. This prevents a class of subtle bugs where pixel widths measured against an old document layout are applied to a new document state.

### `forceVisibleLineMeasurements` for high-impact transitions

On events that are likely to invalidate many measurements at once — full document replaces, viewport changes, geometry changes, focus changes, selection changes — `forceVisibleLineMeasurements` is set to `true`. This causes all visible lines to be added to `pendingMeasurements` regardless of whether they have a primary cache entry, ensuring measurements are refreshed promptly rather than waiting for natural cache expiry.

### Single retry budget for incomplete measurements

When `coordsAtPos` returns null for some lines (e.g. because the layout is not yet stable), `needsRetry` is set and the measurement cycle repeats. The `incompleteMeasurementRefreshSpent` flag ensures this retry happens at most once per external trigger, preventing an infinite refresh loop in degenerate cases where coordinates remain unavailable.

---

## Consequences

**Positive:**

- Each line receives an independently correct indentation measurement.
- Per-keystroke flicker across all lines after the edit point is eliminated by the fallback cache, which is position-independent and survives `line.from` shifts.
- Flicker on first render is minimised by fallback widths once available and by character-width estimates after line padding is known; after full document replaces, both caches are cleared and visible lines rely on estimates or fresh measurement.
- Memory usage is bounded by viewport size for the primary cache.
- Cache invalidation is explicit and auditable via `measurementSignature` and `clearMeasurementCaches`.

**Negative:**

- Lines that scroll off-screen lose their primary cache entry and require a re-measurement round-trip when they return. In practice this is one frame of latency and is covered by the fallback cache, but it is a cost that the prefix-only strategy does not incur.
- The fallback cascade (`measuredWidth ?? fallbackWidth ?? estimatedWidth`) must be understood by anyone modifying `addDecorationsForLine`. Incorrect changes to cache key normalisation (e.g. the checkbox pattern) can cause fallback misses that reintroduce flicker.
- The `incompleteMeasurementRefreshSpent` guard is a subtle invariant: it resets on any `externalRefreshTrigger` and is consumed by the first incomplete-measurement retry. Callers adding new update paths must ensure they set `externalRefreshTrigger` appropriately or the retry budget will not reset.
