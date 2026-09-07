// Login/signup/logout and the shared `currentUser` state live in the
// site-wide ../../auth.js (loaded via a <script> tag before this file), same
// pattern as every other game here.

// Tiles are tracked as identity objects ({id, r, c, value}), not just a
// plain value grid, so a move can animate: update each tile's r/c, let the
// CSS transition slide it there, then -- once the slide finishes -- resolve
// merges (remove the "losing" tile, double the "winning" one) and spawn the
// new tile. A plain grid can't drive this because it has no notion of
// "this specific tile moved from A to B."
const SIZE = 4;
const GAP = 10; // px, must match .tile-layer/.board-2048 CSS
const SLIDE_MS = 130; // must stay >= the CSS transition duration on .tile

const STORAGE_KEY = "2048-best-score";
// The Firestore rule for crossword-users/{uid}/history caps a single write's
// `points` at 1000 (see ../crossword/README.md) -- raw 2048 scores from a
// long game can run into the tens of thousands, so we scale them down and
// hard-clamp well under that ceiling instead of asking for another console
// rule edit every time a new game's scoring shape shows up.
const SCORE_TO_POINTS_DIVISOR = 20;
const MAX_POINTS = 900;

// Points are paused site-wide while more games get added, so nobody has to
// re-tune every game's point scale each time a new one shows up. Flip this
// back to true (same everywhere else this flag appears) to resume scoring.
const POINTS_ENABLED = false;

// Each of these gets its own one-time banner the first time a tile of that
// value appears, not just 2048 -- reaching 4096/8192 is a real milestone in
// its own right and shouldn't go unremarked just because the game already
// congratulated you once.
const MILESTONES = [2048, 4096, 8192, 16384, 32768];

let tiles = []; // { id, r, c, value }
let tileElements = new Map(); // id -> DOM element
let nextTileId = 1;
let cellSize = 0;
let score = 0;
let bestScore = loadBestScore();
let announcedMilestones = new Set();
let gameOverFlag = false;
let animating = false;
let touchStartX = 0;
let touchStartY = 0;

const boardEl = document.getElementById("board");
const tileLayerEl = document.getElementById("tile-layer");
const scoreLabelEl = document.getElementById("score-label");
const bestLabelEl = document.getElementById("best-label");
const winBannerEl = document.getElementById("win-banner");
const winBannerTextEl = document.getElementById("win-banner-text");
const resultOverlayEl = document.getElementById("result-overlay");
const resultScoreEl = document.getElementById("result-score");
const resultPointsEl = document.getElementById("result-points");

function loadBestScore() {
  try {
    return Number(localStorage.getItem(STORAGE_KEY)) || 0;
  } catch {
    return 0;
  }
}

function saveBestScoreIfHigher(value) {
  try {
    if (value > bestScore) {
      bestScore = value;
      localStorage.setItem(STORAGE_KEY, String(bestScore));
    }
  } catch {
    // localStorage unavailable; ignore
  }
}

function buildBackgroundCells() {
  boardEl.querySelectorAll(".cell").forEach((el) => el.remove());
  for (let i = 0; i < SIZE * SIZE; i++) {
    const cell = document.createElement("div");
    cell.className = "cell";
    boardEl.insertBefore(cell, tileLayerEl);
  }
}

function applyCellSize() {
  const w = tileLayerEl.clientWidth;
  cellSize = (w - GAP * (SIZE - 1)) / SIZE;
}

function positionTileEl(el, tile) {
  el.style.width = `${cellSize}px`;
  el.style.height = `${cellSize}px`;
  el.style.left = `${tile.c * (cellSize + GAP)}px`;
  el.style.top = `${tile.r * (cellSize + GAP)}px`;
}

function ensureTileElement(tile) {
  let el = tileElements.get(tile.id);
  if (!el) {
    el = document.createElement("div");
    el.className = "tile spawning";
    el.addEventListener(
      "animationend",
      () => el.classList.remove("spawning", "merging"),
      { once: true }
    );
    tileLayerEl.appendChild(el);
    tileElements.set(tile.id, el);
  }
  return el;
}

function renderTileVisual(tile) {
  const el = tileElements.get(tile.id);
  if (!el) return;
  el.textContent = String(tile.value);
  for (const c of [...el.classList]) {
    if (c.startsWith("val-")) el.classList.remove(c);
  }
  el.classList.add(tile.value <= 2048 ? `val-${tile.value}` : "val-max");
}

function removeTile(id) {
  const el = tileElements.get(id);
  if (el) el.remove();
  tileElements.delete(id);
  tiles = tiles.filter((t) => t.id !== id);
}

function syncTilePositions() {
  for (const t of tiles) {
    const el = ensureTileElement(t);
    positionTileEl(el, t);
  }
}

function emptyCellList() {
  const empties = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!tiles.some((t) => t.r === r && t.c === c)) empties.push({ r, c });
    }
  }
  return empties;
}

function spawnTile() {
  const empties = emptyCellList();
  if (!empties.length) return null;
  const { r, c } = empties[Math.floor(Math.random() * empties.length)];
  const tile = { id: nextTileId++, r, c, value: Math.random() < 0.9 ? 2 : 4 };
  tiles.push(tile);
  const el = ensureTileElement(tile);
  positionTileEl(el, tile);
  renderTileVisual(tile);
  return tile;
}

function buildValueGrid() {
  const g = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
  for (const t of tiles) g[t.r][t.c] = t.value;
  return g;
}

function hasMovesLeft(g) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (g[r][c] === 0) return true;
    }
  }
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = g[r][c];
      if (c < SIZE - 1 && g[r][c + 1] === v) return true;
      if (r < SIZE - 1 && g[r + 1][c] === v) return true;
    }
  }
  return false;
}

function updateHud() {
  scoreLabelEl.textContent = `점수 ${score}`;
  bestLabelEl.textContent = `최고 ${Math.max(bestScore, score)}`;
}

// Tiles along the line the move direction slides toward, ordered from the
// leading edge outward (so index 0 in the returned list is the one closest
// to where everything piles up).
function getLineTiles(direction, index) {
  if (direction === "left") return tiles.filter((t) => t.r === index).sort((a, b) => a.c - b.c);
  if (direction === "right") return tiles.filter((t) => t.r === index).sort((a, b) => b.c - a.c);
  if (direction === "up") return tiles.filter((t) => t.c === index).sort((a, b) => a.r - b.r);
  return tiles.filter((t) => t.c === index).sort((a, b) => b.r - a.r); // down
}

function lineCoord(direction, index, pos) {
  if (direction === "left") return { r: index, c: pos };
  if (direction === "right") return { r: index, c: SIZE - 1 - pos };
  if (direction === "up") return { r: pos, c: index };
  return { r: SIZE - 1 - pos, c: index }; // down
}

function move(direction) {
  if (gameOverFlag || animating) return;

  let anyMoved = false;
  const merges = []; // { primary, secondary, newValue }

  for (let index = 0; index < SIZE; index++) {
    const lineTiles = getLineTiles(direction, index);
    let pos = 0;
    let i = 0;
    while (i < lineTiles.length) {
      const cur = lineTiles[i];
      const nxt = lineTiles[i + 1];
      const { r, c } = lineCoord(direction, index, pos);
      if (nxt && nxt.value === cur.value) {
        if (cur.r !== r || cur.c !== c) anyMoved = true;
        if (nxt.r !== r || nxt.c !== c) anyMoved = true;
        cur.r = r;
        cur.c = c;
        nxt.r = r;
        nxt.c = c;
        merges.push({ primary: cur, secondary: nxt, newValue: cur.value * 2 });
        i += 2;
      } else {
        if (cur.r !== r || cur.c !== c) anyMoved = true;
        cur.r = r;
        cur.c = c;
        i += 1;
      }
      pos++;
    }
  }

  if (!anyMoved) return;

  animating = true;
  syncTilePositions(); // triggers the CSS slide transition toward the new r/c

  setTimeout(() => {
    let gained = 0;
    for (const m of merges) {
      gained += m.newValue;
      removeTile(m.secondary.id);
      m.primary.value = m.newValue;
      renderTileVisual(m.primary);
      const el = tileElements.get(m.primary.id);
      if (el) el.classList.add("merging");
    }
    score += gained;
    spawnTile();
    updateHud();
    animating = false;

    for (const milestone of MILESTONES) {
      if (!announcedMilestones.has(milestone) && tiles.some((t) => t.value === milestone)) {
        announcedMilestones.add(milestone);
        winBannerTextEl.textContent = `🎉 ${milestone} 타일을 만들었어요!`;
        winBannerEl.hidden = false;
        break; // one banner at a time -- any further milestone already on the board gets caught on the next move
      }
    }
    if (!hasMovesLeft(buildValueGrid())) {
      endGame();
    }
  }, SLIDE_MS);
}

async function endGame() {
  gameOverFlag = true;
  saveBestScoreIfHigher(score);
  updateHud();

  resultOverlayEl.hidden = false;
  resultScoreEl.textContent = `최종 점수 ${score}`;
  resultPointsEl.textContent = "";
  if (!POINTS_ENABLED) return;

  resultPointsEl.textContent = currentUser ? "" : "로그인하면 점수가 쌓여요.";
  const points = Math.min(MAX_POINTS, Math.floor(score / SCORE_TO_POINTS_DIVISOR));
  if (points > 0 && typeof awardPoints === "function") {
    const awarded = await awardPoints(points, "2048", "2048");
    if (awarded) resultPointsEl.textContent = `+${points}점 적립!`;
  }
}

function startNewGame() {
  tileElements.forEach((el) => el.remove());
  tileElements.clear();
  tiles = [];
  nextTileId = 1;
  score = 0;
  announcedMilestones = new Set();
  gameOverFlag = false;
  animating = false;
  winBannerEl.hidden = true;
  resultOverlayEl.hidden = true;

  applyCellSize();
  spawnTile();
  spawnTile();
  updateHud();
}

document.addEventListener("keydown", (e) => {
  const map = {
    ArrowLeft: "left", a: "left", A: "left",
    ArrowRight: "right", d: "right", D: "right",
    ArrowUp: "up", w: "up", W: "up",
    ArrowDown: "down", s: "down", S: "down",
  };
  const dir = map[e.key];
  if (!dir) return;
  e.preventDefault();
  move(dir);
});

boardEl.addEventListener(
  "touchstart",
  (e) => {
    const t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
  },
  { passive: true }
);

boardEl.addEventListener(
  "touchend",
  (e) => {
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? "right" : "left");
    else move(dy > 0 ? "down" : "up");
  },
  { passive: true }
);

window.addEventListener("resize", () => {
  applyCellSize();
  for (const t of tiles) positionTileEl(tileElements.get(t.id), t);
});

document.getElementById("new-game-btn").addEventListener("click", startNewGame);
document.getElementById("result-close-btn").addEventListener("click", startNewGame);
document.getElementById("win-continue-btn").addEventListener("click", () => {
  winBannerEl.hidden = true;
});
document.getElementById("win-restart-btn").addEventListener("click", startNewGame);

buildBackgroundCells();
startNewGame();
