import { syntaxTree } from '@codemirror/language';
import type { Extension, Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';

/**
 * Layout-affecting subset of Joplin's Markdown editor styling, for browser tests.
 *
 * Mirrors Joplin 3.7.21:
 * - packages/editor/CodeMirror/theme.ts (fonts, line height, line padding, block quotes)
 * - packages/editor/CodeMirror/extensions/markdownDecorationExtension.ts (line and mark classes)
 *
 * Colors, headings, and other rules that do not move text horizontally are omitted.
 * Re-sync when Joplin changes these files.
 */

/** Joplin's `.cm-line` left padding when no gutters are present. */
export const JOPLIN_LINE_PADDING = 1;

/** CodeMirror's default `.cm-line` left padding, which applies when Joplin's rule does not. */
export const CODEMIRROR_LINE_PADDING = 6;

/** Joplin's `.cm-blockQuote` left padding, which applies when a gutter disables the 1px rule. */
export const JOPLIN_BLOCK_QUOTE_PADDING = 4;

const BLOCK_CODE_NODES = new Set(['FencedCode', 'CodeBlock']);
const blockQuoteLine = Decoration.line({ attributes: { class: 'cm-blockQuote' } });
const codeBlockLine = Decoration.line({ attributes: { class: 'cm-codeBlock' } });
const taskMarker = Decoration.mark({ attributes: { class: 'cm-taskMarker' } });

interface JoplinStylingOptions {
    fontFamily: string;
    monospaceFont: string;
}

function lineDecorations(view: EditorView, from: number, to: number, decoration: Decoration): Range<Decoration>[] {
    const ranges: Range<Decoration>[] = [];
    for (let position = from; position <= to; ) {
        const line = view.state.doc.lineAt(position);
        ranges.push(decoration.range(line.from));
        position = line.to + 1;
    }
    return ranges;
}

function buildDecorations(view: EditorView): DecorationSet {
    const ranges: Range<Decoration>[] = [];
    for (const { from, to } of view.visibleRanges) {
        syntaxTree(view.state).iterate({
            from,
            to,
            enter: (node) => {
                if (node.name === 'Blockquote') {
                    ranges.push(...lineDecorations(view, node.from, node.to, blockQuoteLine));
                } else if (BLOCK_CODE_NODES.has(node.name)) {
                    ranges.push(...lineDecorations(view, node.from, node.to, codeBlockLine));
                } else if (node.name === 'TaskMarker') {
                    ranges.push(taskMarker.range(node.from, node.to));
                }
            },
        });
    }
    return Decoration.set(ranges, true);
}

const joplinDecorations = ViewPlugin.fromClass(
    class {
        public decorations: DecorationSet;

        public constructor(view: EditorView) {
            this.decorations = buildDecorations(view);
        }

        public update(update: ViewUpdate): void {
            if (
                update.docChanged ||
                update.viewportChanged ||
                syntaxTree(update.startState) !== syntaxTree(update.state)
            ) {
                this.decorations = buildDecorations(update.view);
            }
        }
    },
    { decorations: (plugin) => plugin.decorations }
);

export function joplinEditorStyling({ fontFamily, monospaceFont }: JoplinStylingOptions): Extension {
    return [
        EditorView.theme({
            '& .cm-content': {
                fontFamily,
                fontSize: '16px',
                lineHeight: '1.55',
            },
            // The desktop app forces a font on these elements; Joplin resets them to inherit.
            '& div, & span, & a': {
                fontFamily: 'inherit',
            },
            '& .cm-blockQuote': {
                borderLeft: '4px solid gray',
                paddingLeft: `${JOPLIN_BLOCK_QUOTE_PADDING}px`,
            },
            '& .cm-codeBlock': { fontFamily: monospaceFont },
            '& .cm-taskMarker': { fontFamily: monospaceFont },
            '&:not(:has(> .cm-scroller > .cm-gutters)) .cm-line': {
                paddingLeft: `${JOPLIN_LINE_PADDING}px`,
            },
        }),
        joplinDecorations,
    ];
}
