/** The right-click edit menu (main process). Deliberately free of any
 *  'electron' import -- not even a type-only one -- so this module can be
 *  imported and executed directly under plain-Node vitest with no stub or
 *  mock in the way (unlike most of src/main, which imports 'electron'
 *  itself and is only ever text/structure-tested as a result -- see
 *  tests/main/lifecycle.test.ts's own note on why). `contextMenuTemplate`
 *  is a pure function: given the same params, it always returns the same
 *  plain data, with no click handler bound to any real webContents baked
 *  in. src/main/index.ts (the only caller) walks this output into a real
 *  Electron menu and supplies the one thing this module cannot: the
 *  window's actual webContents, for the suggestion items' replaceMisspelling
 *  call and the edit-role items' built-in cut/copy/paste/select-all
 *  behaviour (Electron performs those itself once a MenuItem carries the
 *  matching `role` -- no click handler is needed for them either). */

/** The subset of Electron's real ContextMenuParams this module reads.
 *  Electron's own type carries many more fields (x/y, linkURL, mediaType,
 *  frame, ...); the real params object handed to a 'context-menu' listener
 *  is a strict superset of this, so it is passed straight through by every
 *  real caller without needing a conversion step. Kept narrow, and
 *  independent of Electron's own type, so a test can build one with only
 *  the fields this menu actually decides on. */
export interface ContextMenuParamsLike {
  isEditable: boolean;
  selectionText: string;
  misspelledWord: string;
  dictionarySuggestions: string[];
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
}

const MAX_SUGGESTIONS = 5;

/** One entry in the menu this module describes. 'suggestion' carries only
 *  the word itself -- the label IS the replacement text, and it is up to
 *  the caller to turn a click on one into
 *  `webContents.replaceMisspelling(label)`, since this module has no
 *  webContents to call it on. 'role' items map straight onto Electron's own
 *  MenuItem roles, which perform cut/copy/paste/select-all on the focused
 *  element without any click handler of their own. */
export type ContextMenuTemplateItem =
  | { kind: 'suggestion'; label: string }
  | { kind: 'separator' }
  | { kind: 'role'; role: 'cut' | 'copy' | 'paste' | 'selectAll'; label: string; enabled: boolean };

/** Builds the right-click menu for one spot in the window:
 *  - an editable field: up to 5 spelling suggestions (if the click landed
 *    on a misspelled word with any), a separator, then Cut/Copy/Paste/
 *    Select All -- each enabled exactly per params.editFlags;
 *  - non-editable text with a selection: Copy alone;
 *  - anything else: no menu at all (an empty array -- the caller must not
 *    popup() on that). */
export function contextMenuTemplate(params: ContextMenuParamsLike): ContextMenuTemplateItem[] {
  if (params.isEditable) {
    const items: ContextMenuTemplateItem[] = [];
    if (params.misspelledWord !== '' && params.dictionarySuggestions.length > 0) {
      for (const suggestion of params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS)) {
        items.push({ kind: 'suggestion', label: suggestion });
      }
      items.push({ kind: 'separator' });
    }
    items.push(
      { kind: 'role', role: 'cut', label: 'Cut', enabled: params.editFlags.canCut },
      { kind: 'role', role: 'copy', label: 'Copy', enabled: params.editFlags.canCopy },
      { kind: 'role', role: 'paste', label: 'Paste', enabled: params.editFlags.canPaste },
      { kind: 'role', role: 'selectAll', label: 'Select All', enabled: params.editFlags.canSelectAll },
    );
    return items;
  }
  if (params.selectionText !== '') {
    return [{ kind: 'role', role: 'copy', label: 'Copy', enabled: true }];
  }
  return [];
}
