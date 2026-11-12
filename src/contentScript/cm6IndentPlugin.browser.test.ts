/// <reference types="vite/client" />
import '@fontsource/roboto/latin-400.css';
import '@fontsource/roboto-mono/latin-400.css';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { forceParsing, syntaxTreeAvailable } from '@codemirror/language';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { findIndentPrefix, wrappedLineIndentExtension } from './cm6IndentPlugin';
import {
    CODEMIRROR_LINE_PADDING,
    JOPLIN_BLOCK_QUOTE_PADDING,
    JOPLIN_LINE_PADDING,
    joplinEditorStyling,
} from './testing/joplinEditorStyling';

const CONTENT = 'Wonderful little words make this paragraph wrap across several visual rows. '.repeat(4);
const BASE_PADDING = 6;
const views: EditorView[] = [];
const linePaddings = new WeakMap<EditorView, number>();
// CodeMirror drops a plugin that throws and reports the exception here instead.
const viewExceptions = new WeakMap<EditorView, unknown[]>();

interface FixtureOptions {
    font?: string;
    width?: number;
    extensions?: Extension[];
    /** Replaces the default font and line padding theme. */
    styling?: Extension;
    /** Left line padding the styling gives unwrapped lines. */
    linePadding?: number;
}

function createView(doc: string, options: FixtureOptions = {}): EditorView {
    const parent = document.createElement('div');
    document.body.append(parent);
    const exceptions: unknown[] = [];
    const view = new EditorView({
        parent,
        state: EditorState.create({
            doc,
            extensions: [
                EditorView.lineWrapping,
                EditorView.theme({
                    '&': { width: `${options.width ?? 340}px` },
                    '.cm-scroller': { height: '240px', overflow: 'auto' },
                }),
                options.styling ??
                    EditorView.theme({
                        '.cm-scroller': {
                            fontFamily: options.font ?? '"Roboto Mono"',
                            fontSize: '16px',
                            lineHeight: '24px',
                        },
                        '.cm-line': { padding: `0 ${BASE_PADDING}px` },
                    }),
                markdown({ base: markdownLanguage }),
                ...(options.extensions ?? []),
                wrappedLineIndentExtension,
                EditorView.exceptionSink.of((exception) => exceptions.push(exception)),
            ],
        }),
    });
    views.push(view);
    linePaddings.set(view, options.linePadding ?? BASE_PADDING);
    viewExceptions.set(view, exceptions);
    return view;
}

/**
 * Resolves after CodeMirror's next measure cycle and any refresh microtasks its writes queued.
 * CodeMirror runs measure requests in request order, so this write follows those already queued.
 */
function afterMeasureCycle(view: EditorView): Promise<void> {
    return new Promise((resolve) => {
        view.requestMeasure({ read: () => null, write: () => queueMicrotask(resolve) });
    });
}

/** Read glyph geometry independently of the coordsAtPos API used by the plugin. */
function characterRect(view: EditorView, position: number): DOMRect {
    const start = view.domAtPos(position);
    const end = view.domAtPos(position + 1);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range.getBoundingClientRect();
}

/** Collect the first non-whitespace glyph on each visual row, including the first. */
function contentRows(view: EditorView, lineNumber: number): DOMRect[] {
    const line = view.state.doc.line(lineNumber);
    const prefix = findIndentPrefix(view.state, line);
    const rows: DOMRect[] = [];
    for (let offset = prefix?.text.length ?? 0; offset < line.length; offset++) {
        if (/\s/.test(line.text.charAt(offset))) {
            continue;
        }
        const rect = characterRect(view, line.from + offset);
        const previousRow = rows[rows.length - 1];
        if (rect.width > 0 && (!previousRow || Math.abs(rect.top - previousRow.top) > 1)) {
            rows.push(rect);
        }
    }
    return rows;
}

function firstContentRow(view: EditorView, lineNumber: number): DOMRect {
    const first = contentRows(view, lineNumber)[0];
    if (!first) {
        throw new Error(`Expected at least one visible content row on line ${lineNumber}.`);
    }
    return first;
}

function isLineDecorated(view: EditorView, lineNumber: number): boolean {
    const line = view.state.doc.line(lineNumber);
    // domAtPos can return the line element itself next to a replacement widget.
    const { node } = view.domAtPos(line.from + 1);
    const lineElement = (node instanceof Element ? node : node.parentElement)?.closest('.cm-line');
    return lineElement?.classList.contains('cm-wrapped-line-indent') ?? false;
}

/**
 * Expect the line to carry the hanging indent, wrapped rows to align with the first row's
 * content, and the first row to start where it would without the plugin: after the line's
 * border and `linePadding`.
 */
async function expectAligned(
    view: EditorView,
    lineNumber = 1,
    linePadding = linePaddings.get(view) ?? BASE_PADDING
): Promise<void> {
    // Poll real layout; do not mock frames, invoke CodeMirror internals, or use fixed sleeps.
    await expect
        .poll(() => {
            // An undecorated line wraps to the margin, which also looks aligned when no prefix is found.
            if (!isLineDecorated(view, lineNumber)) {
                return false;
            }
            const rows = contentRows(view, lineNumber);
            const first = rows[0];
            if (!first || rows.length < 2) {
                return false;
            }
            return rows.slice(1).every((row) => Math.abs(row.left - first.left) <= 1);
        })
        .toBe(true);

    const line = view.state.doc.line(lineNumber);
    const prefixLength = findIndentPrefix(view.state, line)?.text.length ?? 0;
    const contentNode = view.domAtPos(line.from + prefixLength + 1).node;
    const lineElement = contentNode.parentElement?.closest('.cm-line');
    expect(lineElement).not.toBeNull();
    const prefixRects = Array.from({ length: prefixLength }, (_, offset) => characterRect(view, line.from + offset));
    // Replacement widgets may be omitted by domAtPos boundary mapping; inspect the
    // actual first tab box when the prefix starts with a replacement.
    const first = line.text.startsWith('\t')
        ? lineElement!.querySelector('.cm-tab')!.getBoundingClientRect()
        : (prefixRects.find((rect) => rect.width > 0) ?? firstContentRow(view, lineNumber));
    const contentLeft = lineElement!.getBoundingClientRect().left + lineElement!.clientLeft + linePadding;
    expect(Math.abs(first.left - contentLeft)).toBeLessThanOrEqual(1);
}

beforeAll(async () => {
    const fonts = await Promise.all([document.fonts.load('16px "Roboto"'), document.fonts.load('16px "Roboto Mono"')]);
    if (fonts.some((faces) => faces.length === 0)) {
        throw new Error('The bundled test fonts must load before checking layout.');
    }
});

afterEach(() => {
    const exceptions = views.flatMap((view) => viewExceptions.get(view) ?? []);
    for (const view of views) {
        const parent = view.dom.parentElement;
        view.destroy();
        parent?.remove();
    }
    views.length = 0;
    // Fail any test whose editor dropped a throwing plugin, after cleanup so later tests start clean.
    if (exceptions.length > 0) {
        throw new Error(`CodeMirror reported exceptions during the test: ${exceptions.map(String).join('; ')}`);
    }
});

describe('hanging indentation in Chromium', () => {
    it.each(['- ', '123. ', '- [ ] ', '> > ', '> - '])('aligns wrapped content after %j', async (prefix) => {
        await expectAligned(createView(prefix + CONTENT));
    });

    it.each([
        { tabSize: 4, font: '"Roboto Mono"' },
        { tabSize: 8, font: '"Roboto Mono"' },
        { tabSize: 4, font: '"Roboto"' },
        { tabSize: 8, font: '"Roboto"' },
    ])('aligns tabs and mixed whitespace with tab size $tabSize in $font', async ({ tabSize, font }) => {
        // A top-level leading tab starts an indented code block, so indent list content instead.
        const view = createView(['- parent', ...['\t', ' \t', '\t-\t'].map((prefix) => prefix + CONTENT)].join('\n'), {
            font,
            extensions: [EditorState.tabSize.of(tabSize)],
        });
        for (let line = 2; line <= 4; line++) {
            view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(line).from) });
            await expectAligned(view, line);
        }
    });

    it('aligns proportional text and remeasures after a font change', async () => {
        const font = new Compartment();
        const view = createView('123. ' + CONTENT, {
            extensions: [font.of(Prec.high(EditorView.theme({ '.cm-scroller': { fontFamily: '"Roboto"' } })))],
        });
        await expectAligned(view);
        const before = firstContentRow(view, 1).left;
        view.dispatch({
            effects: font.reconfigure(Prec.high(EditorView.theme({ '.cm-scroller': { fontFamily: '"Roboto Mono"' } }))),
        });
        await expect.poll(() => Math.abs(firstContentRow(view, 1).left - before)).toBeGreaterThan(1);
        await expectAligned(view);
    });

    it('keeps alignment after the editor becomes narrower', async () => {
        const view = createView('- [ ] ' + CONTENT, { width: 480 });
        await expectAligned(view);
        const before = contentRows(view, 1).length;
        view.dom.style.width = '250px';
        await expect.poll(() => contentRows(view, 1).length).toBeGreaterThan(before);
        await expectAligned(view);
    });

    it('allows clicking, moving across, deleting, and undoing a tab widget', async () => {
        const parent = '- parent\n';
        const original = parent + '\t' + CONTENT;
        const tabFrom = parent.length;
        const view = createView(original, {
            extensions: [history(), keymap.of([...defaultKeymap, ...historyKeymap])],
        });
        await expectAligned(view, 2);
        const tab = view.contentDOM.querySelector<HTMLElement>('.cm-tab');
        expect(tab).not.toBeNull();
        await userEvent.click(tab!);
        expect(view.hasFocus).toBe(true);
        expect(view.state.selection.main.head).toBeGreaterThanOrEqual(tabFrom);
        expect(view.state.selection.main.head).toBeLessThanOrEqual(tabFrom + 1);

        view.dispatch({ selection: { anchor: tabFrom } });
        await userEvent.keyboard('{ArrowRight}');
        expect(view.state.selection.main.head).toBe(tabFrom + 1);
        await userEvent.keyboard('{ArrowLeft}');
        expect(view.state.selection.main.head).toBe(tabFrom);
        await userEvent.keyboard('{ArrowRight}{Backspace}');
        expect(view.state.doc.toString()).toBe(parent + CONTENT);
        await expect.poll(() => view.contentDOM.querySelector('.cm-tab')).toBeNull();
        const modifier = navigator.userAgent.includes('Mac') ? 'Meta' : 'Control';
        await userEvent.keyboard(`{${modifier}>}z{/${modifier}}`);
        expect(view.state.doc.toString()).toBe(original);
        await expectAligned(view, 2);
    });

    it('keeps shifted list items aligned after inserting text before them', async () => {
        // `1.` because CommonMark only lets an ordered list starting at 1 interrupt a paragraph.
        const view = createView('Heading\n- ' + CONTENT + '\n1. ' + CONTENT);
        await expectAligned(view, 2);
        view.dispatch({ changes: { from: 0, insert: 'New heading\n' } });
        await expectAligned(view, 3);
        view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(4).from) });
        await expectAligned(view, 4);
    });

    it('remeasures lines after scrolling away and back', async () => {
        const prefix = '123. ';
        const doc = Array.from({ length: 80 }, () => prefix + CONTENT).join('\n');
        const last = doc.lastIndexOf('\n') + 1;
        // Matching raw prefixes share a fallback cache key. Different rendered widths
        // require fresh measurements when either line enters the viewport.
        const view = createView(doc, {
            extensions: [
                EditorView.decorations.of(
                    Decoration.set([
                        Decoration.mark({ attributes: { style: 'font-family: "Roboto"' } }).range(0, prefix.length),
                        Decoration.mark({ attributes: { style: 'font-family: "Roboto Mono"' } }).range(
                            last,
                            last + prefix.length
                        ),
                    ])
                ),
            ],
        });
        await expectAligned(view);
        const firstPrefixWidth = characterRect(view, prefix.length).left - characterRect(view, 0).left;
        view.dispatch({ effects: EditorView.scrollIntoView(last, { y: 'start' }) });
        await expect.poll(() => view.viewport.from).toBeGreaterThan(0);
        await expectAligned(view, 80);
        const lastPrefixWidth = characterRect(view, last + prefix.length).left - characterRect(view, last).left;
        expect(Math.abs(lastPrefixWidth - firstPrefixWidth)).toBeGreaterThan(1);
        view.dispatch({ effects: EditorView.scrollIntoView(0, { y: 'start' }) });
        await expect.poll(() => view.viewport.from).toBe(0);
        await expectAligned(view);
    });

    it('decorates list lines beyond the initial parse once parsing reaches them', async () => {
        const doc = 'plain paragraph\n\n'.repeat(3000) + '- ' + CONTENT;
        const view = createView(doc);
        const lastLine = view.state.doc.lines;
        expect(syntaxTreeAvailable(view.state)).toBe(false);
        view.dispatch({ effects: EditorView.scrollIntoView(doc.length, { y: 'end' }) });
        await expectAligned(view, lastLine);
    });

    it('decorates the list line after a large paste once parsing catches up', async () => {
        const doc = Array.from({ length: 200 }, () => '- ' + CONTENT).join('\n');
        const view = createView(doc);
        view.dispatch({ effects: EditorView.scrollIntoView(doc.length, { y: 'end' }) });
        await expectAligned(view, view.state.doc.lines);

        // Paste above the last list line with the cursor after it, as a user would. Reparsing
        // this much text exceeds the synchronous parse budget, so the idle parse finishes it.
        const paste = 'Pasted paragraph with *emphasis* and `code`.\n\n'.repeat(20000);
        const from = view.state.doc.line(view.state.doc.lines).from;
        view.dispatch({
            changes: { from, insert: paste },
            selection: { anchor: from + paste.length },
            scrollIntoView: true,
        });
        await expectAligned(view, view.state.doc.lines);
    });

    it('remeasures a hidden quote marker when an effect reveals it', async () => {
        // Simulates render-markup replacement; actual Joplin widgets still need app-level testing.
        const markup = new Compartment();
        const hiddenMarker = Decoration.replace({}).range(0, 1);
        const view = createView('> ' + CONTENT, {
            extensions: [markup.of(EditorView.decorations.of(Decoration.set([hiddenMarker])))],
        });
        await expectAligned(view);
        const hiddenLeft = firstContentRow(view, 1).left;
        view.dispatch({ effects: markup.reconfigure([]) });
        // The plugin's refresh must align the rows within this measure cycle, before paint,
        // without waiting for a second cycle.
        await afterMeasureCycle(view);
        const rows = contentRows(view, 1);
        expect(rows.length).toBeGreaterThan(1);
        expect(rows[0]!.left - hiddenLeft).toBeGreaterThan(1);
        for (const row of rows.slice(1)) {
            expect(Math.abs(row.left - rows[0]!.left)).toBeLessThanOrEqual(1);
        }
        await expectAligned(view);
    });

    it('survives a tab-indented line long enough to span several visible ranges', async () => {
        const view = createView(`- parent\n\t- ${'word '.repeat(40000)}\nafter`);
        forceParsing(view, view.state.doc.length, 10000);
        await expectAligned(view, 2);
        const line = view.state.doc.line(2);

        // A cursor in the middle keeps a separate range rendered within this long line.
        view.dispatch({ selection: { anchor: line.from + 100000 }, scrollIntoView: true });
        await expect
            .poll(() => view.visibleRanges.filter((range) => range.from <= line.to && range.to >= line.from).length)
            .toBeGreaterThan(1);
        await afterMeasureCycle(view);
        expect(viewExceptions.get(view)).toEqual([]);
        expect(view.plugin(wrappedLineIndentExtension)).not.toBeNull();
    });

    it('leaves fenced and indented code without hanging indentation', async () => {
        const view = createView('```\n- ' + CONTENT + '\n```\n\n    ' + CONTENT);
        forceParsing(view, view.state.doc.length);
        for (const lineNumber of [2, 5]) {
            view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(lineNumber).from) });
            await expect
                .poll(() => {
                    const line = view.state.doc.line(lineNumber);
                    return view
                        .domAtPos(line.from)
                        .node.parentElement?.closest('.cm-line')
                        ?.classList.contains('cm-wrapped-line-indent');
                })
                .toBe(false);
            const rows = contentRows(view, lineNumber);
            expect(rows.length).toBeGreaterThan(1);
            const node = view.domAtPos(view.state.doc.line(lineNumber).from + 1).node;
            const left = node.parentElement!.closest('.cm-line')!.getBoundingClientRect().left + BASE_PADDING;
            for (const row of rows.slice(1)) {
                expect(Math.abs(row.left - left)).toBeLessThanOrEqual(1);
            }
        }
    });
});

describe('hanging indentation with Joplin editor styling', () => {
    const joplinView = (doc: string, fontFamily = '"Roboto"', extensions: Extension[] = []): EditorView =>
        createView(doc, {
            styling: joplinEditorStyling({ fontFamily, monospaceFont: '"Roboto Mono"' }),
            linePadding: JOPLIN_LINE_PADDING,
            extensions,
        });

    it.each(
        ['"Roboto"', '"Roboto Mono"'].flatMap((font) =>
            ['> ', '> - ', '> - [ ] ', '>   - [ ] '].map((prefix) => ({ font, prefix }))
        )
    )('aligns $prefix with a hidden quote marker in $font', async ({ font, prefix }) => {
        const markup = new Compartment();
        const view = joplinView(prefix + CONTENT, font, [
            // Joplin's makeHideReplaceExtension.ts keeps the quote text inside a
            // scaled inline block. Unlike Decoration.replace, this element inherits the
            // line's text-indent.
            markup.of(EditorView.decorations.of(Decoration.set([Decoration.mark({ class: 'cm-hidden' }).range(0, 1)]))),
            EditorView.theme({
                '& .cm-hidden': {
                    width: '1px',
                    height: '1em',
                    marginRight: '-0.9px',
                    opacity: '0',
                    display: 'inline-block',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    transform: 'scale(0.1, 1)',
                },
            }),
        ]);
        await expectAligned(view);
        view.dispatch({ effects: markup.reconfigure([]) });
        await expectAligned(view);
    });

    it.each(
        ['"Roboto"', '"Roboto Mono"'].flatMap((font) =>
            ['- ', '123. ', '> ', '> > '].map((prefix) => ({ font, prefix }))
        )
    )('aligns wrapped content after $prefix in $font', async ({ font, prefix }) => {
        await expectAligned(joplinView(prefix + CONTENT, font));
    });

    it.each(
        ['"Roboto"', '"Roboto Mono"'].flatMap((font) =>
            ['- [ ] ', '- [x] ', '> - [ ] '].map((prefix) => ({ font, prefix }))
        )
    )('aligns wrapped content after $prefix with a monospace task marker in $font', async ({ font, prefix }) => {
        const view = joplinView(prefix + CONTENT, font);
        await expect.poll(() => view.contentDOM.querySelector('.cm-taskMarker')).not.toBeNull();
        const marker = view.contentDOM.querySelector('.cm-taskMarker')!;
        expect(getComputedStyle(marker).fontFamily).toContain('Roboto Mono');
        await expectAligned(view);
    });

    it.each([
        { prefix: '- ', linePadding: CODEMIRROR_LINE_PADDING },
        { prefix: '> ', linePadding: JOPLIN_BLOCK_QUOTE_PADDING },
    ])('aligns $prefix when a line-number gutter disables the 1px padding', async ({ prefix, linePadding }) => {
        await expectAligned(joplinView(prefix + CONTENT, '"Roboto"', [lineNumbers()]), 1, linePadding);
    });
});
