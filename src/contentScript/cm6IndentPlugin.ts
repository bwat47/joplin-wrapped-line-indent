import { foldedRanges, syntaxTree } from '@codemirror/language';
import {
    RangeSetBuilder,
    StateEffect,
    countColumn,
    type EditorSelection,
    type EditorState,
    type Line,
    type Text,
} from '@codemirror/state';
import {
    Decoration,
    type DecorationSet,
    EditorView,
    type PluginValue,
    ViewPlugin,
    type ViewUpdate,
    WidgetType,
} from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

const MAX_MEASUREMENT_RETRIES = 20;
const WRAPPED_LINE_CLASS = 'cm-wrapped-line-indent';
const TASK_LIST_CHECKBOX_SUFFIX = /\[[ xX]\][ \t]+$/;
const LEGACY_TASK_MARKER_SELECTOR = '.cm-ext-checkbox-toggle.cm-taskMarker';
const LIST_PREFIX_PATTERN = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/;

const measurementsChanged = StateEffect.define<void>();

interface CodeMirrorWrapper {
    cm6?: EditorView;
    addExtension(extension: unknown): void;
}

interface MeasurementTarget {
    from: number;
    to: number;
}

interface MeasureReadResult {
    linePaddingLeft: number;
    isStale: boolean;
    needsRetry: boolean;
    widths: Map<string, number>;
}

type LinePaddingMeasurementStatus = 'unknown' | 'stale' | 'measured';

interface LinePaddingMeasurement {
    status: LinePaddingMeasurementStatus;
    value: number;
}

class TabWidget extends WidgetType {
    public constructor(private readonly width: number) {
        super();
    }

    public eq(other: WidgetType): boolean {
        return other instanceof TabWidget && other.width === this.width;
    }

    public toDOM(): HTMLElement {
        const element = document.createElement('span');
        element.textContent = '\t';
        element.className = 'cm-tab';
        element.style.width = `${this.width}px`;
        return element;
    }

    public ignoreEvent(): boolean {
        return false;
    }
}

export function getTabReplacementWidth(textBeforeTab: string, tabSize: number, characterWidth: number): number {
    const column = countColumn(textBeforeTab, tabSize);
    return (tabSize - (column % tabSize)) * characterWidth;
}

function getListPrefix(lineText: string): string | null {
    return LIST_PREFIX_PATTERN.exec(lineText)?.[1] ?? null;
}

/**
 * Prefix patterns:
 * - `   text`
 * - `  - item`, `  * [x] task`, `  12. item`, `  12) item`
 * - `> quote`, `> > nested quote`, including indentation before `>`
 * - `> - item`, `> > 1. nested item`, including the list marker after the quote prefix
 */
export function getIndentPrefix(lineText: string): string | null {
    const blockquoteMatch = /^([ \t]*(?:>[ \t]*)+)/.exec(lineText);
    if (blockquoteMatch?.[1]) {
        const listPrefix = getListPrefix(lineText.slice(blockquoteMatch[1].length));
        if (listPrefix) {
            return blockquoteMatch[1] + listPrefix;
        }

        return blockquoteMatch[1];
    }

    const listPrefix = getListPrefix(lineText);
    if (listPrefix) {
        return listPrefix;
    }

    const whitespaceMatch = /^([ \t]+)/.exec(lineText);
    if (whitespaceMatch?.[1]) {
        return whitespaceMatch[1];
    }

    return null;
}

function intersectsFoldedRange(state: EditorState, from: number, to: number): boolean {
    let intersects = false;
    foldedRanges(state).between(from, to, (foldFrom, foldTo) => {
        if (foldFrom < to && foldTo > from) {
            intersects = true;
            return false;
        }

        return undefined;
    });

    return intersects;
}

export function isBlockCodeNode(nodeName: string): boolean {
    return /^(?:CodeBlock|FencedCode|CodeInfo)$/i.test(nodeName);
}

export function isHorizontalRuleNode(nodeName: string): boolean {
    return /^HorizontalRule$/i.test(nodeName);
}

function isIndentExcludedNode(nodeName: string): boolean {
    return isBlockCodeNode(nodeName) || isHorizontalRuleNode(nodeName);
}

function isInIndentExcludedSyntax(state: EditorState, from: number, to: number): boolean {
    const tree = syntaxTree(state);

    for (const position of from === to ? [from] : [from, to]) {
        let node: SyntaxNode | null = tree.resolveInner(position, 1);
        while (node) {
            if (isIndentExcludedNode(node.name)) {
                return true;
            }

            node = node.parent;
        }
    }

    return false;
}

function addTabReplacementDecorations(
    builder: RangeSetBuilder<Decoration>,
    line: Line,
    prefix: string,
    view: EditorView
): void {
    const characterWidth = view.defaultCharacterWidth / view.scaleX;

    for (let index = 0; index < prefix.length; index++) {
        if (prefix[index] === '\t') {
            const width = getTabReplacementWidth(prefix.slice(0, index), view.state.tabSize, characterWidth);
            builder.add(line.from + index, line.from + index + 1, Decoration.replace({ widget: new TabWidget(width) }));
        }
    }
}

function estimatePrefixWidth(prefix: string, view: EditorView): number {
    const characterWidth = view.defaultCharacterWidth / view.scaleX;
    let width = 0;

    for (let index = 0; index < prefix.length; index++) {
        width +=
            prefix[index] === '\t'
                ? getTabReplacementWidth(prefix.slice(0, index), view.state.tabSize, characterWidth)
                : characterWidth;
    }

    return width;
}

export function getLineDecorationStyle(width: number, linePaddingLeft: number): string {
    const paddingLeft = width + linePaddingLeft;

    return `padding-left: ${paddingLeft}px; text-indent: -${width}px;`;
}

function getLinePaddingLeft(view: EditorView, fallbackPaddingLeft: number): number {
    const lineElement = view.contentDOM.querySelector<HTMLElement>(`.cm-line:not(.${WRAPPED_LINE_CLASS})`);
    if (!lineElement) {
        return fallbackPaddingLeft;
    }

    const paddingLeft = Number.parseFloat(getComputedStyle(lineElement).paddingLeft);
    return Number.isFinite(paddingLeft) ? paddingLeft : fallbackPaddingLeft;
}

function createLineDecoration(width: number, linePaddingLeft: number): Decoration {
    return Decoration.line({
        attributes: {
            class: WRAPPED_LINE_CLASS,
            style: getLineDecorationStyle(width, linePaddingLeft),
        },
    });
}

function isMarkupVisibilitySensitivePrefix(prefix: string): boolean {
    return prefix.includes('>') || TASK_LIST_CHECKBOX_SUFFIX.test(prefix);
}

function hasSelectionInRange(state: EditorState, from: number, to: number): boolean {
    return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

function getPrefixCacheKey(prefix: string, line: Line, state: EditorState): string {
    if (!isMarkupVisibilitySensitivePrefix(prefix)) {
        return prefix;
    }

    const states: string[] = [];
    if (prefix.includes('>')) {
        states.push(`quote:${hasSelectionInRange(state, line.from, line.to) ? 'selected' : 'unselected'}`);
    }

    if (TASK_LIST_CHECKBOX_SUFFIX.test(prefix)) {
        const prefixTo = line.from + prefix.length;
        states.push(`task:${hasSelectionInRange(state, line.from, prefixTo) ? 'selected' : 'unselected'}`);
    }

    return `${states.join(':')}:${prefix}`;
}

function getMeasurementSignature(view: EditorView): string {
    return [view.defaultCharacterWidth, view.defaultLineHeight, view.scaleX, view.scaleY].join(':');
}

class WrappedLineIndentPlugin implements PluginValue {
    public decorations: DecorationSet = Decoration.none;

    private destroyed = false;

    private readonly cachedPrefixWidths = new Map<string, number>();

    private readonly pendingMeasurements = new Map<string, MeasurementTarget>();

    private measureScheduled = false;

    private measurementSignature: string;

    private measurementRetries = 0;

    private refreshFrame: number | null = null;

    private linePadding: LinePaddingMeasurement = { status: 'unknown', value: 0 };

    public constructor(private readonly view: EditorView) {
        this.measurementSignature = getMeasurementSignature(view);
        this.decorations = this.buildDecorations();
        this.scheduleMeasure();
    }

    public update(update: ViewUpdate): void {
        const nextMeasurementSignature = getMeasurementSignature(this.view);
        const measurementsNeedRefresh = nextMeasurementSignature !== this.measurementSignature;
        if (measurementsNeedRefresh) {
            this.measurementSignature = nextMeasurementSignature;
            this.cachedPrefixWidths.clear();
            this.markLinePaddingStale();
        }

        const receivedMeasurementUpdate = update.transactions.some((transaction) =>
            transaction.effects.some((effect) => effect.is(measurementsChanged))
        );
        const editorContentOrStateChanged = update.docChanged || update.selectionSet || update.focusChanged;
        const viewportOrGeometryChanged = update.viewportChanged || update.geometryChanged;
        const shouldRebuildDecorations =
            measurementsNeedRefresh ||
            editorContentOrStateChanged ||
            viewportOrGeometryChanged ||
            receivedMeasurementUpdate;

        if (shouldRebuildDecorations) {
            if (update.geometryChanged) {
                this.markLinePaddingStale();
            }

            this.decorations = this.buildDecorations();
            this.scheduleMeasure();
        }
    }

    public destroy(): void {
        this.destroyed = true;
        this.measureScheduled = false;

        if (this.refreshFrame !== null) {
            cancelAnimationFrame(this.refreshFrame);
            this.refreshFrame = null;
        }

        this.pendingMeasurements.clear();
        this.cachedPrefixWidths.clear();
    }

    private buildDecorations(): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const state = this.view.state;

        this.pendingMeasurements.clear();

        for (const range of this.view.visibleRanges) {
            let position = range.from;

            while (position <= range.to) {
                const line = state.doc.lineAt(position);
                this.addDecorationsForLine(builder, line);

                if (line.to >= range.to) {
                    break;
                }

                position = line.to + 1;
            }
        }

        return builder.finish();
    }

    private addDecorationsForLine(builder: RangeSetBuilder<Decoration>, line: Line): void {
        const prefix = getIndentPrefix(line.text);
        if (!prefix) {
            return;
        }

        const prefixTo = line.from + prefix.length;
        if (
            intersectsFoldedRange(this.view.state, line.from, prefixTo) ||
            isInIndentExcludedSyntax(this.view.state, line.from, prefixTo)
        ) {
            return;
        }

        const cacheKey = getPrefixCacheKey(prefix, line, this.view.state);
        const cachedWidth = this.cachedPrefixWidths.get(cacheKey);
        if (cachedWidth === undefined) {
            this.pendingMeasurements.set(cacheKey, { from: line.from, to: prefixTo });
        }

        let decorationWidth = cachedWidth ?? this.getCachedWidthForPrefix(prefix);
        if (decorationWidth === undefined && this.canUseEstimatedPrefixWidth()) {
            decorationWidth = estimatePrefixWidth(prefix, this.view);
        }

        if (decorationWidth !== undefined && decorationWidth > 0) {
            builder.add(line.from, line.from, createLineDecoration(decorationWidth, this.linePadding.value));
        }

        addTabReplacementDecorations(builder, line, prefix, this.view);
    }

    private getCachedWidthForPrefix(prefix: string): number | undefined {
        const keySuffix = `:${prefix}`;
        for (const [cacheKey, width] of this.cachedPrefixWidths) {
            if (cacheKey === prefix || cacheKey.endsWith(keySuffix)) {
                return width;
            }
        }

        return undefined;
    }

    private scheduleMeasure(): void {
        if (this.destroyed) {
            return;
        }

        if (this.measureScheduled || (this.pendingMeasurements.size === 0 && !this.needsLinePaddingMeasurement())) {
            return;
        }

        this.measureScheduled = true;
        const targets = new Map(this.pendingMeasurements);
        const measuredDoc = this.view.state.doc;
        const measuredSelection = this.view.state.selection;

        this.view.requestMeasure<MeasureReadResult>({
            read: (view) => {
                if (this.destroyed) {
                    return this.createEmptyMeasureResult();
                }

                return this.measurePrefixes(view, targets, measuredDoc, measuredSelection, this.linePadding.value);
            },
            write: (result) => {
                if (this.destroyed) {
                    return;
                }

                this.measureScheduled = false;

                if (result.isStale) {
                    this.measurementRetries = 0;
                    this.markLinePaddingStale();
                    this.scheduleMeasure();
                    return;
                }

                let changed = false;
                if (this.linePadding.value !== result.linePaddingLeft) {
                    changed = true;
                }
                this.linePadding = { status: 'measured', value: result.linePaddingLeft };

                for (const [prefix, width] of result.widths) {
                    if (this.cachedPrefixWidths.get(prefix) !== width) {
                        this.cachedPrefixWidths.set(prefix, width);
                        changed = true;
                    }
                }

                if (changed) {
                    this.measurementRetries = 0;
                    this.scheduleDecorationsRefresh();
                    return;
                }

                if (result.needsRetry && this.measurementRetries < MAX_MEASUREMENT_RETRIES) {
                    this.measurementRetries++;
                    this.scheduleMeasure();
                    return;
                }

                this.measurementRetries = 0;
            },
        });
    }

    private scheduleDecorationsRefresh(): void {
        if (this.destroyed) {
            return;
        }

        if (this.refreshFrame !== null) {
            return;
        }

        this.refreshFrame = requestAnimationFrame(() => {
            this.refreshFrame = null;
            if (this.destroyed) {
                return;
            }

            this.view.dispatch({ effects: measurementsChanged.of() });
        });
    }

    private createEmptyMeasureResult(): MeasureReadResult {
        return {
            linePaddingLeft: this.linePadding.value,
            isStale: false,
            needsRetry: false,
            widths: new Map<string, number>(),
        };
    }

    private markLinePaddingStale(): void {
        if (this.linePadding.status === 'unknown') {
            return;
        }

        this.linePadding = { status: 'stale', value: this.linePadding.value };
    }

    private needsLinePaddingMeasurement(): boolean {
        return this.linePadding.status !== 'measured';
    }

    private canUseEstimatedPrefixWidth(): boolean {
        return this.linePadding.status !== 'unknown';
    }

    private measurePrefixes(
        view: EditorView,
        targets: Map<string, MeasurementTarget>,
        measuredDoc: Text,
        measuredSelection: EditorSelection,
        fallbackPaddingLeft: number
    ): MeasureReadResult {
        const measuredWidths = new Map<string, number>();
        const linePaddingLeft = getLinePaddingLeft(view, fallbackPaddingLeft);
        if (view.state.doc !== measuredDoc || view.state.selection !== measuredSelection) {
            return { linePaddingLeft, isStale: true, needsRetry: false, widths: measuredWidths };
        }

        let needsRetry = false;
        for (const [cacheKey, target] of targets) {
            const startCoords = view.coordsAtPos(target.from, 1);
            const endCoords = view.coordsAtPos(target.to, -1);

            if (!startCoords || !endCoords) {
                needsRetry = true;
                continue;
            }

            const width = endCoords.left - startCoords.left;
            if (width <= 0) {
                needsRetry = true;
                continue;
            }

            measuredWidths.set(cacheKey, width);
        }

        return { linePaddingLeft, isStale: false, needsRetry, widths: measuredWidths };
    }
}

export const wrappedLineIndentExtension = ViewPlugin.fromClass(WrappedLineIndentPlugin, {
    decorations: (plugin) => plugin.decorations,
});

export const legacyTaskListCheckboxTheme = EditorView.theme({
    [`& ${LEGACY_TASK_MARKER_SELECTOR}`]: {
        alignItems: 'center',
        display: 'inline-flex',
        position: 'static',
        verticalAlign: 'middle',

        '& > .sizing': {
            display: 'none',
        },

        '& > .content': {
            bottom: 'auto',
            display: 'inline-flex',
            left: 'auto',
            position: 'static',
            right: 'auto',
            textAlign: 'initial',
            top: 'auto',
        },

        '& > .content > input.cm-ext-checkbox': {
            height: '1.1em',
            margin: '4px',
            minHeight: '0',
            verticalAlign: 'middle',
            width: '1.1em',
        },
    },
});

export default () => {
    return {
        plugin: (codeMirrorWrapper: CodeMirrorWrapper) => {
            if (!codeMirrorWrapper.cm6) {
                return;
            }

            codeMirrorWrapper.addExtension([legacyTaskListCheckboxTheme, wrappedLineIndentExtension]);
        },
    };
};
