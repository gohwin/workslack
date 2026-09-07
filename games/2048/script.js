// Login/signup/logout and the shared `currentUser` state live in the
// site-wide ../../auth.js (loaded via a <script> tag before this file), same
// pattern as every other game here.

const SIZE = 4;
const STORAGE_KEY = "2048-best-score";
// The Firestore rule for crossword-users/{uid}/history caps a single write's
// `points` at 1000 (see ../crossword/README.md) -- raw 2048 scores from a
// long game can run into the tens of thousands, so we scale them down and
// hard-clamp well under that ceiling instead of asking for another console
// rule edit every time a new game's scoring shape shows up.
const SCORE_TO_POINTS_DIVISOR = 20;
const MAX_POINTS = 900;

let grid = createGrid();
let score = 0;
let bestScore = loadBestScore();
let won = false;
let gameOverFlag = false;
let touchStartX = 0;
let touchStartY = 0;

const boardEl = document.getElementById("board");
const scoreLabelEl = document.getElementById("score-label");
const bestLabelEl = document.getElementById("best-label");
const winBannerEl = document.getElementById("win-banner");
const resultOverlayEl = document.getElementById("result-overlay");
const resultScoreEl = document.getElementById("result-score");
const resultPointsEl = document.getElementById("result-points");

function createGrid() {
  return Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
}

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

function emptyCells(g) {
  const cells = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (g[r][c] === 0) cells.push([r, c]);
    }
  }
  return cells;
}

function spawnTile(g) {
  const empties = emptyCells(g);
  if (!empties.length) return false;
  const [r, c] = empties[Math.floor(Math.random() * empties.length)];
  g[r][c] = Math.random() < 0.9 ? 2 : 4;
  return true;
}

function gridsEqual(a, b) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (a[r][c] !== b[r][c]) return false;
    }
  }
  return true;
}

function transpose(g) {
  return g[0].map((_, c) => g.map((row) => row[c]));
}

function reverseRows(g) {
  return g.map((row) => [...row].reverse());
}

// Classic slide-left-and-merge for one row. Each tile merges at most once
// per move (the splice shrinks the array so an already-merged tile is never
// re-examined against its new neighbor in the same pass).
function slideRowLeft(row) {
  const arr = row.filter((v) => v !== 0);
  let gained = 0;
  for (let i = 0; i < arr.length - 1; i++) {
    if (arr[i] === arr[i + 1]) {
      arr[i] *= 2;
      gained += arr[i];
      arr.splice(i + 1, 1);
    }
  }
  while (arr.length < SIZE) arr.push(0);
  return { row: arr, gained };
}

function slideLeft(g) {
  let gained = 0;
  const newGrid = g.map((row) => {
    const { row: newRow, gained: rowGained } = slideRowLeft(row);
    gained += rowGained;
    return newRow;
  });
  return { grid: newGrid, gained };
}

function hasMovesLeft(g) {
  if (emptyCells(g).length > 0) return true;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = g[r][c];
      if (c < SIZE - 1 && g[r][c + 1] === v) return true;
      if (r < SIZE - 1 && g[r + 1][c] === v) return true;
    }
  }
  return false;
}

function buildBoardDom() {
  boardEl.innerHTML = "";
  for (let i = 0; i < SIZE * SIZE; i++) {
    const cell = document.createElement("div");
    cell.className = "cell";
    boardEl.appendChild(cell);
  }
}

function render() {
  scoreLabelEl.textContent = `점수 ${score}`;
  bestLabelEl.textContent = `최고 ${Math.max(bestScore, score)}`;
  const cells = boardEl.children;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const val = grid[r][c];
      const cell = cells[r * SIZE + c];
      cell.textContent = val === 0 ? "" : String(val);
      cell.className = "cell" + (val ? ` val-${val <= 2048 ? val : "max"}` : "");
    }
  }
}

function move(direction) {
  if (gameOverFlag) return;
  let working = grid;

  if (direction === "up") working = transpose(working);
  else if (direction === "down") working = reverseRows(transpose(working));
  else if (direction === "right") working = reverseRows(working);

  const { grid: slid, gained } = slideLeft(working);

  let result = slid;
  if (direction === "up") result = transpose(result);
  else if (direction === "down") result = transpose(reverseRows(result));
  else if (direction === "right") result = reverseRows(result);

  if (gridsEqual(result, grid)) return;

  grid = result;
  score += gained;
  spawnTile(grid);
  render();

  if (!won && grid.some((row) => row.includes(2048))) {
    won = true;
    winBannerEl.hidden = false;
  }

  if (!hasMovesLeft(grid)) {
    endGame();
  }
}

async function endGame() {
  gameOverFlag = true;
  saveBestScoreIfHigher(score);
  render();

  resultOverlayEl.hidden = false;
  resultScoreEl.textContent = `최종 점수 ${score}`;
  resultPointsEl.textContent = currentUser ? "" : "로그인하면 점수가 쌓여요.";

  const points = Math.min(MAX_POINTS, Math.floor(score / SCORE_TO_POINTS_DIVISOR));
  if (points > 0 && typeof awardPoints === "function") {
    const awarded = await awardPoints(points, "2048", "2048");
    if (awarded) resultPointsEl.textContent = `+${points}점 적립!`;
  }
}

function startNewGame() {
  grid = createGrid();
  score = 0;
  won = false;
  gameOverFlag = false;
  winBannerEl.hidden = true;
  resultOverlayEl.hidden = true;
  spawnTile(grid);
  spawnTile(grid);
  render();
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

document.getElementById("new-game-btn").addEventListener("click", startNewGame);
document.getElementById("result-close-btn").addEventListener("click", startNewGame);
document.getElementById("win-continue-btn").addEventListener("click", () => {
  winBannerEl.hidden = true;
});
document.getElementById("win-restart-btn").addEventListener("click", startNewGame);

buildBoardDom();
startNewGame();
