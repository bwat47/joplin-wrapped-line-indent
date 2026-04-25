import { getIndentPrefix } from './cm6IndentPlugin';

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
