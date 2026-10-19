// Keeps one unsaved recipe in the browser's own storage, so a closed tab or a crash does not lose it. Nothing is
// sent to the server. Browser storage belongs to the studio's address: a draft is found again on the same port only.
export const DRAFT_KEY = 'pixelforge.studio.draft.v1';
export function createDraftStore(storage, { key = DRAFT_KEY, now = () => Date.now() } = {}) {
  return {
    // The stored draft as { text, name, savedAt }, or null when there is none or it cannot be read.
    load() {
      try {
        const draft = JSON.parse(storage.getItem(key));
        return draft && typeof draft.text === 'string' && typeof draft.name === 'string' && Number.isFinite(draft.savedAt) ? { text: draft.text, name: draft.name, savedAt: draft.savedAt } : null;
      } catch { return null; }
    },
    // False when the browser refuses (storage is off, blocked or full); an earlier draft is then left as it was.
    save(text, name) { try { storage.setItem(key, JSON.stringify({ text, name, savedAt: now() })); return true; } catch { return false; } },
    clear() { try { storage.removeItem(key); } catch { /* nothing was stored */ } }
  };
}
