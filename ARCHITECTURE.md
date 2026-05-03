A CodeMirror 6 `ViewPlugin` that implements hanging indentation by measuring the rendered pixel width of Markdown line prefixes and applying offset CSS decorations.

---

### 1. Core Mechanism

The plugin aligns wrapped text with the end of each line prefix using a line decoration with two complementary CSS properties:

- **`padding-left`**: `PrefixWidth + BasePadding`
- **`text-indent`**: `-PrefixWidth`

This keeps the first visual line at the editor margin while wrapped visual lines start after the Markdown prefix.

### 2. Prefix Detection and Decoration Lifecycle

- **`buildDecorations`**: Scans only `view.visibleRanges`, parses each visible line with `parseIndentPrefix`, and decorates lines with prefixes.
- **Prefix metadata**: `ParsedIndentPrefix` records the prefix kind, raw prefix text, quote depth, and task checkbox offset. It does not encode selection-derived render states.
- **Direct line keys**: Exact measurements are keyed by visible line position and prefix text via `getLineMeasurementKey`.
- **Forced visible remeasurement**: Selection, focus, viewport, geometry, and measurement-signature changes pass an explicit `forceVisibleLineMeasurements` option through `buildDecorations` so visible lines are remeasured while their previous widths remain displayed.
- **Exclusion logic**: Lines inside `CodeBlock`, `FencedCode`, `CodeInfo`, or `HorizontalRule` syntax nodes are skipped.
- **Tab replacement**: Tabs in measured prefixes are replaced with `TabWidget` instances so the rendered tab width is stable and measurable.

### 3. Measurement Pipeline

To avoid layout thrashing, the plugin uses CodeMirror's `view.requestMeasure` read/write phases:

- **Read phase (`measurePrefixes`)**: For each pending visible line, calls `view.coordsAtPos` at the prefix start and end, then computes `endCoords.left - startCoords.left`.
- **Write phase**: Stores successful measurements in `measuredLineWidths`, updates fallback prefix widths, records measured line padding, and dispatches `measurementsChanged` when decorations need to refresh.
- **Stale document guard**: If the document changed before the measurement read completes, the result is discarded and measurement is rescheduled.
- **Retry logic**: If coordinates are temporarily unavailable, one deferred refresh is allowed; after that, the plugin waits for the next external editor update rather than repeatedly dispatching refreshes.

### 4. Tab vs. Space Handling

The plugin treats tabs and spaces as physical layout objects:

- **Spaces**: Measured directly through character coordinates.
- **Tabs**: Replaced by `TabWidget` with a width from `getTabReplacementWidth`, based on `view.state.tabSize` and `view.defaultCharacterWidth / view.scaleX`.
- **Precision**: The tab widget enforces the same width used by the estimate, so later `coordsAtPos` measurements observe the actual rendered layout.

### 5. Caching and Fallbacks

- **`measuredLineWidths`**: Exact per-visible-line measurements keyed by line start and prefix text. This is the source of truth for rendered width.
- **`fallbackPrefixWidths`**: Display-only fallback widths keyed by normalized prefix text. Task checkbox states (`[ ]`, `[x]`, `[X]`) share a fallback key so checkbox toggles can reuse a recent width while direct measurement catches up.
- **Fallback order**: Decorations use exact line width first, then fallback prefix width, then `estimatePrefixWidth`.
- **Measurement remains authoritative**: Fallback widths never suppress measurement. Missing exact line widths, or forced visible remeasurement, still queue `coordsAtPos` measurement.
- **Invalidation**: `measuredLineWidths` is cleared on document changes to avoid stale line-position growth. `fallbackPrefixWidths` is kept across document, selection, focus, viewport, and geometry changes to reduce flicker, but is cleared when the measurement signature changes.
- **`measurementSignature`**: Tracks `defaultCharacterWidth`, `defaultLineHeight`, `scaleX`, `scaleY`, and `tabSize`. Changes indicate font, zoom, scale, or tab metrics may have invalidated pixel widths.

### 6. Reactivity

The plugin rebuilds decorations and/or remeasures on:

- `docChanged`: Content or prefixes changed; exact line measurements are cleared, fallback widths are retained.
- `selectionSet`: Joplin render-markup visibility may change; visible lines are remeasured without clearing displayed widths.
- `focusChanged`: Editor render state may change; visible lines are remeasured.
- `geometryChanged` / `viewportChanged`: Layout or visible ranges changed; visible lines are remeasured.
- Syntax tree changes: Decorations are rebuilt when parsing state changes, so code blocks and horizontal rules are included or excluded correctly.
- `measurementsChanged`: Internal effect used to apply newly measured widths without waiting for unrelated editor updates.
