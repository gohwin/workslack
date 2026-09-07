const DIFFICULTIES = {
  easy: { label: "쉬움", clues: 40, points: 50 },
  medium: { label: "중간", clues: 32, points: 100 },
  hard: { label: "어려움", clues: 26, points: 200 },
};

// Points are paused site-wide while more games get added, so nobody has to
// re-tune every game's point scale each time a new one shows up. Flip this
// back to true (same everywhere else this flag appears) to resume scoring.
const POINTS_ENABLED = false;

const STORAGE_KEY = "sudoku-best-times";
const GEN_TIME_BUDGET_MS = 3000;

let solution = new Array(81).fill(0);
let given = new Array(81).fill(false);
let current = new Array(81).fill(0);
let difficulty = "easy";
let selectedIndex = null;
let startTime = null;
let timerHandle = null;
let elapsedSeconds = 0;
let finished = false;

const boardEl = document.getElementById("board");
const timerEl = document.getElementById("timer");
const bestTimeEl = document.getElementById("best-time");
const loadingEl = document.getElementById("loading-msg");
const winOverlay = document.getElementById("win-overlay");
const winTimeEl = document.getElementById("win-time");
const difficultyScreen = document.getElementById("difficulty-screen");
const gameScreen = document.getElementById("game-screen");
const winPointsEl = document.getElementById("win-points");

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function isSafe(board, idx, val) {
  const row = Math.floor(idx / 9);
  const col = idx % 9;
  for (let c = 0; c < 9; c++) {
    if (board[row * 9 + c] === val) return false;
  }
  for (let r = 0; r < 9; r++) {
    if (board[r * 9 + col] === val) return false;
  }
  const br = row - (row % 3);
  const bc = col - (col % 3);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (board[(br + r) * 9 + (bc + c)] === val) return false;
    }
  }
  return true;
}

function generateSolvedBoard() {
  const board = new Array(81).fill(0);
  function fill(pos) {
    if (pos === 81) return true;
    const nums = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const n of nums) {
      if (isSafe(board, pos, n)) {
        board[pos] = n;
        if (fill(pos + 1)) return true;
        board[pos] = 0;
      }
    }
    return false;
  }
  fill(0);
  return board;
}

function countSolutions(board, limit) {
  let total = 0;
  function backtrack() {
    if (total >= limit) return;
    let bestIdx = -1;
    let bestCandidates = null;
    for (let i = 0; i < 81; i++) {
      if (board[i] === 0) {
        const cands = [];
        for (let n = 1; n <= 9; n++) {
          if (isSafe(board, i, n)) cands.push(n);
        }
        if (cands.length === 0) return;
        if (bestCandidates === null || cands.length < bestCandidates.length) {
          bestCandidates = cands;
          bestIdx = i;
          if (cands.length === 1) break;
        }
      }
    }
    if (bestIdx === -1) {
      total++;
      return;
    }
    for (const n of bestCandidates) {
      if (total >= limit) return;
      board[bestIdx] = n;
      backtrack();
      board[bestIdx] = 0;
    }
  }
  backtrack();
  return total;
}

function makePuzzle(solved, targetClues) {
  const board = solved.slice();
  const cellOrder = shuffle([...Array(81).keys()]);
  let clues = 81;
  const deadline = Date.now() + GEN_TIME_BUDGET_MS;

  for (const idx of cellOrder) {
    if (clues <= targetClues) break;
    if (Date.now() > deadline) break;

    const backup = board[idx];
    board[idx] = 0;
    const solutions = countSolutions(board, 2);
    if (solutions !== 1) {
      board[idx] = backup;
    } else {
      clues--;
    }
  }
  return board;
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
  timerEl.textContent = formatTime(0);
  timerHandle = setInterval(() => {
    elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    timerEl.textContent = formatTime(elapsedSeconds);
  }, 1000);
}

function getPeers(idx) {
  const row = Math.floor(idx / 9);
  const col = idx % 9;
  const br = row - (row % 3);
  const bc = col - (col % 3);
  const peers = new Set();
  for (let c = 0; c < 9; c++) peers.add(row * 9 + c);
  for (let r = 0; r < 9; r++) peers.add(r * 9 + col);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) peers.add((br + r) * 9 + (bc + c));
  }
  peers.delete(idx);
  return peers;
}

function getConflicts() {
  const conflicts = new Set();
  for (let i = 0; i < 81; i++) {
    if (current[i] === 0) continue;
    const peers = getPeers(i);
    for (const p of peers) {
      if (current[p] === current[i]) {
        conflicts.add(i);
        conflicts.add(p);
      }
    }
  }
  return conflicts;
}

function buildBoardDom() {
  boardEl.innerHTML = "";
  for (let i = 0; i < 81; i++) {
    const row = Math.floor(i / 9);
    const col = i % 9;
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.index = String(i);
    if (col === 8) cell.classList.add("row-end");
    if (col % 3 === 2 && col !== 8) cell.classList.add("box-right");
    if (row % 3 === 2 && row !== 8) cell.classList.add("box-bottom");
    cell.addEventListener("click", () => selectCell(i));
    boardEl.appendChild(cell);
  }
}

function render() {
  const conflicts = getConflicts();
  const peers = selectedIndex !== null ? getPeers(selectedIndex) : new Set();
  const selectedValue = selectedIndex !== null ? current[selectedIndex] : 0;

  const cells = boardEl.children;
  for (let i = 0; i < 81; i++) {
    const cell = cells[i];
    const val = current[i];
    cell.textContent = val === 0 ? "" : String(val);
    cell.classList.toggle("given", given[i]);
    cell.classList.toggle("selected", i === selectedIndex);
    cell.classList.toggle("peer", peers.has(i) && i !== selectedIndex);
    cell.classList.toggle(
      "same-value",
      selectedValue !== 0 && val === selectedValue && i !== selectedIndex
    );
    cell.classList.toggle("conflict", conflicts.has(i));
  }
}

function selectCell(idx) {
  if (finished) return;
  selectedIndex = idx;
  render();
}

function setValue(val) {
  if (finished || selectedIndex === null) return;
  if (given[selectedIndex]) return;
  current[selectedIndex] = val;
  render();
  checkWin();
}

function checkWin() {
  for (let i = 0; i < 81; i++) {
    if (current[i] === 0 || current[i] !== solution[i]) return;
  }
  finished = true;
  stopTimer();
  saveBestTime(difficulty, elapsedSeconds);
  winTimeEl.textContent = `${DIFFICULTIES[difficulty].label} · ${formatTime(elapsedSeconds)}`;
  winOverlay.hidden = false;
  renderBestTime();
  awardGamePoints();
}

async function awardGamePoints() {
  if (!POINTS_ENABLED) return;
  if (typeof awardPoints !== "function") return;
  const points = DIFFICULTIES[difficulty].points;
  winPointsEl.textContent = currentUser ? "" : "로그인하면 점수가 쌓여요.";
  const awarded = await awardPoints(points, "sudoku", `스도쿠 (${DIFFICULTIES[difficulty].label})`);
  if (awarded) winPointsEl.textContent = `+${points}점 적립!`;
}

function setActiveDifficultyButton() {
  document.querySelectorAll(".diff-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.difficulty === difficulty);
  });
}

async function newGame(diff) {
  difficulty = diff;
  setActiveDifficultyButton();
  finished = false;
  selectedIndex = null;
  winOverlay.hidden = true;
  loadingEl.hidden = false;
  boardEl.style.visibility = "hidden";
  stopTimer();
  timerEl.textContent = "00:00";
  renderBestTime();

  await new Promise((resolve) => setTimeout(resolve, 20));

  solution = generateSolvedBoard();
  const puzzle = makePuzzle(solution, DIFFICULTIES[diff].clues);
  current = puzzle.slice();
  given = puzzle.map((v) => v !== 0);

  loadingEl.hidden = true;
  boardEl.style.visibility = "visible";
  render();
  startTimer();
}

function resetPuzzle() {
  if (!solution.some((v) => v !== 0)) return;
  finished = false;
  selectedIndex = null;
  winOverlay.hidden = true;
  current = current.map((v, i) => (given[i] ? v : 0));
  render();
  startTimer();
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
document.getElementById("reset-btn").addEventListener("click", resetPuzzle);
document.getElementById("change-difficulty-btn").addEventListener("click", backToDifficultyScreen);
document.getElementById("win-close-btn").addEventListener("click", () => newGame(difficulty));

document.getElementById("number-pad").addEventListener("click", (e) => {
  const btn = e.target.closest(".num-btn");
  if (!btn) return;
  setValue(Number(btn.dataset.num));
});

document.addEventListener("keydown", (e) => {
  if (selectedIndex === null || finished) return;
  if (e.key >= "1" && e.key <= "9") {
    setValue(Number(e.key));
  } else if (e.key === "Backspace" || e.key === "Delete" || e.key === "0") {
    setValue(0);
  } else if (e.key.startsWith("Arrow")) {
    const row = Math.floor(selectedIndex / 9);
    const col = selectedIndex % 9;
    let next = selectedIndex;
    if (e.key === "ArrowUp" && row > 0) next -= 9;
    if (e.key === "ArrowDown" && row < 8) next += 9;
    if (e.key === "ArrowLeft" && col > 0) next -= 1;
    if (e.key === "ArrowRight" && col < 8) next += 1;
    if (next !== selectedIndex) {
      selectedIndex = next;
      render();
      e.preventDefault();
    }
  }
});

buildBoardDom();
