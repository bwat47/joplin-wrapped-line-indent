# ADR: Wrapped Line Indent — Position-Keyed Cache with Prefix Fallback

**Status:** Accepted  
**Date:** 2025-01-01  
**Component:** `wrappedLineIndentExtension` (`WrappedLineIndentPlugin`)

---

## Context

Soft-wrapped lines need a hanging indent aligned past any list marker, blockquote chevron, task checkbox, or leading whitespace. This requires the _pixel width_ of each line's prefix, which cannot be computed from text alone — it depends on font rendering, DPR, zoom, tab size, and inline widgets.

---

## Decision

A **position-keyed primary cache** (`${line.from}:${prefix.text}`) combined with a **prefix-keyed fallback cache** (keyed by normalized prefix text, with task-list checkboxes canonicalized to `[ ]`).

---

## Alternatives Considered

### Option A — Prefix-text-only cache (rejected)

Key measurements solely by normalized prefix string; any line sharing a prefix reuses the cached width.

**Advantages:** Simpler; measurements survive scrolling without re-measurement.

**Problems:**

- Two lines with identical prefix text can render at different pixel widths (e.g. if markup is hidden/revealed on one line), producing incorrect indentation.
- No way to force re-measurement of a specific line without invalidating all lines sharing that prefix.
- Together, these problems significantly complicate this approach due to interactions with Joplin's markup rendering (where markdown can be conditionally revealed based on cursor position).

### Option B — Position-keyed cache with prefix fallback (chosen)

Key the primary cache by `${line.from}:${prefix.text}`; maintain a secondary cache keyed by normalized prefix text as a fallback.

---

## Rationale

### Correctness of position-based keying

Each line gets its own measurement. Lines sharing a prefix string but differing in rendered width — due to surrounding inline widgets (hidden markup), font shaping, or sub-pixel positioning — receive independent, correct values.

Concrete example: clicking into a task list item expands a rendered checkbox back to raw `- [ ]` markdown. A prefix-only cache would force all inactive items (rendered checkboxes, narrower) to adopt the wider width of the active raw-text line. Position keying gives the active line its own independent measurement, leaving others unaffected.

### Why the fallback cache is load-bearing, not just a first-render optimization

Every edit shifts `line.from` for all lines after the edit point, causing a simultaneous primary-cache miss for every visible post-edit line on every keystroke. Without the fallback, those lines fall back to a character-width estimate and snap to the exact width when the measurement round-trip completes — visibly jarring in documents with many list items.

The fallback cache's key is position-independent, so it survives `line.from` shifts. Even though the primary cache misses for all shifted lines, the fallback immediately provides the previous measurement, applying the decoration on the same frame as the edit. The round-trip still runs, but in ordinary edits the fallback value is already correct, so there is nothing to snap.

The two caches are complementary: **the primary cache provides per-line correctness; the fallback cache provides the stability the primary cache structurally cannot.** The `TASK_LIST_CHECKBOX_PATTERN` normalization (`[x]`/`[X]` → `[ ]`) ensures checked and unchecked task items share a fallback entry, preventing a blank frame while direct measurement catches up.

### Performance

Decoration rebuilding iterates only visible lines (`O(V)`, not `O(N)`), so even a 50,000-line document incurs no more work per keystroke than the viewport requires.

### Controlled cache growth

`pruneMeasuredLineWidths` removes primary cache entries for lines no longer visible after each `buildDecorations` call. The fallback cache is intentionally not pruned — it's small (one entry per distinct prefix pattern) and serves as the warm-start approximation for lines re-entering the viewport.

### Explicit invalidation

The `measurementSignature` — a composite of `defaultCharacterWidth`, `defaultLineHeight`, `scaleX`, `scaleY`, and `tabSize` — is checked on every update. When it changes, the fallback cache is cleared and visible lines are force-remeasured. Existing primary measurements are kept until replacements arrive, so decorations don't disappear mid-transition. This handles font changes, zoom, and DPR shifts explicitly.

### Stale-document guard

`measurePrefixes` compares `view.state.doc` against the document captured at schedule time. If they differ (an edit arrived between `scheduleMeasure` and the `read` callback), the result is discarded and measurement retried, preventing pixel widths from an old layout being applied to a new document state.

### `forceVisibleLineMeasurements`

On high-impact transitions — full document replaces, viewport/geometry changes, focus/selection changes — all visible lines are added to `pendingMeasurements` regardless of primary cache state, ensuring prompt refresh.

### Single retry budget

When `coordsAtPos` returns null (layout not yet stable), `needsRetry` is set and the cycle repeats. `incompleteMeasurementRefreshSpent` limits this to one retry per external trigger, preventing infinite refresh loops.

---

## Consequences

**Positive:**

- Each line receives an independently correct indentation measurement.
- Per-keystroke flicker across all post-edit lines is eliminated by the fallback cache.
- Memory usage is bounded by viewport size for the primary cache.
- Cache invalidation is explicit and auditable via `measurementSignature` and `clearMeasurementCaches`.

**Negative:**

- Lines scrolling off-screen lose their primary cache entry and require a re-measurement round-trip on return (covered by the fallback, but a cost prefix-only caching doesn't incur).
- The fallback cascade (`measuredWidth ?? fallbackWidth ?? estimatedWidth`) in `addDecorationsForLine` must be understood by maintainers. Incorrect changes to cache key normalization (e.g. the checkbox pattern) can silently reintroduce flicker.
- `incompleteMeasurementRefreshSpent` resets on any `externalRefreshTrigger`; new update paths must set that flag appropriately or the retry budget won't reset.
