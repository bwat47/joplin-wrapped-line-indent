import { getIndentPrefix, getLineDecorationStyle, getTabReplacementWidth } from './cm6IndentPlugin';

describe('getIndentPrefix', () => {
    it('includes list markers inside block quotes', () => {
        expect(getIndentPrefix('> - quoted item')?.prefix).toBe('> - ');
        expect(getIndentPrefix('> > 12. nested quoted item')?.prefix).toBe('> > 12. ');
        expect(getIndentPrefix('> * [x] quoted task')?.prefix).toBe('> * [x] ');
    });

    it('keeps quote-only prefixes for regular block quote lines', () => {
        expect(getIndentPrefix('> quoted text')?.prefix).toBe('> ');
        expect(getIndentPrefix('> > nested quoted text')?.prefix).toBe('> > ');
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
