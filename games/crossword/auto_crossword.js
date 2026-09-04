// Given a plain word+clue list (no coordinates), automatically places each
// word onto a grid by attaching it to an already-placed word wherever a
// letter matches, always perpendicular (never two across, or two down,
// words sharing a cell), and verifies the whole thing is internally
// consistent afterward. This replaces hand-computing row/col offsets.
//
// Multiple across words can share a row (same for down words sharing a
// column) as long as there's at least one gap cell between them -- see the
// "breathing room" check in tryPlace(). That's what gives a dense,
// NYT-style grid instead of a sparse "one word per row" staircase.
//
// Loaded two ways: via Node `require()` by tools/build_puzzles.js (offline
// preview/debug), and as a plain <script> tag by index.html, which is how
// the live game itself generates a fresh puzzle on every play. `autoPlace`/
// `normalize` are attached as plain globals for the browser case, matching
// every other script on this site (see script.js's header comment).

// A crossing should read as exactly one shared cell between two words, not a
// solid blob. If every corner of some 2x2 window ends up filled, two words
// that are only supposed to touch at one point visually fuse into a clump
// instead. Standard crossword construction forbids this outright.
function wouldCreate2x2Block(newCells, cellMap) {
  const isFilled = (r, c) => cellMap.has(`${r},${c}`) || newCells.some((cell) => cell.r === r && cell.c === c);
  for (const { r, c } of newCells) {
    const windows = [
      [[r - 1, c - 1], [r - 1, c], [r, c - 1], [r, c]],
      [[r - 1, c], [r - 1, c + 1], [r, c], [r, c + 1]],
      [[r, c - 1], [r, c], [r + 1, c - 1], [r + 1, c]],
      [[r, c], [r, c + 1], [r + 1, c], [r + 1, c + 1]],
    ];
    for (const w of windows) {
      if (w.every(([rr, cc]) => isFilled(rr, cc))) return true;
    }
  }
  return false;
}

function tryPlace(answer, dir, row, col, cellMap, dirUsed) {
  const letters = [...answer];
  const newCells = [];
  for (let i = 0; i < letters.length; i++) {
    const r = dir === "A" ? row : row + i;
    const c = dir === "A" ? col + i : col;
    const key = `${r},${c}`;
    if (cellMap.has(key) && cellMap.get(key) !== letters[i]) return false;
    if (dirUsed.has(`${r},${c},${dir}`)) return false;
    if (!cellMap.has(key)) newCells.push({ r, c });
  }
  // require at least one open cell of "breathing room" on both ends so this
  // word doesn't silently fuse into an adjacent same-direction word with no gap
  const beforeR = dir === "A" ? row : row - 1;
  const beforeC = dir === "A" ? col - 1 : col;
  const afterR = dir === "A" ? row : row + letters.length;
  const afterC = dir === "A" ? col + letters.length : col;
  if (dirUsed.has(`${beforeR},${beforeC},${dir}`)) return false;
  if (dirUsed.has(`${afterR},${afterC},${dir}`)) return false;
  if (wouldCreate2x2Block(newCells, cellMap)) return false;
  return true;
}

function commitPlace(wordObj, cellMap, dirUsed) {
  const letters = [...wordObj.answer];
  for (let i = 0; i < letters.length; i++) {
    const r = wordObj.dir === "A" ? wordObj.row : wordObj.row + i;
    const c = wordObj.dir === "A" ? wordObj.col + i : wordObj.col;
    cellMap.set(`${r},${c}`, letters[i]);
    dirUsed.add(`${r},${c},${wordObj.dir}`);
  }
}

function autoPlace(wordList, maxSpan) {
  const placed = [];
  const skipped = [];
  const cellMap = new Map();
  const dirUsed = new Set();

  const first = wordList[0];
  const firstObj = { ...first, dir: "A", row: 0, col: 0 };
  commitPlace(firstObj, cellMap, dirUsed);
  placed.push(firstObj);

  let remaining = wordList.slice(1);
  let progress = true;
  while (progress && remaining.length) {
    progress = false;
    const stillRemaining = [];
    for (const w of remaining) {
      const letters = [...w.answer];
      // Collect every valid crossing, then pick one at random -- always
      // taking the first match found (oldest placed cell, first matching
      // letter, "across" tried before "down") makes the grid's overall
      // shape converge to the same staircase silhouette run after run,
      // even though the input word order is shuffled. Randomizing *which*
      // valid attachment gets used is what actually varies the layout.
      const candidates = [];
      for (const [key, letter] of cellMap.entries()) {
        const [er, ec] = key.split(",").map(Number);
        for (let li = 0; li < letters.length; li++) {
          if (letters[li] !== letter) continue;
          for (const dir of ["A", "D"]) {
            const row = dir === "A" ? er : er - li;
            const col = dir === "A" ? ec - li : ec;
            if (maxSpan) {
              const endRow = dir === "A" ? row : row + letters.length - 1;
              const endCol = dir === "A" ? col + letters.length - 1 : col;
              if (Math.max(Math.abs(row), Math.abs(endRow), Math.abs(col), Math.abs(endCol)) > maxSpan) continue;
            }
            if (tryPlace(w.answer, dir, row, col, cellMap, dirUsed)) {
              candidates.push({ dir, row, col });
            }
          }
        }
      }
      let placedThis = false;
      if (candidates.length) {
        const choice = candidates[Math.floor(Math.random() * candidates.length)];
        const wordObj = { ...w, ...choice };
        commitPlace(wordObj, cellMap, dirUsed);
        placed.push(wordObj);
        placedThis = true;
        progress = true;
      }
      if (!placedThis) stillRemaining.push(w);
    }
    remaining = stillRemaining;
  }
  for (const w of remaining) skipped.push(w.answer);
  return { placed, skipped, cellMap };
}

function normalize(id, placed) {
  let minR = Infinity, minC = Infinity, maxR = -Infinity, maxC = -Infinity;
  const cellMap = new Map();
  for (const w of placed) {
    const letters = [...w.answer];
    for (let i = 0; i < letters.length; i++) {
      const r = w.dir === "A" ? w.row : w.row + i;
      const c = w.dir === "A" ? w.col + i : w.col;
      cellMap.set(`${r},${c}`, letters[i]);
      minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      minC = Math.min(minC, c); maxC = Math.max(maxC, c);
    }
  }
  const rows = maxR - minR + 1;
  const cols = maxC - minC + 1;
  const grid = Array.from({ length: rows }, () => Array(cols).fill(null));
  for (const [key, letter] of cellMap.entries()) {
    const [r, c] = key.split(",").map(Number);
    grid[r - minR][c - minC] = letter;
  }
  const shiftedWords = placed.map((w) => ({ ...w, row: w.row - minR, col: w.col - minC }));

  for (const w of shiftedWords) {
    const letters = [...w.answer];
    for (let i = 0; i < letters.length; i++) {
      const r = w.dir === "A" ? w.row : w.row + i;
      const c = w.dir === "A" ? w.col + i : w.col;
      if (grid[r][c] !== letters[i]) throw new Error(`readback mismatch for "${w.answer}" at ${r},${c}`);
    }
  }

  const startCells = new Set();
  for (const w of shiftedWords) startCells.add(`${w.row},${w.col}`);
  const orderedStarts = [...startCells].map((k) => k.split(",").map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const numberOf = new Map();
  orderedStarts.forEach(([r, c], i) => numberOf.set(`${r},${c}`, i + 1));

  const clues = shiftedWords.map((w) => ({
    number: numberOf.get(`${w.row},${w.col}`),
    direction: w.dir === "A" ? "across" : "down",
    answer: w.answer,
    clue: w.clue,
    row: w.row,
    col: w.col,
  }));

  return { id, rows, cols, grid, words: clues };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { autoPlace, normalize };
}
if (typeof window !== "undefined") {
  window.autoPlace = autoPlace;
  window.normalize = normalize;
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  const fs = require("fs");
  const { PUZZLE_SOURCES } = require("./crossword_words.js");
  const out = [];
  for (const src of PUZZLE_SOURCES) {
    const { placed, skipped } = autoPlace(src.words, 9);
    if (skipped.length) console.log(`Puzzle ${src.id}: could not place ${skipped.length}: ${skipped.join(", ")}`);
    const puzzle = normalize(src.id, placed);
    console.log(`Puzzle ${src.id}: ${puzzle.rows}x${puzzle.cols}, ${puzzle.words.length} words`);
    for (let r = 0; r < puzzle.rows; r++) console.log(puzzle.grid[r].map((ch) => ch || "■").join(" "));
    console.log("");
    out.push(puzzle);
  }
  fs.writeFileSync("puzzles.json", JSON.stringify(out, null, 2));
  console.log("puzzles.json written.");
}
