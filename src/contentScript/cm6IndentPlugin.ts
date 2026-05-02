import { foldedRanges, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
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

const WRAPPED_LINE_CLASS = 'cm-wrapped-line-indent';
const TASK_LIST_CHECKBOX_PATTERN = /\[[ xX]\]/;
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

export type IndentPrefixKind = 'indent' | 'list' | 'quote' | 'quote-list';

export interface ParsedIndentPrefix {
    kind: IndentPrefixKind;
    text: string;
    quoteDepth: number;
    checkboxOffset: number | null;
    visibilitySensitive: boolean;
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

interface ParsedListPrefix {
    text: string;
    checkboxOffset: number | null;
}

function parseListPrefix(lineText: string): ParsedListPrefix | null {
    const text = LIST_PREFIX_PATTERN.exec(lineText)?.[1];
    if (!text) {
        return null;
    }

    const checkboxIndex = text.search(TASK_LIST_CHECKBOX_PATTERN);
    return {
        text,
        checkboxOffset: checkboxIndex >= 0 ? checkboxIndex : null,
    };
}

function getQuoteDepth(prefixText: string): number {
    return [...prefixText].filter((character) => character === '>').length;
}

/**
 * Prefix patterns:
 * - `   text`
 * - `  - item`, `  * [x] task`, `  12. item`, `  12) item`
 * - `> quote`, `> > nested quote`, including indentation before `>`
 * - `> - item`, `> > 1. nested item`, including the list marker after the quote prefix
 */
export function parseIndentPrefix(lineText: string): ParsedIndentPrefix | null {
    const blockquoteMatch = /^([ \t]*(?:>[ \t]*)+)/.exec(lineText);
    if (blockquoteMatch?.[1]) {
        const quotePrefix = blockquoteMatch[1];
        const listPrefix = parseListPrefix(lineText.slice(quotePrefix.length));
        if (listPrefix) {
            return {
                kind: 'quote-list',
                text: quotePrefix + listPrefix.text,
                quoteDepth: getQuoteDepth(quotePrefix),
                checkboxOffset:
                    listPrefix.checkboxOffset === null ? null : quotePrefix.length + listPrefix.checkboxOffset,
                visibilitySensitive: true,
            };
        }

        return {
            kind: 'quote',
            text: quotePrefix,
            quoteDepth: getQuoteDepth(quotePrefix),
            checkboxOffset: null,
            visibilitySensitive: true,
        };
    }

    const listPrefix = parseListPrefix(lineText);
    if (listPrefix) {
        return {
            kind: 'list',
            text: listPrefix.text,
            quoteDepth: 0,
            checkboxOffset: listPrefix.checkboxOffset,
            visibilitySensitive: listPrefix.checkboxOffset !== null,
        };
    }

    const whitespaceMatch = /^([ \t]+)/.exec(lineText);
    if (whitespaceMatch?.[1]) {
        return {
            kind: 'indent',
            text: whitespaceMatch[1],
            quoteDepth: 0,
            checkboxOffset: null,
            visibilitySensitive: false,
        };
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
    if (!syntaxTreeAvailable(state, to)) {
        return false;
    }

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

function hasSelectionInRange(state: EditorState, from: number, to: number): boolean {
    return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

function getTaskListCheckboxRange(prefix: ParsedIndentPrefix, line: Line): MeasurementTarget | null {
    if (prefix.checkboxOffset === null) {
        return null;
    }

    return {
        from: line.from + prefix.checkboxOffset,
        to: line.from + prefix.checkboxOffset + '[ ]'.length,
    };
}

function getPrefixCacheKey(prefix: ParsedIndentPrefix, line: Line, state: EditorState): string {
    if (!prefix.visibilitySensitive) {
        return prefix.text;
    }

    const states: string[] = [];
    if (prefix.quoteDepth > 0) {
        states.push(`quote:${hasSelectionInRange(state, line.from, line.to) ? 'selected' : 'unselected'}`);
    }

    if (prefix.checkboxOffset !== null) {
        const checkboxRange = getTaskListCheckboxRange(prefix, line);
        const checkboxVisibilityState =
            checkboxRange && hasSelectionInRange(state, checkboxRange.from, checkboxRange.to) ? 'revealed' : 'rendered';
        states.push(`task:${checkboxVisibilityState}`);
    }

    return `${states.join(':')}:${prefix.text}`;
}

function getMeasurementSignature(view: EditorView): string {
    return [view.defaultCharacterWidth, view.defaultLineHeight, view.scaleX, view.scaleY, view.state.tabSize].join(':');
}

class WrappedLineIndentPlugin implements PluginValue {
    public decorations: DecorationSet = Decoration.none;

    private destroyed = false;

    private readonly cachedPrefixWidths = new Map<string, number>();

    private readonly pendingMeasurements = new Map<string, MeasurementTarget[]>();

    private measureScheduled = false;

    private measurementSignature: string;

    private incompleteMeasurementRefreshSpent = false;

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
        const externalRefreshTrigger =
            measurementsNeedRefresh || editorContentOrStateChanged || viewportOrGeometryChanged;
        const syntaxTreeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
        const shouldRebuildDecorations = externalRefreshTrigger || receivedMeasurementUpdate || syntaxTreeChanged;

        if (externalRefreshTrigger) {
            this.incompleteMeasurementRefreshSpent = false;
        }

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
        const prefix = parseIndentPrefix(line.text);
        if (!prefix) {
            return;
        }

        const prefixTo = line.from + prefix.text.length;
        if (
            intersectsFoldedRange(this.view.state, line.from, prefixTo) ||
            isInIndentExcludedSyntax(this.view.state, line.from, prefixTo)
        ) {
            return;
        }

        const cacheKey = getPrefixCacheKey(prefix, line, this.view.state);
        const cachedWidth = this.cachedPrefixWidths.get(cacheKey);
        if (cachedWidth === undefined) {
            const targets = this.pendingMeasurements.get(cacheKey);
            if (targets) {
                targets.push({ from: line.from, to: prefixTo });
            } else {
                this.pendingMeasurements.set(cacheKey, [{ from: line.from, to: prefixTo }]);
            }
        }

        let decorationWidth = cachedWidth ?? this.getCachedWidthForPrefix(prefix.text);
        if (decorationWidth === undefined && this.canUseEstimatedPrefixWidth()) {
            decorationWidth = estimatePrefixWidth(prefix.text, this.view);
        }

        if (decorationWidth !== undefined && decorationWidth > 0) {
            builder.add(line.from, line.from, createLineDecoration(decorationWidth, this.linePadding.value));
        }

        addTabReplacementDecorations(builder, line, prefix.text, this.view);
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
        const targets = new Map(
            [...this.pendingMeasurements].map(([cacheKey, targetList]) => [cacheKey, [...targetList]])
        );
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

                const shouldRefreshForIncompleteMeasurement =
                    result.needsRetry && !this.incompleteMeasurementRefreshSpent;
                if (shouldRefreshForIncompleteMeasurement) {
                    this.incompleteMeasurementRefreshSpent = true;
                }

                if (changed || shouldRefreshForIncompleteMeasurement) {
                    this.scheduleDecorationsRefresh();
                }
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
        targets: Map<string, MeasurementTarget[]>,
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
        for (const [cacheKey, targetList] of targets) {
            let measuredWidth: number | null = null;

            for (const target of targetList) {
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

                measuredWidth = measuredWidth === null ? width : Math.min(measuredWidth, width);
            }

            if (measuredWidth === null) {
                continue;
            }

            measuredWidths.set(cacheKey, measuredWidth);
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
