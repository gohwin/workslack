// A single grid cell can only ever belong to one across + one down word, so
// a "hub" syllable can host at most 2 words no matter how many words in the
// pool share it -- growth is a chain/tree, one new attachment point at a
// time, and it dies out if word order happens to exhaust nearby options.
// Retrying with many random shuffles of the same pool and keeping the
// largest result compensates for that instead of hand-curating one lucky
// order.
// The live game no longer reads puzzles.json -- it generates a fresh puzzle
// in the browser on every play using the exact same autoPlace()/normalize()
// (see ../script.js). This script is now just an offline way to preview
// what the generator produces without opening a browser.
const fs = require("fs");
const path = require("path");
const { autoPlace, normalize } = require("../auto_crossword.js");
const { COMMON_POOL } = require("../crossword_words.js");

const PUZZLES_JSON_PATH = path.join(__dirname, "preview.json");
const PUZZLE_COUNT = Number(process.argv[2]) || 7;

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// small seeded PRNG (mulberry32) -- only seeds the word-order shuffle below.
// autoPlace() itself now also rolls its own Math.random() when several
// crossings are valid for a word (see auto_crossword.js), so the same seed
// no longer reproduces byte-identical output -- it's just here to vary the
// starting order across the PUZZLE_COUNT loop below.
function makeRng(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mirrors script.js's GEN_MAX_DIM/scoring so this preview matches what the
// live game actually produces (see the "밀도" note in ../README.md #5 --
// scoring by word count alone lets the generator win by sprawling into a
// thin diagonal chain instead of packing tightly).
const TARGET_MAX_DIM = 12;
const MIN_WORDS = 10;

function filledCellCount(puzzle) {
  let count = 0;
  for (const row of puzzle.grid) {
    for (const cell of row) if (cell !== null) count++;
  }
  return count;
}

function buildBest(seedBase, attempts, maxSpan) {
  let best = null;
  let bestScore = -1;
  for (let i = 0; i < attempts; i++) {
    const rng = makeRng(seedBase * 100000 + i);
    const order = shuffle(COMMON_POOL, rng);
    const { placed } = autoPlace(order, maxSpan);
    const puzzle = normalize(seedBase, placed);
    if (Math.max(puzzle.rows, puzzle.cols) > TARGET_MAX_DIM) continue;
    if (puzzle.words.length < MIN_WORDS) continue;
    const density = filledCellCount(puzzle) / (puzzle.rows * puzzle.cols);
    const score = puzzle.words.length * density;
    if (score > bestScore) {
      bestScore = score;
      best = puzzle;
    }
  }
  return best;
}

const out = [];
for (let id = 1; id <= PUZZLE_COUNT; id++) {
  const puzzle = buildBest(id, 600, TARGET_MAX_DIM - 1);
  console.log(`Puzzle ${id}: ${puzzle.rows}x${puzzle.cols}, ${puzzle.words.length} words`);
  out.push(puzzle);
}

fs.writeFileSync(PUZZLES_JSON_PATH, JSON.stringify(out, null, 2));
console.log(`Wrote ${out.length} puzzles to ${PUZZLES_JSON_PATH}`);
