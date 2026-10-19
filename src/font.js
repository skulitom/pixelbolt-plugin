// Browser-compatible built-in pixel font for the `text` drawing operation: printable ASCII, the accented letters of
// western European languages and common typographic symbols. Capitals are 7 pixels tall, lowercase 5, descenders 1
// below the baseline, so a line is 8 rows; the accent of a capital sits in the 2 rows above it. Letters and
// punctuation are as wide as their ink (1 to 7 pixels: only © ® — Œ œ are wider than 5); digits are all 5 wide so that counters and timers do not
// jitter. The ASCII letter, digit and basic punctuation shapes come from the Tidewatch showcase font; all of it is
// original Pixelbolt artwork.
const SHAPES = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#', B: '####.|#...#|#...#|####.|#...#|#...#|####.', C: '.###.|#...#|#....|#....|#....|#...#|.###.',
  D: '####.|#...#|#...#|#...#|#...#|#...#|####.', E: '#####|#....|#....|####.|#....|#....|#####', F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.###.|#...#|#....|#.###|#...#|#...#|.####', H: '#...#|#...#|#...#|#####|#...#|#...#|#...#', I: '.###.|..#..|..#..|..#..|..#..|..#..|.###.',
  J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..', K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', N: '#...#|##..#|#.#.#|#..##|#...#|#...#|#...#', O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  P: '####.|#...#|#...#|####.|#....|#....|#....', Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#', R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.###.|#...#|#....|.###.|....#|#...#|.###.', T: '#####|..#..|..#..|..#..|..#..|..#..|..#..', U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..', W: '#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#', X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..', Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  a: '.....|.....|.###.|....#|.####|#...#|.####', b: '#....|#....|####.|#...#|#...#|#...#|####.', c: '.....|.....|.###.|#....|#....|#...#|.###.',
  d: '....#|....#|.####|#...#|#...#|#...#|.####', e: '.....|.....|.###.|#...#|#####|#....|.###.', f: '..##.|.#...|####.|.#...|.#...|.#...|.#...',
  g: '.....|.....|.####|#...#|#...#|.####|....#|.###.', h: '#....|#....|####.|#...#|#...#|#...#|#...#', i: '..#..|.....|.##..|..#..|..#..|..#..|.###.',
  j: '...#.|.....|..##.|...#.|...#.|...#.|#..#.|.##..', k: '#....|#....|#..#.|#.#..|##...|#.#..|#..#.', l: '.##..|..#..|..#..|..#..|..#..|..#..|.###.',
  m: '.....|.....|##.#.|#.#.#|#.#.#|#.#.#|#...#', n: '.....|.....|####.|#...#|#...#|#...#|#...#', o: '.....|.....|.###.|#...#|#...#|#...#|.###.',
  p: '.....|.....|####.|#...#|#...#|####.|#....|#....', q: '.....|.....|.####|#...#|#...#|.####|....#|....#', r: '.....|.....|#.##.|##..#|#....|#....|#....',
  s: '.....|.....|.####|#....|.###.|....#|####.', t: '.#...|.#...|####.|.#...|.#...|.#..#|..##.', u: '.....|.....|#...#|#...#|#...#|#..##|.##.#',
  v: '.....|.....|#...#|#...#|#...#|.#.#.|..#..', w: '.....|.....|#...#|#...#|#.#.#|#.#.#|.#.#.', x: '.....|.....|#...#|.#.#.|..#..|.#.#.|#...#',
  y: '.....|.....|#...#|#...#|#...#|.####|....#|.###.', z: '.....|.....|#####|...#.|..#..|.#...|#####',
  0: '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.', 1: '..#..|.##..|..#..|..#..|..#..|..#..|.###.', 2: '.###.|#...#|....#|...#.|..#..|.#...|#####',
  3: '#####|...#.|..#..|...#.|....#|#...#|.###.', 4: '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.', 5: '#####|#....|####.|....#|....#|#...#|.###.',
  6: '..##.|.#...|#....|####.|#...#|#...#|.###.', 7: '#####|....#|...#.|..#..|.#...|.#...|.#...', 8: '.###.|#...#|#...#|.###.|#...#|#...#|.###.',
  9: '.###.|#...#|#...#|.####|....#|...#.|.##..',
  '.': '.|.|.|.|.|.|#', ',': '..|..|..|..|..|.#|.#|#.', '!': '#|#|#|#|#|.|#', '?': '.###.|#...#|....#|...#.|..#..|.....|..#..',
  "'": '#|#|.', '-': '....|....|....|####|....|....|....', ':': '.|.|#|.|.|#|.', ';': '..|..|.#|..|..|.#|.#|#.',
  '(': '.#|#.|#.|#.|#.|#.|.#', ')': '#.|.#|.#|.#|.#|.#|#.', '/': '....#|...#.|...#.|..#..|.#...|.#...|#....', '"': '#.#|#.#|...',
  '+': '.....|.....|..#..|.###.|..#..|.....|.....', '*': '.....|#.#.#|.###.|#####|.###.|#.#.#|.....',
  '#': '.#.#.|.#.#.|#####|.#.#.|#####|.#.#.|.#.#.', $: '..#..|.####|#.#..|.###.|..#.#|####.|..#..', '%': '##..#|##.#.|...#.|..#..|.#...|.#.##|#..##',
  '&': '.##..|#..#.|#.#..|.#...|#.#.#|#..#.|.##.#', '<': '...#|..#.|.#..|#...|.#..|..#.|...#', '=': '....|....|####|....|####|....|....',
  '>': '#...|.#..|..#.|...#|..#.|.#..|#...', '@': '.###.|#...#|#.###|#.#.#|#.###|#....|.###.', '[': '##|#.|#.|#.|#.|#.|##',
  '\\': '#....|.#...|.#...|..#..|...#.|...#.|....#', ']': '##|.#|.#|.#|.#|.#|##', '^': '.#.|#.#|...', _: '....|....|....|....|....|....|....|####',
  '`': '#.|.#|..', '{': '..#|.#.|.#.|#..|.#.|.#.|..#', '|': '#|#|#|#|#|#|#', '}': '#..|.#.|.#.|..#|.#.|.#.|#..', '~': '.....|.....|.##.#|#.##.|.....|.....|.....',
  // Letters that are not a base letter and a mark, and symbols.
  ß: '.##..|#..#.|#..#.|#.#..|#..#.|#..#.|#.#..', Æ: '.####|#.#..|#.#..|####.|#.#..|#.#..|#.###', æ: '.....|.....|##.#.|..#.#|.####|#.#..|.#.##',
  Ø: '.###.|#..##|#.#.#|#.#.#|#.#.#|##..#|.###.', ø: '.....|.....|.###.|#..##|#.#.#|##..#|.###.', Ð: '####.|.#..#|.#..#|###.#|.#..#|.#..#|####.',
  ð: '.#.#.|..#..|.#.#.|.####|#...#|#...#|.###.', Þ: '#....|####.|#...#|#...#|####.|#....|#....', þ: '#....|#....|####.|#...#|#...#|####.|#....|#....',
  å: '.###.|.#.#.|.###.|....#|.####|#...#|.####', ı: '.....|.....|.##..|..#..|..#..|..#..|.###.',
  Œ: '.######|#..#...|#..#...|#..###.|#..#...|#..#...|.######', œ: '.......|.......|.##.##.|#..#..#|#..####|#..#...|.##.###',
  '¡': '#|.|#|#|#|#|#', '¿': '..#..|.....|..#..|.#...|#....|#...#|.###.', '«': '.....|.....|..#.#|.#.#.|#.#..|.#.#.|..#.#', '»': '.....|.....|#.#..|.#.#.|..#.#|.#.#.|#.#..',
  '°': '.#.|#.#|.#.', '©': '.#####.|#.....#|#.###.#|#.#...#|#.###.#|#.....#|.#####.', '®': '.#####.|#.....#|#.##..#|#.#.#.#|#.##..#|#.#.#.#|.#####.',
  '£': '..##.|.#..#|.#...|###..|.#...|.#...|#####', '€': '..###|.#...|####.|.#...|####.|.#...|..###', '¥': '#...#|.#.#.|..#..|#####|..#..|#####|..#..',
  '¢': '.....|..#..|.####|#.#..|#.#..|.####|..#..', '·': '.|.|.|#|.|.|.', '×': '.....|.....|#...#|.#.#.|..#..|.#.#.|#...#', '÷': '.....|..#..|.....|#####|.....|..#..|.....',
  '±': '.....|..#..|.###.|..#..|.....|.###.|.....', '–': '.....|.....|.....|#####|.....|.....|.....', '—': '.......|.......|.......|#######|.......|.......|.......',
  '…': '.....|.....|.....|.....|.....|.....|#.#.#', '‘': '.#|#.|##', '’': '##|.#|#.', '“': '.#..#|#..#.|##.##', '”': '##.##|.#..#|#..#.', '•': '...|...|###|###|###|...|...',
  // Low quotes sit on the baseline and reach one row below it, like a comma.
  '‚': '..|..|..|..|..|##|.#|#.', '„': '.....|.....|.....|.....|.....|##.##|.#..#|#..#.', '‹': '...|...|..#|.#.|#..|.#.|..#', '›': '...|...|#..|.#.|..#|.#.|#..'
};
// Shapes that begin two rows above the capitals.
const TALL = { Å: '..#..|.#.#.|..#..|.#.#.|#...#|#####|#...#|#...#|#...#' };
// Accented letters are a base letter and a mark. On a capital the mark takes the two rows above it; on a small
// letter the two rows above its x-height. A cedilla hangs in the descender row.
const MARKS = { grave: ['#.', '.#'], acute: ['.#', '#.'], circumflex: ['.#.', '#.#'], caron: ['#.#', '.#.'], tilde: ['.#.#', '#.#.'], diaeresis: ['#.#', '...'] };
const ACCENTED = {
  grave: ['ÀA', 'ÈE', 'ÌI', 'ÒO', 'ÙU', 'àa', 'èe', 'ìı', 'òo', 'ùu'], acute: ['ÁA', 'ÉE', 'ÍI', 'ÓO', 'ÚU', 'ÝY', 'áa', 'ée', 'íı', 'óo', 'úu', 'ýy'],
  circumflex: ['ÂA', 'ÊE', 'ÎI', 'ÔO', 'ÛU', 'âa', 'êe', 'îı', 'ôo', 'ûu'], tilde: ['ÃA', 'ÑN', 'ÕO', 'ãa', 'ñn', 'õo'],
  diaeresis: ['ÄA', 'ËE', 'ÏI', 'ÖO', 'ÜU', 'ŸY', 'äa', 'ëe', 'ïı', 'öo', 'üu', 'ÿy'], caron: ['ŠS', 'ŽZ', 'šs', 'žz']
};
export const FONT_HEIGHT = 8, FONT_CAP_HEIGHT = 7, FONT_SPACE = 3, FONT_ABOVE = 2;
const ROWS = FONT_ABOVE + FONT_HEIGHT;
// Every glyph is ROWS strings: the two rows above the capitals, then the eight rows of the line.
const GLYPHS = new Map([[' ', { width: FONT_SPACE, rows: Array(ROWS).fill('.'.repeat(FONT_SPACE)) }]]);
const add = (character, drawn, firstRow) => {
  const full = Math.max(...drawn.map(row => row.length));
  let rows = Array.from({ length: ROWS }, (_, y) => (drawn[y - firstRow] ?? '').padEnd(full, '.'));
  // Trim to the ink, except for digits, which stay tabular.
  if (!/\d/.test(character)) {
    const inked = Array.from({ length: full }, (_, x) => rows.some(row => row[x] === '#')), left = inked.indexOf(true), right = inked.lastIndexOf(true);
    rows = rows.map(row => row.slice(left, right + 1));
  }
  GLYPHS.set(character, { width: rows[0].length, rows });
};
for (const [character, shape] of Object.entries(SHAPES)) add(character, shape.split('|'), FONT_ABOVE);
for (const [character, shape] of Object.entries(TALL)) add(character, shape.split('|'), 0);
const overlay = (base, mark, firstRow) => {
  const rows = base.rows.map(row => [...row]), width = Math.max(base.width, mark[0].length), pad = Math.floor((width - base.width) / 2), start = Math.floor((width - mark[0].length) / 2);
  const wide = rows.map(row => [...'.'.repeat(pad), ...row, ...'.'.repeat(width - base.width - pad)]);
  mark.forEach((line, y) => [...line].forEach((cell, x) => { if (cell === '#') wide[firstRow + y][start + x] = '#'; }));
  return wide.map(row => row.join(''));
};
for (const [mark, pairs] of Object.entries(ACCENTED)) for (const [character, base] of pairs) add(character, overlay(GLYPHS.get(base), MARKS[mark], base === base.toUpperCase() && base !== 'ı' ? 0 : FONT_ABOVE), 0);
for (const [character, base] of ['ÇC', 'çc']) add(character, overlay(GLYPHS.get(base), ['.#.'], ROWS - 1), 0);
GLYPHS.delete('ı');
// Every character the font can draw, in code order.
export const FONT_CHARACTERS = [...GLYPHS.keys()].sort().join('');

// Lays text out as rows of "#" and ".". Lines are split at "\n"; `spacing` is the gap between glyphs, `lineHeight` the
// distance from one line's top to the next, and `align` how shorter lines sit in the block. `top` is where the block
// starts relative to the top of the first line's capitals: 0, or -2 when an accented capital on the first line needs
// the rows above. On later lines those rows are the gap between lines.
// `reject(message)` is called for text the font cannot draw and must throw.
export function layoutText(text, { spacing = 1, lineHeight = 10, align = 'left' } = {}, reject = message => { throw new Error(message); }) {
  // Composed forms, so that "e" followed by a combining accent is the one character "é".
  const lines = text.normalize('NFC').split('\n').map(line => {
    const glyphs = [...line].map(character => GLYPHS.get(character) ?? reject(`no glyph for ${JSON.stringify(character)}; the built-in font draws printable ASCII, western European accented letters (such as é, ñ, ü, ç, ø, ß, œ) and a few symbols (${'¡¿«»‹›°©®£€¥¢·×÷±–—…‘’‚“”„•'})`));
    return { text: line, glyphs, width: glyphs.reduce((sum, glyph) => sum + glyph.width, 0) + spacing * Math.max(0, glyphs.length - 1) };
  });
  // Rows needed above the first line: an accent on a later line only reaches there when lines are closer than 2 rows.
  const above = Math.max(0, ...lines.map((line, index) => line.glyphs.some(glyph => glyph.rows[0].includes('#') || glyph.rows[1].includes('#')) ? FONT_ABOVE - index * lineHeight : 0));
  const width = Math.max(1, ...lines.map(line => line.width)), height = above + (lines.length - 1) * lineHeight + FONT_HEIGHT, cells = Array.from({ length: height }, () => Array(width).fill('.'));
  for (const [index, line] of lines.entries()) {
    let x = align === 'center' ? Math.floor((width - line.width) / 2) : align === 'right' ? width - line.width : 0;
    for (const glyph of line.glyphs) {
      for (let y = 0; y < ROWS; y++) {
        const row = above - FONT_ABOVE + index * lineHeight + y;
        if (row >= 0) for (let i = 0; i < glyph.width; i++) if (glyph.rows[y][i] === '#') cells[row][x + i] = '#';
      }
      x += glyph.width + spacing;
    }
  }
  return { width, height, top: above ? -above : 0, rows: cells.map(row => row.join('')), lines: lines.map(line => ({ text: line.text, width: line.width })) };
}
// The size a text block will have, for placing it: { width, height, top, lines: [{ text, width }] }.
export function measureText(text, options) { const { width, height, top, lines } = layoutText(text, options); return { width, height, top, lines }; }
