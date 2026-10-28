/// <reference types="vite/client" />
import '@fontsource/roboto/latin-400.css';
import '@fontsource/roboto-mono/latin-400.css';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { forceParsing } from '@codemirror/language';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { parseIndentPrefix, wrappedLineIndentExtension } from './cm6IndentPlugin';
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
                ...(options.extensions ?? []),
                wrappedLineIndentExtension,
            ],
        }),
    });
    views.push(view);
    linePaddings.set(view, options.linePadding ?? BASE_PADDING);
    return view;
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
    const prefix = parseIndentPrefix(line.text);
    const rows: DOMRect[] = [];
    for (let offset = prefix?.text.length ?? 0; offset < line.length; offset++) {
        if (/\s/.test(line.text[offset])) {
            continue;
        }
        const rect = characterRect(view, line.from + offset);
        if (rect.width > 0 && (!rows.length || Math.abs(rect.top - rows[rows.length - 1].top) > 1)) {
            rows.push(rect);
        }
    }
    return rows;
}

/**
 * Expect wrapped rows to align with the first row's content, and the first row to start
 * where it would without the plugin: after the line's border and `linePadding`.
 */
async function expectAligned(
    view: EditorView,
    lineNumber = 1,
    linePadding = linePaddings.get(view) ?? BASE_PADDING
): Promise<void> {
    // Poll real layout; do not mock frames, invoke CodeMirror internals, or use fixed sleeps.
    await expect
        .poll(() => {
            const rows = contentRows(view, lineNumber);
            if (rows.length < 2) {
                return false;
            }
            return rows.slice(1).every((row) => Math.abs(row.left - rows[0].left) <= 1);
        })
        .toBe(true);

    const line = view.state.doc.line(lineNumber);
    const prefixLength = parseIndentPrefix(line.text)?.text.length ?? 0;
    const contentNode = view.domAtPos(line.from + prefixLength + 1).node;
    const lineElement = contentNode.parentElement?.closest('.cm-line');
    expect(lineElement).not.toBeNull();
    const prefixRects = Array.from({ length: prefixLength }, (_, offset) => characterRect(view, line.from + offset));
    // Replacement widgets may be omitted by domAtPos boundary mapping; inspect the
    // actual first tab box when the prefix starts with a replacement.
    const first = line.text.startsWith('\t')
        ? lineElement!.querySelector('.cm-tab')!.getBoundingClientRect()
        : (prefixRects.find((rect) => rect.width > 0) ?? contentRows(view, lineNumber)[0]);
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
    for (const view of views) {
        const parent = view.dom.parentElement;
        view.destroy();
        parent?.remove();
    }
    views.length = 0;
});

describe('hanging indentation in Chromium', () => {
    it.each(['- ', '123. ', '- [ ] ', '> > ', '> - '])('aligns wrapped content after %j', async (prefix) => {
        await expectAligned(createView(prefix + CONTENT, { extensions: [markdown()] }));
    });

    it.each([
        { tabSize: 4, font: '"Roboto Mono"' },
        { tabSize: 8, font: '"Roboto Mono"' },
        { tabSize: 4, font: '"Roboto"' },
        { tabSize: 8, font: '"Roboto"' },
    ])('aligns tabs and mixed whitespace with tab size $tabSize in $font', async ({ tabSize, font }) => {
        // These raw indented paragraphs intentionally omit Markdown parsing, which would
        // classify a leading tab as an excluded code block.
        const view = createView(['\t', ' \t', '\t-\t'].map((prefix) => prefix + CONTENT).join('\n'), {
            font,
            extensions: [EditorState.tabSize.of(tabSize)],
        });
        for (let line = 1; line <= 3; line++) {
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
        const before = contentRows(view, 1)[0].left;
        view.dispatch({
            effects: font.reconfigure(Prec.high(EditorView.theme({ '.cm-scroller': { fontFamily: '"Roboto Mono"' } }))),
        });
        await expect.poll(() => Math.abs(contentRows(view, 1)[0].left - before)).toBeGreaterThan(1);
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
        const original = '\t' + CONTENT;
        const view = createView(original, {
            extensions: [history(), keymap.of([...defaultKeymap, ...historyKeymap])],
        });
        await expectAligned(view);
        const tab = view.contentDOM.querySelector<HTMLElement>('.cm-tab');
        expect(tab).not.toBeNull();
        await userEvent.click(tab!);
        expect(view.hasFocus).toBe(true);
        expect(view.state.selection.main.head).toBeLessThanOrEqual(1);

        view.dispatch({ selection: { anchor: 0 } });
        await userEvent.keyboard('{ArrowRight}');
        expect(view.state.selection.main.head).toBe(1);
        await userEvent.keyboard('{ArrowLeft}');
        expect(view.state.selection.main.head).toBe(0);
        await userEvent.keyboard('{ArrowRight}{Backspace}');
        expect(view.state.doc.toString()).toBe(CONTENT);
        await expect.poll(() => view.contentDOM.querySelector('.cm-tab')).toBeNull();
        const modifier = navigator.userAgent.includes('Mac') ? 'Meta' : 'Control';
        await userEvent.keyboard(`{${modifier}>}z{/${modifier}}`);
        expect(view.state.doc.toString()).toBe(original);
        await expectAligned(view);
    });

    it('keeps shifted list items aligned after inserting text before them', async () => {
        const view = createView('Heading\n- ' + CONTENT + '\n123. ' + CONTENT);
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

    it('remeasures a hidden quote marker when an effect reveals it', async () => {
        // Simulates render-markup replacement; actual Joplin widgets still need app-level testing.
        const markup = new Compartment();
        const hiddenMarker = Decoration.replace({}).range(0, 1);
        const view = createView('> ' + CONTENT, {
            extensions: [markup.of(EditorView.decorations.of(Decoration.set([hiddenMarker])))],
        });
        await expectAligned(view);
        const hiddenLeft = contentRows(view, 1)[0].left;
        view.dispatch({ effects: markup.reconfigure([]) });
        await expect.poll(() => contentRows(view, 1)[0].left - hiddenLeft).toBeGreaterThan(1);
        await expectAligned(view);
    });

    it('leaves fenced and indented code without hanging indentation', async () => {
        const view = createView('```\n- ' + CONTENT + '\n```\n\n    ' + CONTENT, {
            extensions: [markdown()],
        });
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
            extensions: [markdown({ base: markdownLanguage }), ...extensions],
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
