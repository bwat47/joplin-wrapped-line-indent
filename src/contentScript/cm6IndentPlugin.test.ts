import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import {
    default as createContentScript,
    getIndentPrefix,
    getLineDecorationStyle,
    getTabReplacementWidth,
    isBlockCodeNode,
    isHorizontalRuleNode,
    legacyTaskListCheckboxTheme,
    wrappedLineIndentExtension,
} from './cm6IndentPlugin';

type MeasurableEditorView = EditorView & {
    measure(flush?: boolean): void;
};

describe('wrappedLineIndentExtension', () => {
    let frameCallbacks: Map<number, FrameRequestCallback>;
    let nextFrameId: number;
    let originalRequestAnimationFrame: typeof window.requestAnimationFrame;
    let originalCancelAnimationFrame: typeof window.cancelAnimationFrame;
    let coordsAtPosSpy: jest.SpiedFunction<EditorView['coordsAtPos']>;
    let styleElement: HTMLStyleElement;

    const flushAnimationFrames = () => {
        const callbacks = [...frameCallbacks.values()];
        frameCallbacks.clear();

        for (const callback of callbacks) {
            callback(performance.now());
        }
    };

    const flushMeasureCycle = (view: EditorView) => {
        (view as MeasurableEditorView).measure(false);
        flushAnimationFrames();
    };

    const createView = (doc: string, extensions: Extension[] = []): EditorView => {
        const parent = document.createElement('div');
        document.body.append(parent);

        const view = new EditorView({
            parent,
            state: EditorState.create({
                doc,
                extensions: [...extensions, wrappedLineIndentExtension],
            }),
        });
        for (const lineElement of view.dom.querySelectorAll<HTMLElement>('.cm-line')) {
            lineElement.style.paddingLeft = '10px';
        }

        return view;
    };

    it('registers the legacy task-list checkbox theme with the plugin', () => {
        const extensionGroups: unknown[] = [];
        createContentScript().plugin({
            cm6: {} as EditorView,
            addExtension: (extension) => {
                extensionGroups.push(extension);
            },
        });

        expect(extensionGroups).toHaveLength(1);
        expect(extensionGroups[0]).toEqual(
            expect.arrayContaining([legacyTaskListCheckboxTheme, wrappedLineIndentExtension])
        );
    });

    beforeEach(() => {
        frameCallbacks = new Map();
        nextFrameId = 1;
        originalRequestAnimationFrame = window.requestAnimationFrame;
        originalCancelAnimationFrame = window.cancelAnimationFrame;

        window.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
            const frameId = nextFrameId++;
            frameCallbacks.set(frameId, callback);
            return frameId;
        }) as typeof window.requestAnimationFrame;
        window.cancelAnimationFrame = ((frameId: number): void => {
            frameCallbacks.delete(frameId);
        }) as typeof window.cancelAnimationFrame;

        global.requestAnimationFrame = window.requestAnimationFrame;
        global.cancelAnimationFrame = window.cancelAnimationFrame;

        coordsAtPosSpy = jest.spyOn(EditorView.prototype, 'coordsAtPos').mockImplementation((position) => {
            const left = position * 8;
            return { left, right: left, top: 0, bottom: 16 };
        });

        styleElement = document.createElement('style');
        styleElement.textContent = '.cm-editor .cm-line { padding-left: 10px !important; }';
        document.head.append(styleElement);
    });

    afterEach(() => {
        coordsAtPosSpy.mockRestore();
        styleElement.remove();
        document.body.replaceChildren();
        frameCallbacks.clear();
        window.requestAnimationFrame = originalRequestAnimationFrame;
        window.cancelAnimationFrame = originalCancelAnimationFrame;
        global.requestAnimationFrame = originalRequestAnimationFrame;
        global.cancelAnimationFrame = originalCancelAnimationFrame;
    });

    it('decorates list lines using measured editor padding and prefix width', () => {
        const view = createView('- item with wrapped content');

        flushMeasureCycle(view);

        const lineElement = view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent');
        expect(lineElement?.style.paddingLeft).toBe('26px');
        expect(lineElement?.style.textIndent).toBe('-16px');

        view.destroy();
    });

    it('does not compound wrapped indent padding when all visible lines are decorated', () => {
        const view = createView('- first item\n- second item');
        flushMeasureCycle(view);

        const plugin = view.plugin(wrappedLineIndentExtension);
        (
            plugin as unknown as { requestLinePaddingMeasurement(): void; scheduleMeasure(): void }
        ).requestLinePaddingMeasurement();
        (plugin as unknown as { scheduleMeasure(): void }).scheduleMeasure();
        flushMeasureCycle(view);

        const lineElements = [...view.dom.querySelectorAll<HTMLElement>('.cm-wrapped-line-indent')];
        expect(lineElements.map((lineElement) => lineElement.style.paddingLeft)).toEqual(['26px', '26px']);

        view.destroy();
    });

    it('keeps separate widths for visible and hidden block quote markers', () => {
        const view = createView('> - active item\n> - hidden item');
        const firstLine = view.state.doc.line(1);
        const secondLine = view.state.doc.line(2);

        coordsAtPosSpy.mockImplementation((position) => {
            if (position <= firstLine.to) {
                const left = (position - firstLine.from) * 8;
                return { left, right: left, top: 0, bottom: 16 };
            }

            const left = (position - secondLine.from) * 4;
            return { left, right: left, top: 16, bottom: 32 };
        });

        flushMeasureCycle(view);

        const lineElements = [...view.dom.querySelectorAll<HTMLElement>('.cm-wrapped-line-indent')];
        expect(lineElements.map((lineElement) => lineElement.style.paddingLeft)).toEqual(['42px', '26px']);
        expect(lineElements.map((lineElement) => lineElement.style.textIndent)).toEqual(['-32px', '-16px']);

        view.destroy();
    });

    it('remeasures block quote prefixes when selection changes marker visibility state', () => {
        const view = createView('> - first quoted item\n> - second quoted item');
        coordsAtPosSpy.mockImplementation((position) => {
            const line = view.state.doc.lineAt(position);
            const hasSelectionOnLine = view.state.selection.ranges.some(
                (range) => range.from <= line.to && range.to >= line.from
            );
            const characterWidth = hasSelectionOnLine ? 8 : 4;
            const left = position <= line.from + 1 ? 0 : 4 * characterWidth;
            return { left, right: left, top: 0, bottom: 16 };
        });

        view.dispatch({ selection: { anchor: view.state.doc.line(1).from, head: view.state.doc.line(2).to } });
        flushMeasureCycle(view);
        flushMeasureCycle(view);
        expect(
            [...view.dom.querySelectorAll<HTMLElement>('.cm-wrapped-line-indent')].map((line) => line.style.paddingLeft)
        ).toEqual(['38px', '38px']);

        view.dispatch({ selection: { anchor: view.state.doc.line(2).to } });
        flushMeasureCycle(view);
        flushMeasureCycle(view);

        expect(
            [...view.dom.querySelectorAll<HTMLElement>('.cm-wrapped-line-indent')].map((line) => line.style.paddingLeft)
        ).toEqual(['22px', '38px']);

        view.destroy();
    });

    it('keeps block quote lines decorated while remeasuring a new selection state', () => {
        const view = createView('> - first quoted item');
        coordsAtPosSpy.mockImplementation((position) => {
            const line = view.state.doc.lineAt(position);
            const left = position <= line.from + 1 ? 0 : 16;
            return { left, right: left, top: 0, bottom: 16 };
        });

        flushMeasureCycle(view);
        flushMeasureCycle(view);
        expect(view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent')?.style.paddingLeft).toBe('26px');

        view.dispatch({ selection: { anchor: view.state.doc.line(1).to } });

        expect(view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent')?.style.paddingLeft).toBe('26px');

        flushMeasureCycle(view);
        flushMeasureCycle(view);
        expect(view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent')?.style.paddingLeft).toBe('26px');

        view.destroy();
    });

    it('remeasures task list prefixes when selection changes checkbox visibility state', () => {
        const view = createView('- [ ] first task\n- [ ] second task');
        coordsAtPosSpy.mockImplementation((position) => {
            const line = view.state.doc.lineAt(position);
            const prefixTo = line.from + '- [ ] '.length;
            const hasSelectionInPrefix = view.state.selection.ranges.some(
                (range) => range.from <= prefixTo && range.to >= line.from
            );
            const prefixWidth = hasSelectionInPrefix ? 48 : 24;
            const left = position <= line.from + 1 ? 0 : prefixWidth;
            return { left, right: left, top: 0, bottom: 16 };
        });

        view.dispatch({ selection: { anchor: view.state.doc.line(1).from, head: view.state.doc.line(2).to } });
        flushMeasureCycle(view);
        flushMeasureCycle(view);
        expect(
            [...view.dom.querySelectorAll<HTMLElement>('.cm-wrapped-line-indent')].map((line) => line.style.paddingLeft)
        ).toEqual(['54px', '54px']);

        view.dispatch({ selection: { anchor: view.state.doc.line(2).to } });
        flushMeasureCycle(view);
        flushMeasureCycle(view);

        expect(
            [...view.dom.querySelectorAll<HTMLElement>('.cm-wrapped-line-indent')].map((line) => line.style.paddingLeft)
        ).toEqual(['30px', '30px']);

        view.destroy();
    });

    it('keeps rendered task checkbox width when the cursor is in task text', () => {
        const view = createView('\n- [ ] first task');
        coordsAtPosSpy.mockImplementation((position) => {
            const line = view.state.doc.lineAt(position);
            const prefixTo = line.from + '- [ ] '.length;
            const hasSelectionInPrefix = view.state.selection.ranges.some(
                (range) => range.from <= prefixTo && range.to >= line.from
            );
            const prefixWidth = hasSelectionInPrefix ? 48 : 24;
            const left = position <= line.from + 1 ? 0 : prefixWidth;
            return { left, right: left, top: 0, bottom: 16 };
        });

        flushMeasureCycle(view);
        flushMeasureCycle(view);
        expect(view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent')?.style.paddingLeft).toBe('34px');

        view.dispatch({ selection: { anchor: view.state.doc.line(2).from + '- [ ] first'.length } });
        flushMeasureCycle(view);
        flushMeasureCycle(view);

        expect(view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent')?.style.paddingLeft).toBe('34px');

        view.destroy();
    });

    it('does not remeasure unchanged block quote list lines after same-line edits', () => {
        const view = createView('> - first quoted item\n> - second quoted item');
        flushMeasureCycle(view);
        coordsAtPosSpy.mockClear();

        view.dispatch({
            changes: { from: view.state.doc.line(1).to, insert: 'x' },
        });

        expect(view.dom.querySelectorAll<HTMLElement>('.cm-wrapped-line-indent')).toHaveLength(2);
        expect(coordsAtPosSpy).not.toHaveBeenCalled();

        view.destroy();
    });

    it('keeps list lines decorated immediately after indenting to an unmeasured prefix', () => {
        const view = createView('- item');
        flushMeasureCycle(view);

        view.dispatch({
            changes: { from: view.state.doc.line(1).from, insert: '  ' },
        });

        expect(view.dom.querySelectorAll<HTMLElement>('.cm-wrapped-line-indent')).toHaveLength(1);

        view.destroy();
    });

    it('skips fenced and indented code blocks using markdown syntax parsing', () => {
        const view = createView(
            '- list item\n\n```\n- fenced code\n```\n\n    - indented code\n\n- another list item',
            [markdown()]
        );

        flushMeasureCycle(view);

        const decoratedLineNumbers = [...view.dom.querySelectorAll<HTMLElement>('.cm-line')]
            .map((lineElement, index) => (lineElement.classList.contains('cm-wrapped-line-indent') ? index + 1 : null))
            .filter((lineNumber): lineNumber is number => lineNumber !== null);

        expect(decoratedLineNumbers).toEqual([1, 9]);

        view.destroy();
    });

    it('skips horizontal rules using markdown syntax parsing', () => {
        const view = createView('- list item\n\n***\n* * *\n- - -\n\n* another list item', [markdown()]);

        flushMeasureCycle(view);

        const decoratedLineNumbers = [...view.dom.querySelectorAll<HTMLElement>('.cm-line')]
            .map((lineElement, index) => (lineElement.classList.contains('cm-wrapped-line-indent') ? index + 1 : null))
            .filter((lineNumber): lineNumber is number => lineNumber !== null);

        expect(decoratedLineNumbers).toEqual([1, 7]);

        view.destroy();
    });

    it('does not dispatch a refresh from a pending measure after plugin destruction', () => {
        const view = createView('- item');
        const dispatchSpy = jest.spyOn(view, 'dispatch');
        const plugin = view.plugin(wrappedLineIndentExtension);

        (plugin as unknown as { destroy(): void }).destroy();
        flushMeasureCycle(view);

        expect(dispatchSpy).not.toHaveBeenCalled();

        dispatchSpy.mockRestore();
        view.destroy();
    });
});

describe('getIndentPrefix', () => {
    it('includes list markers inside block quotes', () => {
        expect(getIndentPrefix('> - quoted item')).toBe('> - ');
        expect(getIndentPrefix('> > 12. nested quoted item')).toBe('> > 12. ');
        expect(getIndentPrefix('> * [x] quoted task')).toBe('> * [x] ');
    });

    it('keeps quote-only prefixes for regular block quote lines', () => {
        expect(getIndentPrefix('> quoted text')).toBe('> ');
        expect(getIndentPrefix('> > nested quoted text')).toBe('> > ');
    });
});

describe('getTabReplacementWidth', () => {
    it('expands tabs to the next editor tab stop', () => {
        expect(getTabReplacementWidth('', 4, 10)).toBe(40);
        expect(getTabReplacementWidth('  ', 4, 10)).toBe(20);
        expect(getTabReplacementWidth('\t', 4, 10)).toBe(40);
        expect(getTabReplacementWidth('\t- ', 4, 10)).toBe(20);
    });
});

describe('getLineDecorationStyle', () => {
    it('preserves the editor line padding when adding wrapped indent padding', () => {
        expect(getLineDecorationStyle(24, 10)).toBe('padding-left: 34px; text-indent: -24px;');
    });
});

describe('isBlockCodeNode', () => {
    it('does not treat inline code syntax nodes as block code', () => {
        expect(isBlockCodeNode('InlineCode')).toBe(false);
        expect(isBlockCodeNode('CodeText')).toBe(false);
        expect(isBlockCodeNode('CodeMark')).toBe(false);
    });

    it('recognizes block code syntax nodes', () => {
        expect(isBlockCodeNode('CodeBlock')).toBe(true);
        expect(isBlockCodeNode('FencedCode')).toBe(true);
        expect(isBlockCodeNode('CodeInfo')).toBe(true);
    });
});

describe('isHorizontalRuleNode', () => {
    it('recognizes horizontal rule syntax nodes', () => {
        expect(isHorizontalRuleNode('HorizontalRule')).toBe(true);
    });

    it('does not treat list syntax nodes as horizontal rules', () => {
        expect(isHorizontalRuleNode('BulletList')).toBe(false);
        expect(isHorizontalRuleNode('ListMark')).toBe(false);
    });
});
