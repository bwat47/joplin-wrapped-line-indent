import { getIndentUnit } from '@codemirror/language';
import { EditorState, Line, RangeSetBuilder } from '@codemirror/state';
import {
    Decoration,
    DecorationSet,
    EditorView,
    PluginValue,
    ViewPlugin,
    ViewUpdate,
} from '@codemirror/view';
import { CodeMirrorControl, MarkdownEditorContentScriptModule } from 'api/types';

type IndentationInfo = {
    containsTab: boolean;
    numColumns: number;
};

class WrappedLineIndent implements PluginValue {
    public decorations: DecorationSet;
    private indentUnit: number;
    private readonly initialPaddingLeft: string;
    private readonly isChrome: boolean;

    public constructor(private readonly view: EditorView) {
        this.indentUnit = getIndentUnit(view.state);
        this.initialPaddingLeft = this.measureInitialPaddingLeft();
        this.isChrome = window.navigator.userAgent.includes('Chrome');
        this.decorations = this.generate(view.state);
    }

    public update(update: ViewUpdate): void {
        const indentUnit = getIndentUnit(update.state);

        if (indentUnit !== this.indentUnit || update.docChanged || update.viewportChanged) {
            this.indentUnit = indentUnit;
            this.decorations = this.generate(update.state);
        }
    }

    private generate(state: EditorState): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();

        for (const line of this.getVisibleLines(state)) {
            const { numColumns, containsTab } = WrappedLineIndent.numColumns(line.text, state.tabSize);
            const wrappedIndent = numColumns + this.indentUnit;
            const paddingValue = `calc(${wrappedIndent}ch + ${this.initialPaddingLeft})`;
            const textIndentValue = this.isChrome
                ? `calc(-${wrappedIndent}ch - ${containsTab ? 1 : 0}px)`
                : `-${wrappedIndent}ch`;

            builder.add(
                line.from,
                line.from,
                Decoration.line({
                    attributes: {
                        style: `padding-left: ${paddingValue}; text-indent: ${textIndentValue};`,
                    },
                })
            );
        }

        return builder.finish();
    }

    private measureInitialPaddingLeft(): string {
        const lineElement = this.view.contentDOM.querySelector('.cm-line');

        if (!lineElement) {
            return '0px';
        }

        return window.getComputedStyle(lineElement).getPropertyValue('padding-left');
    }

    private getVisibleLines(state: EditorState): Set<Line> {
        const lines = new Set<Line>();
        let lastLine: Line | null = null;

        for (const { from, to } of this.view.visibleRanges) {
            let pos = from;

            while (pos <= to) {
                const line = state.doc.lineAt(pos);

                if (lastLine !== line) {
                    lines.add(line);
                    lastLine = line;
                }

                pos = line.to + 1;
            }
        }

        return lines;
    }

    private static numColumns(str: string, tabSize: number): IndentationInfo {
        let cols = 0;
        let containsTab = false;

        for (let i = 0; i < str.length; i++) {
            switch (str[i]) {
                case ' ':
                    cols += 1;
                    break;

                case '\t':
                    cols += tabSize - (cols % tabSize);
                    containsTab = true;
                    break;

                case '\r':
                    break;

                default:
                    return { containsTab, numColumns: cols };
            }
        }

        return { containsTab, numColumns: cols };
    }
}

const wrappedLineIndent = ViewPlugin.fromClass(WrappedLineIndent, {
    decorations: (plugin: WrappedLineIndent): DecorationSet => plugin.decorations,
});

export default function (): MarkdownEditorContentScriptModule {
    return {
        plugin: (editorControl: CodeMirrorControl): void => {
            editorControl.addExtension(wrappedLineIndent);
        },
    };
}
