// Login/signup/logout and the shared `currentUser` state live in the
// site-wide ../../auth.js (loaded via a <script> tag before this file, so
// its top-level declarations are plain globals here too, same as
// ../../firebase-config.js's window.__firebaseConfig).

const POINTS_PER_COMPLETION = 10;
// autoPlace()/normalize()/COMMON_POOL come from ./auto_crossword.js and
// ./crossword_words.js (loaded via <script> tags before this file) -- the
// same generator ../tools/build_puzzles.js used to run offline to
// pre-bake puzzles.json now runs live, in-browser, on every play.
const GEN_TIME_BUDGET_MS = 1800;
const GEN_MAX_ATTEMPTS = 1000;
const GEN_MAX_DIM = 12;
const GEN_MIN_WORDS = 10;

let puzzle = null;
let cellIndex = {}; // "r,c" -> { across: word|null, down: word|null }
let answers = {}; // "r,c" -> single syllable string
let selected = null; // { row, col, direction }
let completed = false;

const loadingEl = document.getElementById("loading-msg");
const gameAreaEl = document.getElementById("game-area");
const boardEl = document.getElementById("board");
const acrossListEl = document.getElementById("across-clues");
const downListEl = document.getElementById("down-clues");
const winOverlayEl = document.getElementById("win-overlay");
const winTimeEl = document.getElementById("win-time");
const winCloseBtn = document.getElementById("win-close-btn");

function buildCellIndex() {
  const index = {};
  for (let r = 0; r < puzzle.rows; r++) {
    for (let c = 0; c < puzzle.cols; c++) {
      if (puzzle.grid[r][c] === null) continue;
      index[`${r},${c}`] = { across: null, down: null };
    }
  }
  for (const w of puzzle.words) {
    const letters = [...w.answer];
    for (let i = 0; i < letters.length; i++) {
      const r = w.direction === "across" ? w.row : w.row + i;
      const c = w.direction === "across" ? w.col + i : w.col;
      index[`${r},${c}`][w.direction] = w;
    }
  }
  return index;
}

function buildCellNumbers() {
  const map = {};
  for (const w of puzzle.words) {
    map[`${w.row},${w.col}`] = w.number;
  }
  return map;
}

const boardWrapperEl = document.querySelector(".board-wrapper");
const DESIRED_CELL_SIZE = 40;
const MIN_CELL_SIZE = 16;

// Grids now range from small to GEN_MAX_DIM columns wide -- without this,
// a wide grid at the fixed 40px cell size would overflow narrow screens
// (see minesweeper's script.js, which has the same fit-to-width logic).
function applyCellSize() {
  const available = boardWrapperEl.clientWidth || window.innerWidth - 32;
  const gap = 1;
  const borderTotal = 4;
  const totalGap = gap * (puzzle.cols - 1);
  const fitSize = Math.floor((available - totalGap - borderTotal) / puzzle.cols);
  const size = Math.max(MIN_CELL_SIZE, Math.min(DESIRED_CELL_SIZE, fitSize));
  boardEl.style.setProperty("--cell-size", `${size}px`);
}

function buildBoardDom() {
  boardEl.innerHTML = "";
  boardEl.style.setProperty("--cols", puzzle.cols);
  applyCellSize();
  const cellNumbers = buildCellNumbers();

  for (let r = 0; r < puzzle.rows; r++) {
    for (let c = 0; c < puzzle.cols; c++) {
      const cellDiv = document.createElement("div");
      cellDiv.className = "cell";
      cellDiv.dataset.row = String(r);
      cellDiv.dataset.col = String(c);

      if (puzzle.grid[r][c] === null) {
        cellDiv.classList.add("blocked");
        boardEl.appendChild(cellDiv);
        continue;
      }

      const num = cellNumbers[`${r},${c}`];
      if (num) {
        const numEl = document.createElement("span");
        numEl.className = "cell-number";
        numEl.textContent = String(num);
        cellDiv.appendChild(numEl);
      }

      const input = document.createElement("input");
      input.type = "text";
      input.autocomplete = "off";
      input.autocapitalize = "off";
      input.spellcheck = false;
      input.lang = "ko";
      input.inputMode = "text";
      input.value = answers[`${r},${c}`] || "";
      // 한글은 IME로 자모를 조합해 한 음절을 완성하므로 maxLength로 강제로 자르면
      // 조합이 중간에 끊긴다. 대신 조합이 끝나는 시점(compositionend)에만 마지막
      // 글자 하나로 정리하고, 그 외 입력(영문 타이핑, 붙여넣기, 자동화 등)은
      // input 이벤트에서 처리한다. 같은 입력에 대해 두 이벤트가 겹쳐 두 번
      // 처리되는 것을 막기 위해 skipNextInput 플래그로 한 번 걸러준다.
      let skipNextInput = false;
      // Toggling direction (across <-> down) should only happen when the
      // user clicks a cell that was *already focused* -- checked via
      // document.activeElement, not via comparing against the `selected`
      // state. `selected` starts out pointing at the puzzle's first word
      // before any real interaction, so comparing against it would make the
      // very first click on that cell look like a repeat click and toggle
      // direction immediately. mousedown also fires before the browser's
      // default focus handling, so activeElement here still reflects
      // whichever cell was focused *before* this click.
      input.addEventListener("mousedown", () => {
        const alreadyFocused = document.activeElement === input;
        selectCell(r, c, null, alreadyFocused);
      });
      input.addEventListener("focus", () => selectCell(r, c));
      input.addEventListener("compositionend", (e) => {
        skipNextInput = true;
        commitCellValue(r, c, e.target.value);
      });
      input.addEventListener("input", (e) => {
        if (skipNextInput) {
          skipNextInput = false;
          return;
        }
        if (e.isComposing) return;
        commitCellValue(r, c, e.target.value);
      });
      input.addEventListener("keydown", (e) => onCellKeydown(r, c, e));
      cellDiv.appendChild(input);
      boardEl.appendChild(cellDiv);
    }
  }
}

function cellInput(r, c) {
  const cellDiv = boardEl.children[r * puzzle.cols + c];
  return cellDiv ? cellDiv.querySelector("input") : null;
}

function cellDiv(r, c) {
  return boardEl.children[r * puzzle.cols + c];
}

function buildClueLists() {
  acrossListEl.innerHTML = "";
  downListEl.innerHTML = "";
  const across = puzzle.words.filter((w) => w.direction === "across").sort((a, b) => a.number - b.number);
  const down = puzzle.words.filter((w) => w.direction === "down").sort((a, b) => a.number - b.number);

  for (const w of across) acrossListEl.appendChild(buildClueItem(w));
  for (const w of down) downListEl.appendChild(buildClueItem(w));
}

function buildClueItem(word) {
  const li = document.createElement("li");
  li.dataset.number = String(word.number);
  li.dataset.direction = word.direction;
  const numSpan = document.createElement("span");
  numSpan.className = "clue-number";
  numSpan.textContent = `${word.number}.`;
  li.appendChild(numSpan);
  li.appendChild(document.createTextNode(word.clue));
  li.addEventListener("click", () => {
    selected = { row: word.row, col: word.col, direction: word.direction };
    renderSelection();
    const input = cellInput(word.row, word.col);
    if (input) input.focus();
  });
  return li;
}

function selectCell(r, c, preferDirection, toggle) {
  const info = cellIndex[`${r},${c}`];
  if (!info) return;
  let dir = preferDirection;
  if (!dir) {
    if (toggle && selected && selected.row === r && selected.col === c) {
      dir = selected.direction === "across" ? (info.down ? "down" : "across") : info.across ? "across" : "down";
    } else if (selected) {
      dir = info[selected.direction] ? selected.direction : info.across ? "across" : "down";
    } else {
      dir = info.across ? "across" : "down";
    }
  } else if (!info[dir]) {
    dir = info.across ? "across" : "down";
  }
  selected = { row: r, col: c, direction: dir };
  renderSelection();
}

function currentWord() {
  if (!selected) return null;
  return cellIndex[`${selected.row},${selected.col}`][selected.direction];
}

function renderSelection() {
  for (const el of boardEl.querySelectorAll(".cell.selected")) el.classList.remove("selected");
  for (const el of boardEl.querySelectorAll(".cell.highlighted")) el.classList.remove("highlighted");
  for (const el of acrossListEl.querySelectorAll("li.active")) el.classList.remove("active");
  for (const el of downListEl.querySelectorAll("li.active")) el.classList.remove("active");

  const word = currentWord();
  if (word) {
    const letters = [...word.answer];
    for (let i = 0; i < letters.length; i++) {
      const r = word.direction === "across" ? word.row : word.row + i;
      const c = word.direction === "across" ? word.col + i : word.col;
      const div = cellDiv(r, c);
      if (div) div.classList.add("highlighted");
    }
    const listEl = word.direction === "across" ? acrossListEl : downListEl;
    const li = listEl.querySelector(`li[data-number="${word.number}"]`);
    if (li) li.classList.add("active");
  }
  if (selected) {
    const div = cellDiv(selected.row, selected.col);
    if (div) div.classList.add("selected");
  }
}

function advanceInWord() {
  const word = currentWord();
  if (!word || !selected) return;
  const idx = word.direction === "across" ? selected.col - word.col : selected.row - word.row;
  if (idx < word.answer.length - 1) {
    const nr = word.direction === "across" ? selected.row : selected.row + 1;
    const nc = word.direction === "across" ? selected.col + 1 : selected.col;
    selectCell(nr, nc, word.direction);
    const input = cellInput(nr, nc);
    if (input) input.focus();
  }
}

function retreatInWord(clearCurrent) {
  const word = currentWord();
  if (!word || !selected) return;
  const idx = word.direction === "across" ? selected.col - word.col : selected.row - word.row;
  if (clearCurrent) {
    answers[`${selected.row},${selected.col}`] = "";
    const input = cellInput(selected.row, selected.col);
    if (input) input.value = "";
  }
  if (idx > 0) {
    const pr = word.direction === "across" ? selected.row : selected.row - 1;
    const pc = word.direction === "across" ? selected.col - 1 : selected.col;
    selectCell(pr, pc, word.direction);
    const input = cellInput(pr, pc);
    if (input) input.focus();
  }
  saveAnswersAndCheck();
}

function commitCellValue(r, c, rawValue) {
  const val = [...rawValue].slice(-1).join("");
  const input = cellInput(r, c);
  if (input) input.value = val;
  answers[`${r},${c}`] = val;
  saveAnswersAndCheck();
  if (val) advanceInWord();
}

function onCellKeydown(r, c, e) {
  if (e.key === "Backspace") {
    const input = e.target;
    if (!input.value) {
      e.preventDefault();
      retreatInWord(false);
    }
    return;
  }
  if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    const dr = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    const dc = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const nr = r + dr;
    const nc = c + dc;
    if (nr < 0 || nr >= puzzle.rows || nc < 0 || nc >= puzzle.cols) return;
    if (!cellIndex[`${nr},${nc}`]) return;
    const dir = dc !== 0 ? "across" : "down";
    selectCell(nr, nc, dir);
    const input = cellInput(nr, nc);
    if (input) input.focus();
  }
}

function saveAnswersAndCheck() {
  if (!completed && checkCompletion()) completeGame();
}

function checkCompletion() {
  for (let r = 0; r < puzzle.rows; r++) {
    for (let c = 0; c < puzzle.cols; c++) {
      if (puzzle.grid[r][c] === null) continue;
      if ((answers[`${r},${c}`] || "") !== puzzle.grid[r][c]) return false;
    }
  }
  return true;
}

// Points are an account feature (awardPoints() from ../../auth.js is a
// no-op for guests) -- the game itself is fully playable, and replayable
// without limit, whether you're logged in or not.
async function completeGame() {
  completed = true;
  winTimeEl.textContent = currentUser ? "" : "로그인하면 완성할 때마다 점수가 쌓여요.";
  winOverlayEl.hidden = false;
  const awarded = await awardPoints(POINTS_PER_COMPLETION, "crossword", "크로스워드");
  if (awarded) winTimeEl.textContent = `+${POINTS_PER_COMPLETION}점 적립!`;
}

function shuffleWords(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function filledCellCount(candidate) {
  let count = 0;
  for (const row of candidate.grid) {
    for (const cell of row) if (cell !== null) count++;
  }
  return count;
}

// Tries a bunch of random shuffles of the word pool and keeps the best
// placement -- identical algorithm to what tools/build_puzzles.js used to
// run offline, just budgeted for a live pause instead of a batch job (see
// auto_crossword.js's autoPlace()/normalize()).
//
// "Best" is words × density (filled cells / bounding-box area), not raw
// word count: scoring by word count alone lets the generator win simply by
// sprawling into a long, thin diagonal chain (loosely connected, mostly
// empty space) since that's the easiest way to keep attaching "one more
// word" once GEN_MAX_DIM gives it room to spread into. Density punishes
// that sprawl and rewards the tightly interlocked NYT-style look instead.
function generatePuzzle() {
  let best = null;
  let bestScore = -1;
  const deadline = Date.now() + GEN_TIME_BUDGET_MS;
  for (let i = 0; i < GEN_MAX_ATTEMPTS && Date.now() < deadline; i++) {
    const order = shuffleWords(COMMON_POOL);
    const { placed } = autoPlace(order, GEN_MAX_DIM - 1);
    const candidate = normalize(Date.now() + i, placed);
    if (Math.max(candidate.rows, candidate.cols) > GEN_MAX_DIM) continue;
    if (candidate.words.length < GEN_MIN_WORDS) continue;
    const density = filledCellCount(candidate) / (candidate.rows * candidate.cols);
    const score = candidate.words.length * density;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best || normalize(Date.now(), autoPlace(shuffleWords(COMMON_POOL), GEN_MAX_DIM - 1).placed);
}

async function startNewPuzzle() {
  completed = false;
  winOverlayEl.hidden = true;
  gameAreaEl.hidden = true;
  loadingEl.textContent = "문제를 만드는 중...";
  loadingEl.hidden = false;
  // Yield one frame so the "만드는 중..." message actually paints before the
  // generator's synchronous loop blocks the main thread.
  await new Promise((resolve) => setTimeout(resolve, 20));

  puzzle = generatePuzzle();
  cellIndex = buildCellIndex();
  answers = {};
  selected = null;

  loadingEl.hidden = true;
  gameAreaEl.hidden = false;
  buildBoardDom();
  buildClueLists();

  const firstWord = puzzle.words[0];
  if (firstWord) {
    selected = { row: firstWord.row, col: firstWord.col, direction: firstWord.direction };
    renderSelection();
  }
}

winCloseBtn.addEventListener("click", startNewPuzzle);

window.addEventListener("resize", () => {
  if (!gameAreaEl.hidden) applyCellSize();
});

// --- boot ---

function boot() {
  startNewPuzzle();
}

boot();
