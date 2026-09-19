import { describe, it, expect } from 'vitest';
import { contextMenuTemplate, type ContextMenuParamsLike } from '../../src/main/contextMenu.ts';

// A pure function, deliberately free of any 'electron' import (see the
// module's own doc comment) -- these are plain behavioural tests, not the
// text/structure checks the rest of src/main needs once 'electron' is
// involved (see tests/main/lifecycle.test.ts's own note on why).

const editable = (over: Partial<ContextMenuParamsLike> = {}): ContextMenuParamsLike => ({
  isEditable: true,
  selectionText: '',
  misspelledWord: '',
  dictionarySuggestions: [],
  editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
  ...over,
});

describe('contextMenuTemplate', () => {
  describe('an editable field with no misspelling', () => {
    it('offers Cut/Copy/Paste/Select All, no suggestions and no separator', () => {
      const items = contextMenuTemplate(editable());
      expect(items).toEqual([
        { kind: 'role', role: 'cut', label: 'Cut', enabled: true },
        { kind: 'role', role: 'copy', label: 'Copy', enabled: true },
        { kind: 'role', role: 'paste', label: 'Paste', enabled: true },
        { kind: 'role', role: 'selectAll', label: 'Select All', enabled: true },
      ]);
    });

    it('reflects editFlags exactly, per role, when some are disabled', () => {
      const items = contextMenuTemplate(editable({
        editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
      }));
      expect(items).toEqual([
        { kind: 'role', role: 'cut', label: 'Cut', enabled: false },
        { kind: 'role', role: 'copy', label: 'Copy', enabled: true },
        { kind: 'role', role: 'paste', label: 'Paste', enabled: false },
        { kind: 'role', role: 'selectAll', label: 'Select All', enabled: true },
      ]);
    });
  });

  describe('an editable field over a misspelled word', () => {
    it('lists every suggestion (up to 5), then a separator, then the edit roles', () => {
      const items = contextMenuTemplate(editable({
        misspelledWord: 'teh', dictionarySuggestions: ['the', 'tea', 'ten'],
      }));
      expect(items).toEqual([
        { kind: 'suggestion', label: 'the' },
        { kind: 'suggestion', label: 'tea' },
        { kind: 'suggestion', label: 'ten' },
        { kind: 'separator' },
        { kind: 'role', role: 'cut', label: 'Cut', enabled: true },
        { kind: 'role', role: 'copy', label: 'Copy', enabled: true },
        { kind: 'role', role: 'paste', label: 'Paste', enabled: true },
        { kind: 'role', role: 'selectAll', label: 'Select All', enabled: true },
      ]);
    });

    it('caps suggestions at 5, dropping the rest', () => {
      const items = contextMenuTemplate(editable({
        misspelledWord: 'teh',
        dictionarySuggestions: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      }));
      const suggestions = items.filter(i => i.kind === 'suggestion');
      expect(suggestions).toEqual([
        { kind: 'suggestion', label: 'a' }, { kind: 'suggestion', label: 'b' },
        { kind: 'suggestion', label: 'c' }, { kind: 'suggestion', label: 'd' },
        { kind: 'suggestion', label: 'e' },
      ]);
      // Exactly one separator, right after the (capped) suggestion list.
      expect(items[5]).toEqual({ kind: 'separator' });
    });

    it('adds no suggestions or separator when the suggestion list is empty', () => {
      const items = contextMenuTemplate(editable({ misspelledWord: 'teh', dictionarySuggestions: [] }));
      expect(items.some(i => i.kind === 'suggestion' || i.kind === 'separator')).toBe(false);
      expect(items).toHaveLength(4);
    });

    it('adds no suggestions when misspelledWord is empty, even if suggestions were somehow supplied', () => {
      const items = contextMenuTemplate(editable({ misspelledWord: '', dictionarySuggestions: ['the'] }));
      expect(items.some(i => i.kind === 'suggestion' || i.kind === 'separator')).toBe(false);
      expect(items).toHaveLength(4);
    });
  });

  describe('a non-editable selection', () => {
    it('offers Copy only when there is selected text', () => {
      const items = contextMenuTemplate({
        isEditable: false, selectionText: 'hello', misspelledWord: '', dictionarySuggestions: [],
        editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: false },
      });
      expect(items).toEqual([{ kind: 'role', role: 'copy', label: 'Copy', enabled: true }]);
    });
  });

  describe('neither editable nor selected', () => {
    it('builds no menu at all', () => {
      const items = contextMenuTemplate({
        isEditable: false, selectionText: '', misspelledWord: '', dictionarySuggestions: [],
        editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
      });
      expect(items).toEqual([]);
    });
  });

  it('is pure: the same input twice yields equal, independently-built output', () => {
    const params = editable({ misspelledWord: 'teh', dictionarySuggestions: ['the'] });
    const a = contextMenuTemplate(params);
    const b = contextMenuTemplate(params);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    // Never mutates the caller's arrays/objects.
    expect(params.dictionarySuggestions).toEqual(['the']);
  });
});
