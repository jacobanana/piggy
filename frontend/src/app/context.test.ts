import { beforeEach, describe, expect, it } from 'vitest';
import { session } from './session';
import { blankState } from '../model/state';
import type { AppState } from '../model/types';

/* `context` reaches the storage adapter, and `storage/api.ts` resolves its base
   against `document.baseURI` the moment it loads. Nothing here goes near the
   network, so a stub is all the import graph needs — cheaper than pulling jsdom
   in for one suite, and this directory's tests stay DOM-free. */
(globalThis as unknown as { document: { baseURI: string } }).document = { baseURI: 'http://localhost/' };
/* Read through the namespace, never destructured: `S` is a `let` that
   `replaceState` reassigns, and pulling it out of the module snapshots it. */
const ctx = await import('./context');

/**
 * That replacing the book does not rename it.
 *
 * Worth a test rather than an eye, because the damage is invisible from the
 * screen that caused it. `meta.appName` is not a label the frontend owns: the
 * sync endpoint writes it straight to `Book.name`, so on the self-hosted build
 * it *is* the shared piggy bank's name. Erasing a bank's contents used to
 * rename it to "Piggy" and importing a file used to rename it to whatever the
 * file called itself — for everyone in it, from a button that promised to empty
 * the bank without getting rid of it. The person who tapped it sees a bank full
 * of the right nothing; the person they share with sees their bank gone and a
 * "Piggy" in its place.
 */

/** A whole-app export, as `importJSONFile` would hand it over. */
function exported(appName: string): AppState {
  const s = blankState();
  s.meta.appName = appName;
  s.people = [{ id: 'per_1', name: 'Léa', emoji: '🐰', color: '#5A67E8' }];
  return s;
}

describe('replaceState', () => {
  beforeEach(() => {
    const s = blankState();
    s.meta.appName = "Flavs & Adrien's Piggy";
    ctx.setState(s);
    session.mode = 'server';
    session.book = { id: 'bk_1', name: "Flavs & Adrien's Piggy", role: 'owner', members: 2, owners: 1, personId: null };
  });

  it('keeps the bank name when the book is erased', () => {
    ctx.replaceState(blankState(), true);
    expect(ctx.S.meta.appName).toBe("Flavs & Adrien's Piggy");
    expect(ctx.S.people).toEqual([]);
  });

  it('keeps the bank name when a file is imported into a shared bank', () => {
    ctx.replaceState(exported('Piggy'), true);
    expect(ctx.S.meta.appName).toBe("Flavs & Adrien's Piggy");
    expect(ctx.S.people).toHaveLength(1);
  });

  it('tells the switcher and the share sheet the name that is now in force', () => {
    ctx.replaceState(exported('Piggy'), true);
    expect(session.book?.name).toBe("Flavs & Adrien's Piggy");
  });

  // The Pages build has no shared bank to rename, and there an export is a
  // whole-app backup whose name is part of what is being restored.
  it('takes the file’s name when the name is not being kept', () => {
    ctx.replaceState(exported('Lisbon crew'), false);
    expect(ctx.S.meta.appName).toBe('Lisbon crew');
  });
});
