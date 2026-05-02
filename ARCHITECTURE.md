A CodeMirror 6 `ViewPlugin` that implements a hanging indent by dynamically calculating the pixel width of line prefixes and applying offset CSS decorations.

---

### 1. Core Mechanism

The plugin achieves alignment using two complementary CSS properties applied to the line via `Decoration.line`:

- **`padding-left`**: Offset by `PrefixWidth + BasePadding`.
- **`text-indent`**: Offset by `-PrefixWidth`.

This ensures the first line remains at the gutter margin while wrapped lines align with the end of the prefix.

### 2. State and Decoration Lifecycle

- **`buildDecorations`**: Scans `view.visibleRanges` and identifies line prefixes using `parseIndentPrefix`, which returns `ParsedIndentPrefix` metadata describing the raw prefix text, quote depth, task checkbox offset, and whether the prefix width depends on markup visibility.
- **Exclusion Logic**: Lines within `CodeBlock`, `FencedCode`, `CodeInfo`, or `HorizontalRule` nodes are ignored via `isInIndentExcludedSyntax`.
- **Tab Replacement**: Tab characters in the prefix are replaced by a `TabWidget`. This transforms an abstract tab into a measurable DOM element with a fixed `inline-style` width.

### 3. Measurement Pipeline

To prevent layout thrashing, the plugin utilizes the `view.requestMeasure` API, splitting the process into **Read** and **Write** phases:

- **Read Phase (`measurePrefixes`)**: Uses `view.coordsAtPos` to retrieve the viewport coordinates for the start (`from`) and end (`to`) of the prefix. The width is derived from `endCoords.left - startCoords.left`.
- **Write Phase**: Updates `cachedPrefixWidths` and dispatches a `StateEffect` (`measurementsChanged`) to trigger a re-render with the new dimensions.
- **Retry Logic**: Allows one deferred follow-up refresh when prefix coordinates are temporarily unavailable, then waits for the next external update rather than continuously dispatching refreshes.

### 4. Tab vs. Space Handling

The plugin treats tabs and spaces as physical layout objects:

- **Spaces**: Measured directly via character coordinates.
- **Tabs**: Assigned a pixel width using `getTabReplacementWidth`, which combines `view.state.tabSize` and a scale-aware character width derived from `view.defaultCharacterWidth`.
- **Precision**: While `view.defaultCharacterWidth` is an estimate, it remains internally consistent. Since the `TabWidget` enforces that specific width in the DOM, `coordsAtPos` measures the _resulting_ layout, ensuring the negative `text-indent` matches the physical space occupied by the tab.

### 5. Caching and Invalidation

- **`cachedPrefixWidths`**: A Map that stores widths to avoid redundant DOM lookups.
- **Cache Keys**: Derived via `getPrefixCacheKey` from the parsed prefix metadata. For elements like blockquotes (`>`) or checkboxes (`[ ]`), the key includes selection state to account for Joplin’s "markup visibility" (where markers may hide/show based on cursor proximity).
- **`measurementSignature`**: Tracks `defaultCharacterWidth`, `defaultLineHeight`, and `scaleX/Y`. If these change (e.g., zoom or font swap), the cache is purged and re-measurement is scheduled.

### 6. Reactivity

The plugin updates on:

- `docChanged`: New content or prefix changes.
- `geometryChanged` / `viewportChanged`: Changes in window size or scrolling.
- `selectionSet`: Required for visibility-sensitive prefixes that change width when selected.
- `focusChanged`: Rebuilds decorations when editor focus state changes.
- `measurementsChanged` (internal `StateEffect`): Applies newly measured widths without waiting for unrelated editor updates.
