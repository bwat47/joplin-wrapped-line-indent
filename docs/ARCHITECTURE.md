A CodeMirror 6 `ViewPlugin` that implements hanging indentation by measuring rendered Markdown line prefixes and applying offset CSS decorations.

---

### 1. Core Mechanism

Wrapped visual lines align with the end of a Markdown prefix through a line decoration with two complementary CSS properties:

- **`padding-left`**: `PrefixWidth + BasePadding`
- **`text-indent`**: `-PrefixWidth`

This keeps the first visual line at the editor margin while wrapped visual lines start after the Markdown prefix.

To ensure accurate values for the indentation padding, the plugin measures the exact rendered pixel width of each line's prefix (list marker, blockquote chevron, whitespace, etc.) from the DOM.

### 2. Prefix Detection and Decoration Lifecycle

- **Visible range scan**: `buildDecorations` scans `view.visibleRanges`, parses each visible line with `parseIndentPrefix`, and decorates lines with prefixes.
- **Prefix metadata**: `ParsedIndentPrefix` records the raw prefix text used for measurement.
- **Line measurement keys**: `getLineMeasurementKey` keys exact measurements by visible line position and prefix text.
- **Syntax exclusions**: Lines inside `CodeBlock`, `FencedCode`, `CodeInfo`, or `HorizontalRule` syntax nodes are skipped.
- **Forced visible remeasurement**: Selection, focus, viewport, geometry, and measurement-signature changes pass `forceVisibleLineMeasurements` through `buildDecorations` to refresh visible line measurements while preserving displayed widths.
- **Tab replacement**: Tabs in measured prefixes are replaced with `TabWidget` instances that provide stable, measurable tab widths.

### 3. Measurement Pipeline

Measurements run through CodeMirror's `view.requestMeasure` read/write phases:

- **Read phase (`measurePrefixes`)**: For each pending visible line, calls `view.coordsAtPos` at the prefix start and end, then computes `endCoords.left - startCoords.left`.
- **Write phase**: Stores successful measurements in `measuredLineWidths`, updates fallback prefix widths, records measured line padding, and dispatches `measurementsChanged` when decorations need to refresh.
- **Stale document guard**: If the document changed before the measurement read completes, the result is discarded and measurement is rescheduled.
- **Retry logic**: Temporarily unavailable coordinates schedule one deferred refresh. Later refreshes come from the next editor update.

### 4. Tab vs. Space Handling

Tabs and spaces are measured as rendered layout:

- **Spaces**: Exact prefix widths are measured directly through character coordinates. The first available leading space is also measured and cached as `spaceCharacterWidth` so `estimatePrefixWidth` can avoid relying on `defaultCharacterWidth` for newly introduced space indentation.
- **Tabs**: Replaced by `TabWidget` with a width from `getTabReplacementWidth`, based on `view.state.tabSize` and `view.defaultCharacterWidth / view.scaleX`.
- **Rendered tab width**: The tab widget uses the same width formula as `estimatePrefixWidth`, so `coordsAtPos` observes the expected rendered layout.

### 5. Caching and Fallbacks

- **`measuredLineWidths`**: Exact per-visible-line measurements keyed by line start and prefix text.
- **`fallbackPrefixWidths`**: Display fallback widths keyed by normalized prefix text. Task checkbox states (`[ ]`, `[x]`, `[X]`) share a fallback key.
- **`spaceCharacterWidth`**: A cached measurement of one rendered leading space, used only by `estimatePrefixWidth` when exact and fallback prefix widths are unavailable.
- **Fallback order**: Decorations use exact line width first, then fallback prefix width, then `estimatePrefixWidth`.
- **Measurement queueing**: Missing exact widths and forced visible remeasurement queue `coordsAtPos` measurement.
- **Invalidation**: `measuredLineWidths` is preserved across rebuilds for still-visible lines whose line-start/prefix key still matches, then pruned for non-visible lines. `fallbackPrefixWidths` is kept across document, selection, focus, viewport, and geometry changes, and cleared when the measurement signature changes. `spaceCharacterWidth` is also cleared when the measurement signature changes.
- **`measurementSignature`**: Tracks `defaultCharacterWidth`, `defaultLineHeight`, `scaleX`, `scaleY`, and `tabSize` for font, zoom, scale, and tab metric changes.

### 6. Reactivity

The plugin rebuilds decorations and remeasures visible prefixes in response to:

- `docChanged`: Visible lines are rebuilt, matching visible exact measurements are reused, and stale non-visible line keys are pruned.
- `selectionSet`: Joplin render-markup visibility may change; visible lines are remeasured without clearing displayed widths.
- `focusChanged`: Editor render state may change; visible lines are remeasured.
- External state effects: Joplin ≥ 3.7 toggles render-markup visibility on mouseup through a transaction carrying only a private state effect; any transaction with a non-`measurementsChanged` effect forces visible line remeasurement.
- `geometryChanged` / `viewportChanged`: Layout or visible ranges changed; visible lines are remeasured.
- Syntax tree changes: Decorations are rebuilt when parser state changes.
- `measurementsChanged`: Newly measured widths are applied through an internal effect.
