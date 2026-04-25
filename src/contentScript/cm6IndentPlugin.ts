import { foldedRanges, syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, StateEffect, countColumn, type EditorState, type Line, type Text } from '@codemirror/state';
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

const BASE_PADDING = 6;
const MAX_MEASUREMENT_RETRIES = 20;

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

function isCodeLikeNode(nodeName: string): boolean {
    return /^(?:InlineCode|CodeText|CodeBlock|FencedCode|CodeMark|CodeInfo|Code)$/i.test(nodeName);
}

function isInCodeLikeSyntax(state: EditorState, from: number, to: number): boolean {
    const tree = syntaxTree(state);
    let position = from;

    while (position <= to) {
        let node: SyntaxNode | null = tree.resolveInner(position, 1);
        while (node) {
            if (isCodeLikeNode(node.name)) {
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

function createLineDecoration(width: number): Decoration {
    const paddingLeft = width + BASE_PADDING;

    return Decoration.line({
        attributes: {
            style: `padding-left: ${paddingLeft}px; text-indent: -${width}px;`,
        },
    });
}

function getMeasurementSignature(view: EditorView): string {
    return [view.defaultCharacterWidth, view.defaultLineHeight, view.scaleX, view.scaleY].join(':');
}

class WrappedLineIndentPlugin implements PluginValue {
    public decorations: DecorationSet = Decoration.none;

    private readonly cachedPrefixWidths = new Map<string, number>();

    private readonly pendingMeasurements = new Map<string, MeasurementTarget>();

    private measureScheduled = false;

    private measurementSignature: string;

    private measurementRetries = 0;

    private refreshFrame: number | null = null;

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
        }

        if (
            measurementsNeedRefresh ||
            update.docChanged ||
            update.viewportChanged ||
            update.geometryChanged ||
            update.transactions.some((transaction) =>
                transaction.effects.some((effect) => effect.is(measurementsChanged))
            )
        ) {
            this.decorations = this.buildDecorations();
            this.scheduleMeasure();
        }
    }

    public destroy(): void {
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
            isInCodeLikeSyntax(this.view.state, line.from, prefixTo)
        ) {
            return;
        }

        const cachedWidth = this.cachedPrefixWidths.get(match.prefix);
        if (cachedWidth === undefined) {
            this.pendingMeasurements.set(match.prefix, { from: line.from, to: prefixTo });
        } else if (cachedWidth > 0) {
            builder.add(line.from, line.from, createLineDecoration(cachedWidth));
        }

        addTabReplacementDecorations(builder, line, match.prefix, this.view);
    }

    private scheduleMeasure(): void {
        if (this.measureScheduled || this.pendingMeasurements.size === 0) {
            return;
        }

        this.measureScheduled = true;
        const targets = new Map(this.pendingMeasurements);
        const measuredDoc = this.view.state.doc;

        this.view.requestMeasure<MeasureReadResult>({
            read: (view) => this.measurePrefixes(view, targets, measuredDoc),
            write: (result) => {
                this.measureScheduled = false;

                if (result.isStale) {
                    this.measurementRetries = 0;
                    this.scheduleMeasure();
                    return;
                }

                let changed = false;
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
        if (this.refreshFrame !== null) {
            return;
        }

        this.refreshFrame = requestAnimationFrame(() => {
            this.refreshFrame = null;
            this.view.dispatch({ effects: measurementsChanged.of() });
        });
    }

    private measurePrefixes(
        view: EditorView,
        targets: Map<string, MeasurementTarget>,
        measuredDoc: Text
    ): MeasureReadResult {
        const measuredWidths = new Map<string, number>();
        if (view.state.doc !== measuredDoc) {
            return { isStale: true, needsRetry: false, widths: measuredWidths };
        }

        let needsRetry = false;
        for (const [prefix, target] of targets) {
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

            measuredWidths.set(prefix, width);
        }

        return { isStale: false, needsRetry, widths: measuredWidths };
    }
}

const wrappedLineIndentExtension = ViewPlugin.fromClass(WrappedLineIndentPlugin, {
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
