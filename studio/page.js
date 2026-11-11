// What the studio's pages share: an element by id, the toast, a download, and the play button's two states.
export const $ = id => document.getElementById(id);

let toastTimer;
export function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000); }

export function download(data, filename, type) {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// The play button shows what a press does next, and says it for a screen reader.
export function playButton(playing, what = 'animation') { $('play').textContent = playing ? 'Ⅱ' : '▶'; $('play').setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${what}`); }
