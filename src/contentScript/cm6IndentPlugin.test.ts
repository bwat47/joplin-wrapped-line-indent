import { markdown } from '@codemirror/lang-markdown';
import { forceParsing } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import type { ChangeSpec, Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { CodeMirrorControl } from 'api/types';

import {
    default as createContentScript,
    getLineDecorationStyle,
    isFullDocumentReplace,
    parseIndentPrefix,
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
        const codeMirrorWrapper: CodeMirrorControl = {
            cm6: {} as EditorView,
            addExtension: (extension) => {
                extensionGroups.push(extension);
            },
            editor: {},
            supportsCommand: jest.fn(),
            execCommand: jest.fn(),
            registerCommand: jest.fn(),
            joplinExtensions: {
                completionSource: jest.fn(),
                enableLanguageDataAutocomplete: { of: jest.fn() },
                noteIdFacet: {},
                setNoteIdEffect: {},
            },
        };

        createContentScript().plugin(codeMirrorWrapper);

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
            plugin as unknown as {
                linePadding: { status: 'unknown' | 'stale' | 'measured'; value: number };
                scheduleMeasure(): void;
            }
        ).linePadding = { status: 'stale', value: 10 };
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
        let measuredPrefixWidth = 16;
        coordsAtPosSpy.mockImplementation((position) => {
            const line = view.state.doc.lineAt(position);
            const left = position <= line.from + 1 ? 0 : measuredPrefixWidth;
            return { left, right: left, top: 0, bottom: 16 };
        });

        flushMeasureCycle(view);
        flushMeasureCycle(view);
        expect(view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent')?.style.paddingLeft).toBe('26px');

        view.dispatch({ selection: { anchor: view.state.doc.line(1).to } });

        expect(view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent')?.style.paddingLeft).toBe('26px');

        measuredPrefixWidth = 28;
        flushMeasureCycle(view);
        flushMeasureCycle(view);
        expect(view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent')?.style.paddingLeft).toBe('38px');

        view.destroy();
    });

    it('applies the latest block quote selection state when selection changes again before measurement runs', () => {
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

        flushMeasureCycle(view);
        flushMeasureCycle(view);

        view.dispatch({ selection: { anchor: view.state.doc.line(1).from, head: view.state.doc.line(2).to } });
        view.dispatch({ selection: { anchor: view.state.doc.line(2).to } });

        flushMeasureCycle(view);
        flushMeasureCycle(view);

        expect(
            [...view.dom.querySelectorAll<HTMLElement>('.cm-wrapped-line-indent')].map((line) => line.style.paddingLeft)
        ).toEqual(['26px', '42px']);

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

        expect(view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent')?.style.paddingLeft).toBe('30px');

        view.destroy();
    });

    it('remeasures rendered task checkbox width after toggling while raw markup was visible', () => {
        const view = createView('  - [ ] first task');
        coordsAtPosSpy.mockImplementation((position) => {
            const line = view.state.doc.lineAt(position);
            const checkboxFrom = line.from + '  - '.length;
            const checkboxTo = checkboxFrom + '[ ]'.length;
            const prefixTo = line.from + '  - [ ] '.length;
            const cursor = view.state.selection.main.head;
            const revealsCheckboxMarkup = cursor >= checkboxFrom && cursor <= checkboxTo;
            const prefixWidth = revealsCheckboxMarkup ? 56 : 32;
            const left = position <= line.from + 1 ? 0 : position <= prefixTo ? prefixWidth : prefixWidth + 8;
            return { left, right: left, top: 0, bottom: 16 };
        });

        flushMeasureCycle(view);
        flushMeasureCycle(view);
        expect(view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent')?.style.paddingLeft).toBe('42px');

        view.dispatch({ selection: { anchor: view.state.doc.line(1).from + '  - ['.length } });

        view.dispatch({
            changes: {
                from: view.state.doc.line(1).from + '  - ['.length,
                to: view.state.doc.line(1).from + '  - [ ]'.length,
                insert: 'x]',
            },
        });
        flushMeasureCycle(view);
        flushMeasureCycle(view);
        flushMeasureCycle(view);
        expect(view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent')?.style.paddingLeft).toBe('66px');

        view.dispatch({ selection: { anchor: view.state.doc.line(1).from + '  - [x] '.length } });
        flushMeasureCycle(view);
        flushMeasureCycle(view);
        flushMeasureCycle(view);

        expect(view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent')?.style.paddingLeft).toBe('42px');

        view.destroy();
    });

    it('uses task fallback width immediately after toggling checkbox markup', () => {
        const view = createView('  - [ ] first task');
        coordsAtPosSpy.mockImplementation((position) => {
            const line = view.state.doc.lineAt(position);
            const prefixWidth = line.text.startsWith('  - [x] ') ? 56 : 32;
            const left = position <= line.from + 1 ? 0 : prefixWidth;
            return { left, right: left, top: 0, bottom: 16 };
        });

        flushMeasureCycle(view);
        flushMeasureCycle(view);
        expect(view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent')?.style.paddingLeft).toBe('42px');

        view.dispatch({
            changes: {
                from: view.state.doc.line(1).from + '  - ['.length,
                to: view.state.doc.line(1).from + '  - [ ]'.length,
                insert: 'x]',
            },
        });

        expect(view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent')?.style.paddingLeft).toBe('42px');

        flushMeasureCycle(view);
        flushMeasureCycle(view);
        expect(view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent')?.style.paddingLeft).toBe('66px');

        view.destroy();
    });

    it('keeps direct task measurements isolated per visible line', () => {
        const view = createView('- [ ] first task\n- [ ] second task');
        coordsAtPosSpy.mockImplementation((position) => {
            const line = view.state.doc.lineAt(position);
            const prefixWidth = line.number === 1 ? 40 : 24;
            const left = position <= line.from + 1 ? 0 : prefixWidth;
            return { left, right: left, top: 0, bottom: 16 };
        });

        flushMeasureCycle(view);
        flushMeasureCycle(view);

        expect(
            [...view.dom.querySelectorAll<HTMLElement>('.cm-wrapped-line-indent')].map((line) => line.style.paddingLeft)
        ).toEqual(['50px', '34px']);

        view.destroy();
    });

    it('uses fallback prefix width for a newly introduced matching prefix', () => {
        const view = createView('  - first item\nplain text');
        coordsAtPosSpy.mockImplementation((position) => {
            const line = view.state.doc.lineAt(position);
            const left = position <= line.from + 1 ? 0 : 40;
            return { left, right: left, top: 0, bottom: 16 };
        });

        flushMeasureCycle(view);
        flushMeasureCycle(view);

        view.dispatch({
            changes: {
                from: view.state.doc.line(2).from,
                insert: '  - ',
            },
        });

        expect(
            [...view.dom.querySelectorAll<HTMLElement>('.cm-wrapped-line-indent')].map((line) => line.style.paddingLeft)
        ).toEqual(['50px', '50px']);

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

    it('preserves visible exact line measurements after same-prefix document edits', () => {
        const view = createView('  - first item');
        flushMeasureCycle(view);
        flushMeasureCycle(view);

        const plugin = view.plugin(wrappedLineIndentExtension) as unknown as {
            fallbackPrefixWidths: Map<string, number>;
            measuredLineWidths: Map<string, number>;
        };
        expect(plugin.measuredLineWidths.size).toBe(1);
        expect(plugin.fallbackPrefixWidths.size).toBe(1);

        view.dispatch({
            changes: { from: view.state.doc.line(1).to, insert: 'x' },
        });

        expect(plugin.measuredLineWidths.size).toBe(1);
        expect(plugin.fallbackPrefixWidths.size).toBe(1);

        view.destroy();
    });

    it('clears cached measurements after a full document replacement', () => {
        const view = createView('  - first item');
        flushMeasureCycle(view);
        flushMeasureCycle(view);

        const plugin = view.plugin(wrappedLineIndentExtension) as unknown as {
            fallbackPrefixWidths: Map<string, number>;
            measuredLineWidths: Map<string, number>;
        };
        expect(plugin.measuredLineWidths.size).toBe(1);
        expect(plugin.fallbackPrefixWidths.size).toBe(1);

        view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: '  - replacement item' },
        });

        expect(plugin.measuredLineWidths.size).toBe(0);
        expect(plugin.fallbackPrefixWidths.size).toBe(0);

        flushMeasureCycle(view);
        expect(plugin.measuredLineWidths.size).toBe(1);
        expect(plugin.fallbackPrefixWidths.size).toBe(1);

        view.destroy();
    });

    it('prunes exact line measurements that are no longer visible', () => {
        const view = createView('  - first item');
        flushMeasureCycle(view);
        flushMeasureCycle(view);

        const plugin = view.plugin(wrappedLineIndentExtension) as unknown as {
            measuredLineWidths: Map<string, number>;
        };
        plugin.measuredLineWidths.set('999:  - ', 40);

        view.dispatch({ selection: { anchor: view.state.doc.line(1).to } });

        expect([...plugin.measuredLineWidths.keys()]).toEqual(['0:  - ']);

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

    it('uses a fallback estimate when one visible line is temporarily unavailable', () => {
        const view = createView('  - first item\n  - second item');
        const secondLine = view.state.doc.line(2);

        coordsAtPosSpy.mockImplementation((position) => {
            if (position >= secondLine.from && position <= secondLine.to) {
                return null;
            }

            const line = view.state.doc.lineAt(position);
            const left = position <= line.from + 1 ? 0 : 40;
            return { left, right: left, top: 0, bottom: 16 };
        });

        flushMeasureCycle(view);
        flushMeasureCycle(view);

        expect(
            [...view.dom.querySelectorAll<HTMLElement>('.cm-wrapped-line-indent')].map((line) => line.style.paddingLeft)
        ).toEqual(['50px', '50px']);

        view.destroy();
    });

    it('keeps different direct task measurements instead of collapsing equivalent prefixes', () => {
        const view = createView('  - [ ] first task\n  - [ ] second task');
        let renderedMeasurementsDisagree = true;

        coordsAtPosSpy.mockImplementation((position) => {
            const line = view.state.doc.lineAt(position);
            let prefixWidth = 56;

            if (renderedMeasurementsDisagree && line.number === 2 && position > line.from + 1) {
                prefixWidth = 32;
                renderedMeasurementsDisagree = false;
            }

            const left = position <= line.from + 1 ? 0 : prefixWidth;
            return { left, right: left, top: 0, bottom: 16 };
        });

        flushMeasureCycle(view);
        flushMeasureCycle(view);
        expect(
            [...view.dom.querySelectorAll<HTMLElement>('.cm-wrapped-line-indent')].map((line) => line.style.paddingLeft)
        ).toEqual(['66px', '42px']);

        view.destroy();
    });

    it('remeasures cached tab prefix widths when tab size changes', () => {
        const tabSize = new Compartment();
        const view = createView('\tindented paragraph', [tabSize.of(EditorState.tabSize.of(4))]);
        coordsAtPosSpy.mockImplementation((position) => {
            const left = position === view.state.doc.line(1).from ? 0 : view.state.tabSize * 8;
            return { left, right: left, top: 0, bottom: 16 };
        });

        flushMeasureCycle(view);
        expect(view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent')?.style.paddingLeft).toBe('42px');

        view.dispatch({ effects: tabSize.reconfigure(EditorState.tabSize.of(8)) });
        flushMeasureCycle(view);

        expect(view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent')?.style.paddingLeft).toBe('74px');

        view.destroy();
    });

    it('applies an exact measurement on the one deferred follow-up refresh', () => {
        const view = createView('> - item');
        const dispatchSpy = jest.spyOn(view, 'dispatch');
        let measurementAvailable = false;

        coordsAtPosSpy.mockImplementation((position) => {
            if (!measurementAvailable) {
                return null;
            }

            const line = view.state.doc.lineAt(position);
            const left = position <= line.from + 1 ? 0 : 44;
            return { left, right: left, top: 0, bottom: 16 };
        });

        flushMeasureCycle(view);
        expect(view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent')?.style.paddingLeft).toBe('38px');
        expect(dispatchSpy).toHaveBeenCalledTimes(1);

        measurementAvailable = true;
        flushMeasureCycle(view);

        expect(view.dom.querySelector<HTMLElement>('.cm-wrapped-line-indent')?.style.paddingLeft).toBe('54px');
        expect(dispatchSpy).toHaveBeenCalledTimes(2);

        dispatchSpy.mockRestore();
        view.destroy();
    });

    it('converges to the latest selection state before a deferred follow-up refresh settles', () => {
        const view = createView('> - first quoted item\n> - second quoted item');
        let measurementAvailable = true;

        coordsAtPosSpy.mockImplementation((position) => {
            if (!measurementAvailable) {
                return null;
            }

            const line = view.state.doc.lineAt(position);
            const hasSelectionOnLine = view.state.selection.ranges.some(
                (range) => range.from <= line.to && range.to >= line.from
            );
            const characterWidth = hasSelectionOnLine ? 8 : 4;
            const left = position <= line.from + 1 ? 0 : 4 * characterWidth;
            return { left, right: left, top: 0, bottom: 16 };
        });

        flushMeasureCycle(view);
        flushMeasureCycle(view);

        measurementAvailable = false;
        view.dispatch({ selection: { anchor: view.state.doc.line(1).from, head: view.state.doc.line(2).to } });

        (view as MeasurableEditorView).measure(false);

        view.dispatch({ selection: { anchor: view.state.doc.line(2).to } });
        measurementAvailable = true;

        flushAnimationFrames();
        flushMeasureCycle(view);
        flushMeasureCycle(view);

        expect(
            [...view.dom.querySelectorAll<HTMLElement>('.cm-wrapped-line-indent')].map((line) => line.style.paddingLeft)
        ).toEqual(['26px', '42px']);

        view.destroy();
    });

    it('stops self-refreshing after one incomplete follow-up measurement', () => {
        const view = createView('> - item');
        const dispatchSpy = jest.spyOn(view, 'dispatch');

        coordsAtPosSpy.mockImplementation(() => null);

        flushMeasureCycle(view);
        expect(dispatchSpy).toHaveBeenCalledTimes(1);
        expect(view.dom.querySelectorAll<HTMLElement>('.cm-wrapped-line-indent')).toHaveLength(1);

        flushMeasureCycle(view);
        expect(dispatchSpy).toHaveBeenCalledTimes(1);

        flushMeasureCycle(view);
        expect(dispatchSpy).toHaveBeenCalledTimes(1);

        dispatchSpy.mockRestore();
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

    it('rebuilds decorations when parser state changes without a document change', () => {
        const view = createView(`- item\n\n${'plain paragraph\n\n'.repeat(400)}`, [markdown()]);

        flushMeasureCycle(view);

        const plugin = view.plugin(wrappedLineIndentExtension) as unknown as {
            buildDecorations(): unknown;
        };
        const buildDecorationsSpy = jest.spyOn(plugin, 'buildDecorations');

        expect(forceParsing(view, view.state.doc.length, 1000)).toBe(true);

        expect(buildDecorationsSpy).toHaveBeenCalledTimes(1);

        buildDecorationsSpy.mockRestore();
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

describe('isFullDocumentReplace', () => {
    const createTransaction = (doc: string, changes?: ChangeSpec) => {
        const state = EditorState.create({ doc });
        return state.update({ changes });
    };

    it('detects a single change replacing the whole previous document', () => {
        const transaction = createTransaction('old note', {
            from: 0,
            to: 'old note'.length,
            insert: 'new note',
        });

        expect(isFullDocumentReplace(transaction)).toBe(true);
    });

    it('ignores partial edits', () => {
        const transaction = createTransaction('old note', {
            from: 'old'.length,
            insert: 'er',
        });

        expect(isFullDocumentReplace(transaction)).toBe(false);
    });

    it('ignores multiple changes even when they cover the document overall', () => {
        const transaction = createTransaction('old note', [
            { from: 0, to: 3, insert: 'new' },
            { from: 4, to: 8, insert: 'text' },
        ]);

        expect(isFullDocumentReplace(transaction)).toBe(false);
    });

    it('ignores transactions without document changes', () => {
        const transaction = createTransaction('old note');

        expect(isFullDocumentReplace(transaction)).toBe(false);
    });
});

describe('parseIndentPrefix', () => {
    it('captures quoted list metadata', () => {
        expect(parseIndentPrefix('> - quoted item')).toEqual({
            text: '> - ',
        });
        expect(parseIndentPrefix('> > 12. nested quoted item')).toEqual({
            text: '> > 12. ',
        });
        expect(parseIndentPrefix('> * [x] quoted task')).toEqual({
            text: '> * [x] ',
        });
    });

    it('captures quote-only, list, and indentation metadata', () => {
        expect(parseIndentPrefix('> quoted text')).toEqual({
            text: '> ',
        });
        expect(parseIndentPrefix('> > nested quoted text')).toEqual({
            text: '> > ',
        });
        expect(parseIndentPrefix('- [ ] task item')).toEqual({
            text: '- [ ] ',
        });
        expect(parseIndentPrefix('    indented paragraph')).toEqual({
            text: '    ',
        });
    });

    it('returns null when a line has no indent prefix', () => {
        expect(parseIndentPrefix('plain paragraph')).toBeNull();
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
