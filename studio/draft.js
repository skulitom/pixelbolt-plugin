// Keeps unsaved recipes in the browser's own storage, so a closed tab or a crash does not lose them. Nothing is sent to
// the server. Browser storage belongs to the studio's address: a draft is found again on the same port only.
// Each tab keeps its draft under its own id, so one tab never replaces or removes another tab's draft.
export const DRAFT_KEY = 'pixelforge.studio.draft.v1';
// The tab's id lives in sessionStorage, which a reload keeps and every other tab has its own copy of.
export const TAB_KEY = 'pixelforge.studio.tab';
// An open tab holds a Web Lock named after its id; the browser lets go of it when the tab closes or crashes.
const LOCK = 'pixelforge.studio.tab.';
const valid = draft => draft && typeof draft.text === 'string' && typeof draft.name === 'string' && Number.isFinite(draft.savedAt);

export function createDraftStore(storage, { id = null, key = DRAFT_KEY, now = () => Date.now() } = {}) {
  // Drafts from before tabs had ids sit at `key` itself, as if from a tab with no id.
  const slot = tab => tab === null ? key : `${key}.${tab}`, own = slot(id);
  const read = name => {
    try { const draft = JSON.parse(storage.getItem(name)); return valid(draft) ? { text: draft.text, name: draft.name, savedAt: draft.savedAt } : null; } catch { return null; }
  };
  return {
    id,
    // This tab's draft as { text, name, savedAt }, or null when there is none or it cannot be read.
    load: () => read(own),
    // False when the browser refuses (storage is off, blocked or full); an earlier draft is then left as it was.
    save(text, name) { try { storage.setItem(own, JSON.stringify({ text, name, savedAt: now() })); return true; } catch { return false; } },
    // Removes this tab's draft only.
    clear() { try { storage.removeItem(own); } catch { /* nothing was stored */ } },
    // Drafts other tabs kept, newest first, as { text, name, savedAt, id }, leaving out the tabs in `open`.
    others(open = new Set()) {
      const found = [];
      try {
        for (let i = 0; i < storage.length; i++) {
          const name = storage.key(i), tab = name === key ? null : name?.startsWith(`${key}.`) ? name.slice(key.length + 1) : undefined;
          if (tab === undefined || name === own || open.has(tab)) continue;
          const draft = read(name); if (draft) found.push({ ...draft, id: tab });
        }
      } catch { /* storage is off */ }
      return found.sort((a, b) => b.savedAt - a.savedAt);
    },
    // Removes another tab's draft, once the user discarded it or this tab took it over.
    forget(tab) { try { storage.removeItem(slot(tab)); } catch { /* nothing was stored */ } }
  };
}
// Holds the lock on a tab id for as long as this page is open. False when another page holds it: at once with no
// `wait`, or after `wait` ms, which gives the page a reload replaces time to let go.
function hold(locks, id, wait) {
  return new Promise(resolve => {
    const giveUp = new AbortController(), timer = wait > 0 ? setTimeout(() => giveUp.abort(), wait) : null;
    const done = held => { clearTimeout(timer); resolve(held); };
    try { locks.request(LOCK + id, wait > 0 ? { signal: giveUp.signal } : { ifAvailable: true }, lock => { done(Boolean(lock)); return lock ? new Promise(() => {}) : undefined; }).catch(() => done(false)); }
    catch { done(false); }
  });
}
// This tab's id. A reload keeps it, so the tab finds its own draft again. A duplicated tab starts with a copy of the
// original's sessionStorage; the original still holds the lock, so the copy takes a new id. Without session storage
// the id lasts as long as the page, and a reloaded page finds its draft among those of closed tabs.
export async function claimTab(session, locks, { newId = () => crypto.randomUUID(), wait = 1000 } = {}) {
  let id = null;
  try { id = session.getItem(TAB_KEY); } catch { /* no session storage */ }
  if (id && (!locks || await hold(locks, id, wait))) return id;
  id = newId();
  try { session.setItem(TAB_KEY, id); } catch { /* the id lasts as long as this page */ }
  if (locks) await hold(locks, id, 0);
  return id;
}
// The ids of the tabs that are open now. Without Web Locks no tab can be told apart, and none count as open.
export async function openTabs(locks) {
  try { return new Set((await locks.query()).held.map(lock => lock.name).filter(name => name?.startsWith(LOCK)).map(name => name.slice(LOCK.length))); }
  catch { return new Set(); }
}
