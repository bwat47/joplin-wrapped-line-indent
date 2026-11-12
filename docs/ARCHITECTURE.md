A CodeMirror 6 `ViewPlugin` that implements hanging indentation by measuring rendered Markdown line prefixes and applying offset CSS decorations.

---

### 1. Core Mechanism

Wrapped visual lines align with the end of a Markdown prefix through a line decoration with two complementary CSS properties:

- **`padding-left`**: `PrefixWidth + BasePadding`
- **`text-indent`**: `-PrefixWidth`

This keeps the first visual line at the editor margin while wrapped visual lines start after the Markdown prefix.

The extension resets `text-indent` on all descendants of decorated lines (at zero specificity via `:where()`). Inline blocks such as Joplin's scaled `.cm-hidden` markup otherwise inherit the negative line indent, shifting their glyph coordinates and inflating measured prefix widths.

To ensure accurate values for the indentation padding, the plugin measures the exact rendered pixel width of each line's prefix (list marker, blockquote chevron, whitespace, etc.) from the DOM.

### 2. Prefix Detection and Decoration Lifecycle

- **Visible range scan**: `buildDecorations` scans `view.visibleRanges`, finds each visible line's prefix with `findIndentPrefix`, and decorates lines with prefixes.
- **Prefix detection**: `findIndentPrefix` walks the leading run of whitespace and `QuoteMark`, `ListMark`, and `TaskMarker` syntax nodes. Lines the parser has not reached yet (`syntaxTreeAvailable` is false) get no prefix; the syntax tree change rebuild decorates them once CodeMirror's background parse catches up. Without a Markdown language, no lines are decorated.
- **Prefix metadata**: `ParsedIndentPrefix` records the raw prefix text used for measurement.
- **Line measurement keys**: `getLineMeasurementKey` keys exact measurements by visible line position and prefix text.
- **Syntax exclusions**: Lines inside `CodeBlock`, `FencedCode`, `CodeInfo`, or `HorizontalRule` syntax nodes are skipped.
- **Visible remeasurement**: Every editor update rebuilds the decorations and queues all visible prefixed lines for measurement, while the last known widths stay displayed. The one exception is the plugin's own `measurementsChanged` refresh, which queues only lines that have no measurement yet.
- **Tab replacement**: Tabs in measured prefixes are replaced with `TabWidget` instances that provide stable, measurable tab widths.

### 3. Measurement Pipeline

Measurements run through CodeMirror's `view.requestMeasure` read/write phases:

- **Read phase (`measurePrefixes`)**: Reads the shared base padding from the first undecorated line, retaining the previous value when none is available. For each pending visible line, calls `view.coordsAtPos` at the prefix start and end, then computes `endCoords.left - startCoords.left`.
- **Write phase**: Stores successful prefix widths in `measuredLineWidths`, updates `fallbackPrefixWidths`, records the shared line padding, and queues a deduplicated microtask to dispatch `measurementsChanged` when decorations need to refresh. The microtask runs after CodeMirror leaves its write phase, allowing widths to be applied before paint without waiting for another animation frame. Queued refreshes do nothing after plugin destruction.
- **Live measurement queue**: The plugin registers one persistent measure request. Its read phase measures whatever `pendingMeasurements` holds at that moment. CodeMirror runs the read phase after every plugin update, so the queue always matches the current state and no snapshot or stale-document check is needed.
- **Pending remeasurement**: `remeasureVisibleLines` stays set from an update until a read phase has run, so the plugin's own refresh cannot drop a full remeasurement that is still queued.
- **Retry logic**: Temporarily unavailable coordinates schedule one deferred refresh. Later refreshes come from the next editor update.

### 4. Tab vs. Space Handling

Tabs and spaces are measured as rendered layout:

- **Spaces**: Exact prefix widths are measured directly through character coordinates. The first available leading space is also measured and cached as `spaceCharacterWidth` so `estimatePrefixWidth` can avoid relying on `defaultCharacterWidth` for newly introduced space indentation.
- **Tabs**: Replaced by `TabWidget` with a width from `getTabReplacementWidth`, based on `view.state.tabSize` and `view.defaultCharacterWidth / view.scaleX`.
- **Rendered tab width**: The tab widget uses the same width formula as `estimatePrefixWidth`, so `coordsAtPos` observes the expected rendered layout.

### 5. Caching and Fallbacks

- **`measuredLineWidths`**: Exact per-visible-line prefix widths keyed by line start and normalized prefix text.
- **`fallbackPrefixWidths`**: Display fallback widths keyed by normalized prefix text. Task checkbox states (`[ ]`, `[x]`, `[X]`) share a fallback key.
- **`spaceCharacterWidth`**: A cached measurement of one rendered leading space, used only by `estimatePrefixWidth` when exact and fallback prefix widths are unavailable.
- **Fallback order**: Decorations use the exact line width first, then the fallback width, then `estimatePrefixWidth`. Estimates wait until the shared line padding has been measured.
- **Measurement queueing**: Every update other than the plugin's own refresh queues `coordsAtPos` measurement for all visible prefixed lines; the own refresh queues only lines without an exact measurement.
- **Invalidation**: `measuredLineWidths` is preserved across rebuilds for still-visible lines whose line-start/prefix key still matches, then pruned for non-visible lines. `fallbackPrefixWidths` is kept across document, selection, focus, viewport, and geometry changes, and cleared when the measurement signature changes. `spaceCharacterWidth` is also cleared when the measurement signature changes.
- **`measurementSignature`**: Tracks `defaultCharacterWidth`, `defaultLineHeight`, `scaleX`, `scaleY`, and `tabSize` for font, zoom, scale, and tab metric changes.

### 6. Reactivity

Prefix rendering can change without the document changing: Joplin reveals markup at the cursor and, since 3.7, toggles it on mouseup through a transaction carrying only a private state effect. The plugin therefore does not try to enumerate the triggers. Every `update` call rebuilds the decorations from the last known measurements and remeasures all visible prefixed lines. This covers document, selection, focus, viewport, geometry, syntax tree, and foreign state effect changes.

The plugin's own `measurementsChanged` refresh is the exception. It only applies widths that were just measured, so it queues measurement only for lines that still have none (and for all lines if the measurement signature changed in the same update). Remeasuring everything after it could loop.
