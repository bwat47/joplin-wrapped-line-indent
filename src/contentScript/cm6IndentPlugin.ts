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

const measurementsChanged = StateEffect.define<void>();

interface CodeMirrorWrapper {
    cm6?: EditorView;
    addExtension(extension: unknown): void;
}

interface PrefixMatch {
    prefix: string;
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

/**
 * Prefix patterns:
 * - `   text`
 * - `  - item`, `  * [x] task`, `  12. item`, `  12) item`
 * - `> quote`, `> > nested quote`, including indentation before `>`
 * - `> - item`, `> > 1. nested item`, including the list marker after the quote prefix
 */
export function getIndentPrefix(lineText: string): PrefixMatch | null {
    const blockquoteMatch = /^([ \t]*(?:>[ \t]*)+)/.exec(lineText);
    if (blockquoteMatch?.[1]) {
        const listMatch = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/.exec(
            lineText.slice(blockquoteMatch[1].length)
        );
        if (listMatch?.[1]) {
            return { prefix: blockquoteMatch[1] + listMatch[1] };
        }

        return { prefix: blockquoteMatch[1] };
    }

    const listMatch = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/.exec(lineText);
    if (listMatch?.[1]) {
        return { prefix: listMatch[1] };
    }

    const whitespaceMatch = /^([ \t]+)/.exec(lineText);
    if (whitespaceMatch?.[1]) {
        return { prefix: whitespaceMatch[1] };
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

function isInBlockCodeSyntax(state: EditorState, from: number, to: number): boolean {
    const tree = syntaxTree(state);
    let position = from;

    while (position <= to) {
        let node: SyntaxNode | null = tree.resolveInner(position, 1);
        while (node) {
            if (isBlockCodeNode(node.name)) {
                return true;
            }

            node = node.parent;
        }

        if (position === to) {
            break;
        }

        position = to;
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
    return prefix.includes('>');
}

function hasSelectionOnLine(state: EditorState, line: Line): boolean {
    return state.selection.ranges.some((range) => range.from <= line.to && range.to >= line.from);
}

function getPrefixCacheKey(prefix: string, line: Line, state: EditorState): string {
    if (!isMarkupVisibilitySensitivePrefix(prefix)) {
        return prefix;
    }

    const selectionState = hasSelectionOnLine(state, line) ? 'selected' : 'unselected';
    return `${selectionState}:${prefix}`;
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

    private linePaddingLeft = 0;

    private linePaddingMeasurementNeeded = true;

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
            this.linePaddingMeasurementNeeded = true;
        }

        if (
            measurementsNeedRefresh ||
            update.docChanged ||
            update.selectionSet ||
            update.focusChanged ||
            update.viewportChanged ||
            update.geometryChanged ||
            update.transactions.some((transaction) =>
                transaction.effects.some((effect) => effect.is(measurementsChanged))
            )
        ) {
            if (update.geometryChanged) {
                this.linePaddingMeasurementNeeded = true;
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
        const match = getIndentPrefix(line.text);
        if (!match) {
            return;
        }

        const prefixTo = line.from + match.prefix.length;
        if (
            intersectsFoldedRange(this.view.state, line.from, prefixTo) ||
            isInBlockCodeSyntax(this.view.state, line.from, prefixTo)
        ) {
            return;
        }

        const cacheKey = getPrefixCacheKey(match.prefix, line, this.view.state);
        const cachedWidth = this.cachedPrefixWidths.get(cacheKey);
        if (cachedWidth === undefined) {
            this.pendingMeasurements.set(cacheKey, { from: line.from, to: prefixTo });
        }

        if (cachedWidth !== undefined && cachedWidth > 0) {
            builder.add(line.from, line.from, createLineDecoration(cachedWidth, this.linePaddingLeft));
        }

        addTabReplacementDecorations(builder, line, match.prefix, this.view);
    }

    private scheduleMeasure(): void {
        if (this.destroyed) {
            return;
        }

        if (this.measureScheduled || (this.pendingMeasurements.size === 0 && !this.linePaddingMeasurementNeeded)) {
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

                return this.measurePrefixes(view, targets, measuredDoc, measuredSelection, this.linePaddingLeft);
            },
            write: (result) => {
                if (this.destroyed) {
                    return;
                }

                this.measureScheduled = false;

                if (result.isStale) {
                    this.measurementRetries = 0;
                    this.linePaddingMeasurementNeeded = true;
                    this.scheduleMeasure();
                    return;
                }

                let changed = false;
                if (this.linePaddingLeft !== result.linePaddingLeft) {
                    this.linePaddingLeft = result.linePaddingLeft;
                    changed = true;
                }

                this.linePaddingMeasurementNeeded = false;

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
            linePaddingLeft: this.linePaddingLeft,
            isStale: false,
            needsRetry: false,
            widths: new Map<string, number>(),
        };
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

export default () => {
    return {
        plugin: (codeMirrorWrapper: CodeMirrorWrapper) => {
            if (!codeMirrorWrapper.cm6) {
                return;
            }

            codeMirrorWrapper.addExtension(wrappedLineIndentExtension);
        },
    };
};
