const DIFFICULTIES = {
  easy: { label: "쉬움", rows: 9, cols: 9, mines: 10, points: 5 },
  medium: { label: "중간", rows: 16, cols: 16, mines: 40, points: 10 },
  hard: { label: "어려움", rows: 16, cols: 30, mines: 99, points: 20 },
};

const STORAGE_KEY = "minesweeper-best-times";

let difficulty = "easy";
let rows = 9;
let cols = 9;
let mineCount = 10;
let cells = [];
let firstClickDone = false;
let gameOver = false;
let won = false;
let flagMode = false;
let revealedCount = 0;
let hitIndex = null;
let startTime = null;
let timerHandle = null;
let elapsedSeconds = 0;

const boardEl = document.getElementById("board");
const boardWrapperEl = document.querySelector(".board-wrapper");
const timerEl = document.getElementById("timer");
const mineCountEl = document.getElementById("mine-count");
const bestTimeEl = document.getElementById("best-time");
const flagModeBtn = document.getElementById("flag-mode-btn");
const difficultyScreen = document.getElementById("difficulty-screen");
const gameScreen = document.getElementById("game-screen");
const resultOverlay = document.getElementById("result-overlay");
const resultTitleEl = document.getElementById("result-title");
const resultTimeEl = document.getElementById("result-time");
const resultPointsEl = document.getElementById("result-points");
const accountHintInlineEl = document.getElementById("account-hint-inline");

function updateAccountHintInline() {
  if (!accountHintInlineEl) return;
  accountHintInlineEl.textContent = "";
  if (currentUser) {
    accountHintInlineEl.textContent = `${currentUser.nickname}님으로 로그인됨 (누적 ${currentUser.totalScore}점)`;
    return;
  }
  accountHintInlineEl.appendChild(document.createTextNode("로그인/회원가입은 "));
  const link = document.createElement("a");
  link.href = "../../index.html";
  link.textContent = "메인 페이지";
  accountHintInlineEl.appendChild(link);
  accountHintInlineEl.appendChild(document.createTextNode(" 상단에서 할 수 있어요. 로그인하면 깰 때마다 점수가 쌓입니다."));
}

// Called by auth.js whenever login state resolves or changes.
function onAccountReady() {
  updateAccountHintInline();
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function neighbors(idx) {
  const r = Math.floor(idx / cols);
  const c = idx % cols;
  const result = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        result.push(nr * cols + nc);
      }
    }
  }
  return result;
}

function placeMines(safeIdx) {
  const safeSet = new Set([safeIdx, ...neighbors(safeIdx)]);
  const candidates = [];
  for (let i = 0; i < cells.length; i++) {
    if (!safeSet.has(i)) candidates.push(i);
  }
  shuffle(candidates);
  for (let i = 0; i < mineCount && i < candidates.length; i++) {
    cells[candidates[i]].mine = true;
  }
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].mine) continue;
    cells[i].adjacent = neighbors(i).filter((n) => cells[n].mine).length;
  }
}

function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const s = (totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function loadBestTimes() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveBestTime(diff, seconds) {
  try {
    const times = loadBestTimes();
    if (!times[diff] || seconds < times[diff]) {
      times[diff] = seconds;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(times));
    }
  } catch {
    // localStorage unavailable; ignore
  }
}

function renderBestTime() {
  const times = loadBestTimes();
  const best = times[difficulty];
  bestTimeEl.textContent = best ? `최고 기록: ${formatTime(best)}` : "";
}

function stopTimer() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

function startTimer() {
  stopTimer();
  startTime = Date.now();
  elapsedSeconds = 0;
  timerEl.textContent = `⏱ ${formatTime(0)}`;
  timerHandle = setInterval(() => {
    elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    timerEl.textContent = `⏱ ${formatTime(elapsedSeconds)}`;
  }, 1000);
}

function updateMineCount() {
  const flagged = cells.filter((c) => c.flagged).length;
  mineCountEl.textContent = `💣 ${mineCount - flagged}`;
}

const DESIRED_CELL_SIZE = 34;
const MIN_CELL_SIZE = 6;

function applyCellSize() {
  const available = boardWrapperEl.clientWidth || window.innerWidth - 32;
  const gap = 1;
  const borderTotal = 4;
  const totalGap = gap * (cols - 1);
  const fitSize = Math.floor((available - totalGap - borderTotal) / cols);
  const size = Math.max(MIN_CELL_SIZE, Math.min(DESIRED_CELL_SIZE, fitSize));
  boardEl.style.setProperty("--cell-size", `${size}px`);
}

function buildBoardDom() {
  boardEl.innerHTML = "";
  boardEl.style.setProperty("--cols", cols);
  applyCellSize();
  for (let i = 0; i < rows * cols; i++) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.index = String(i);
    cell.addEventListener("click", () => onCellClick(i));
    cell.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      onCellFlag(i);
    });
    boardEl.appendChild(cell);
  }
}

function renderCell(idx) {
  const el = boardEl.children[idx];
  const cell = cells[idx];
  el.className = "cell";
  el.textContent = "";

  if (cell.flagged && !cell.revealed) {
    el.classList.add("flagged");
    el.textContent = "🚩";
    return;
  }

  if (!cell.revealed) return;

  el.classList.add("revealed");
  if (cell.mine) {
    el.classList.add("mine");
    if (idx === hitIndex) el.classList.add("mine-hit");
    el.textContent = "💣";
  } else if (cell.adjacent > 0) {
    el.classList.add(`n${cell.adjacent}`);
    el.textContent = String(cell.adjacent);
  }
}

function renderAll() {
  for (let i = 0; i < cells.length; i++) renderCell(i);
}

function revealFlood(startIdx) {
  const stack = [startIdx];
  while (stack.length) {
    const idx = stack.pop();
    const cell = cells[idx];
    if (cell.revealed || cell.flagged) continue;
    cell.revealed = true;
    revealedCount++;
    if (!cell.mine && cell.adjacent === 0) {
      for (const n of neighbors(idx)) {
        if (!cells[n].revealed && !cells[n].flagged) stack.push(n);
      }
    }
  }
}

function onCellFlag(idx) {
  if (gameOver || won) return;
  const cell = cells[idx];
  if (cell.revealed) return;
  cell.flagged = !cell.flagged;
  renderCell(idx);
  updateMineCount();
}

function onCellClick(idx) {
  if (gameOver || won) return;
  const cell = cells[idx];
  if (flagMode) {
    onCellFlag(idx);
    return;
  }
  if (cell.flagged || cell.revealed) return;

  if (!firstClickDone) {
    firstClickDone = true;
    placeMines(idx);
    startTimer();
  }

  revealFlood(idx);

  if (cell.mine) {
    hitIndex = idx;
    loseGame();
    return;
  }

  renderAll();
  checkWin();
}

function loseGame() {
  gameOver = true;
  stopTimer();
  for (const cell of cells) {
    if (cell.mine) cell.revealed = true;
  }
  renderAll();
  showResult(false);
}

function checkWin() {
  const totalSafeCells = rows * cols - mineCount;
  if (revealedCount < totalSafeCells) return;
  won = true;
  gameOver = true;
  stopTimer();
  for (const cell of cells) {
    if (cell.mine) cell.flagged = true;
  }
  renderAll();
  updateMineCount();
  saveBestTime(difficulty, elapsedSeconds);
  renderBestTime();
  showResult(true);
  awardGamePoints();
}

function showResult(isWin) {
  resultTitleEl.textContent = isWin ? "🎉 클리어했습니다!" : "💥 지뢰를 밟았습니다";
  resultTimeEl.textContent = `${DIFFICULTIES[difficulty].label} · ${formatTime(elapsedSeconds)}`;
  resultPointsEl.textContent = "";
  resultOverlay.hidden = false;
}

async function awardGamePoints() {
  if (typeof awardPoints !== "function") return;
  const points = DIFFICULTIES[difficulty].points;
  resultPointsEl.textContent = currentUser ? "" : "로그인하면 점수가 쌓여요.";
  const awarded = await awardPoints(points, "minesweeper", `지뢰찾기 (${DIFFICULTIES[difficulty].label})`);
  if (awarded) resultPointsEl.textContent = `+${points}점 적립!`;
}

function newGame(diff) {
  difficulty = diff;
  const cfg = DIFFICULTIES[diff];
  rows = cfg.rows;
  cols = cfg.cols;
  mineCount = cfg.mines;

  cells = Array.from({ length: rows * cols }, () => ({
    mine: false,
    revealed: false,
    flagged: false,
    adjacent: 0,
  }));
  firstClickDone = false;
  gameOver = false;
  won = false;
  revealedCount = 0;
  hitIndex = null;

  resultOverlay.hidden = true;
  stopTimer();
  timerEl.textContent = `⏱ ${formatTime(0)}`;
  renderBestTime();
  updateMineCount();
  buildBoardDom();
  renderAll();
}

function startGameWithDifficulty(diff) {
  difficultyScreen.hidden = true;
  gameScreen.hidden = false;
  newGame(diff);
}

function backToDifficultyScreen() {
  stopTimer();
  gameScreen.hidden = true;
  difficultyScreen.hidden = false;
}

document.querySelectorAll(".diff-btn--start").forEach((btn) => {
  btn.addEventListener("click", () => startGameWithDifficulty(btn.dataset.difficulty));
});

document.getElementById("new-game-btn").addEventListener("click", () => newGame(difficulty));
document.getElementById("change-difficulty-btn").addEventListener("click", backToDifficultyScreen);
document.getElementById("result-close-btn").addEventListener("click", () => newGame(difficulty));

flagModeBtn.addEventListener("click", () => {
  flagMode = !flagMode;
  flagModeBtn.setAttribute("aria-pressed", String(flagMode));
});

window.addEventListener("resize", () => {
  if (!gameScreen.hidden) applyCellSize();
});

if (typeof isFirebaseConfigured === "function" && isFirebaseConfigured()) {
  updateAccountHintInline();
}
