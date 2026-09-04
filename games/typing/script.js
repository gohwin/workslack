// Login/signup/logout and the shared `currentUser` state live in the
// site-wide ../../auth.js (loaded via a <script> tag before this file, so
// its top-level declarations are plain globals here too, same as
// ../../firebase-config.js's window.__firebaseConfig). COMMON_POOL comes
// from ../crossword/crossword_words.js -- the exact same word list the
// crossword uses, reused here instead of duplicated.

// Words fall continuously (not a shrinking per-word timer) -- one word
// reaching the bottom ends the game instantly, no lives. Difficulty ramps
// two ways over elapsed survival time: words spawn more often (more of
// them in the air at once) AND fall faster (less reaction time per word).
const FALL_SPEED_START = 55;
const FALL_SPEED_MAX = 140;
const FALL_SPEED_RAMP_SECONDS = 90; // fall speed reaches its ceiling after this long survived
const SPAWN_START_MS = 1800;
const SPAWN_MIN_MS = 450;
const SPAWN_RAMP_SECONDS = 75; // spawn interval reaches its floor after this long survived
const MAX_ACTIVE_WORDS = 7;

// Longer words enter the pool as score climbs, same idea as before, just
// keyed off words-popped instead of a per-word clear.
const LENGTH_TIERS = [
  { minScore: 0, maxLen: 2 },
  { minScore: 5, maxLen: 3 },
  { minScore: 12, maxLen: 4 },
  { minScore: 20, maxLen: 5 },
];

let score = 0;
let elapsedSeconds = 0;
let spawnTimerMs = 0;
let lastFrameTime = 0;
let rafHandle = null;
let running = false;
let activeWords = []; // { el, answer, y }
let lastSpawnedAnswer = null;

const startScreenEl = document.getElementById("start-screen");
const gameScreenEl = document.getElementById("game-screen");
const resultOverlayEl = document.getElementById("result-overlay");
const scoreLabelEl = document.getElementById("score-label");
const timeLabelEl = document.getElementById("time-label");
const playAreaEl = document.getElementById("play-area");
const inputEl = document.getElementById("typing-input");
const resultScoreEl = document.getElementById("result-score");
const resultPointsEl = document.getElementById("result-points");
const startBtn = document.getElementById("start-btn");
const restartBtn = document.getElementById("restart-btn");

function currentMaxLen() {
  let maxLen = LENGTH_TIERS[0].maxLen;
  for (const tier of LENGTH_TIERS) {
    if (score >= tier.minScore) maxLen = tier.maxLen;
  }
  return maxLen;
}

function pickWord() {
  const maxLen = currentMaxLen();
  const candidates = COMMON_POOL.filter((w) => w.answer.length <= maxLen && w.answer !== lastSpawnedAnswer);
  const pool = candidates.length ? candidates : COMMON_POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}

function currentSpawnIntervalMs() {
  const ramp = Math.min(1, elapsedSeconds / SPAWN_RAMP_SECONDS);
  return SPAWN_START_MS - (SPAWN_START_MS - SPAWN_MIN_MS) * ramp;
}

function currentFallSpeed() {
  const ramp = Math.min(1, elapsedSeconds / FALL_SPEED_RAMP_SECONDS);
  return FALL_SPEED_START + (FALL_SPEED_MAX - FALL_SPEED_START) * ramp;
}

function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function updateHud() {
  scoreLabelEl.textContent = `점수 ${score}`;
  timeLabelEl.textContent = formatTime(elapsedSeconds);
}

function spawnWord() {
  if (activeWords.length >= MAX_ACTIVE_WORDS) return;
  const word = pickWord();
  lastSpawnedAnswer = word.answer;

  const el = document.createElement("div");
  el.className = "falling-word";
  el.textContent = word.answer;
  playAreaEl.appendChild(el);

  const areaWidth = playAreaEl.clientWidth;
  const elWidth = el.offsetWidth;
  const x = Math.max(0, Math.random() * Math.max(0, areaWidth - elWidth));
  el.style.left = `${x}px`;
  el.style.top = "-32px";

  activeWords.push({ el, answer: word.answer, y: -32 });
}

function clearActiveWords() {
  for (const w of activeWords) w.el.remove();
  activeWords = [];
}

function frame(ts) {
  if (!running) return;
  const dt = lastFrameTime ? (ts - lastFrameTime) / 1000 : 0;
  lastFrameTime = ts;
  elapsedSeconds += dt;
  spawnTimerMs += dt * 1000;

  if (spawnTimerMs >= currentSpawnIntervalMs()) {
    spawnTimerMs = 0;
    spawnWord();
  }

  const areaHeight = playAreaEl.clientHeight;
  const fallSpeed = currentFallSpeed();
  for (const w of activeWords) {
    w.y += fallSpeed * dt;
    w.el.style.top = `${w.y}px`;
    if (w.y + w.el.offsetHeight >= areaHeight) {
      endGame();
      return;
    }
  }

  updateHud();
  rafHandle = requestAnimationFrame(frame);
}

function handleTypingChange() {
  const value = inputEl.value;

  const idx = activeWords.findIndex((w) => w.answer === value);
  if (idx !== -1) {
    const [popped] = activeWords.splice(idx, 1);
    popped.el.classList.add("popped");
    setTimeout(() => popped.el.remove(), 150);
    score += 1;
    updateHud();
    inputEl.value = "";
    for (const w of activeWords) w.el.classList.remove("targeted");
    return;
  }

  const hasPrefixMatch = value.length > 0 && activeWords.some((w) => w.answer.startsWith(value));
  if (value.length > 0 && !hasPrefixMatch) {
    // typed something that no falling word starts with -- reset instead of
    // letting the player get stuck on a dead-end string
    inputEl.value = "";
    for (const w of activeWords) w.el.classList.remove("targeted");
    return;
  }
  for (const w of activeWords) {
    w.el.classList.toggle("targeted", value.length > 0 && w.answer.startsWith(value));
  }
}

// 한글은 IME로 자모를 조합해 완성하므로, 조합이 끝나는 시점(compositionend)에만
// 검사하고, 그 외 입력(영문 타이핑 등)은 input 이벤트에서 처리한다. 같은 입력에
// 두 이벤트가 겹쳐 두 번 처리되는 걸 막기 위해 skipNextInput으로 한 번 걸러준다
// (../crossword/script.js와 동일한 패턴).
let skipNextInput = false;
inputEl.addEventListener("compositionend", () => {
  skipNextInput = true;
  handleTypingChange();
});
inputEl.addEventListener("input", (e) => {
  if (skipNextInput) {
    skipNextInput = false;
    return;
  }
  if (e.isComposing) return;
  handleTypingChange();
});

function startGame() {
  score = 0;
  elapsedSeconds = 0;
  spawnTimerMs = 0;
  lastFrameTime = 0;
  lastSpawnedAnswer = null;
  clearActiveWords();
  inputEl.value = "";

  startScreenEl.hidden = true;
  resultOverlayEl.hidden = true;
  gameScreenEl.hidden = false;
  updateHud();

  running = true;
  inputEl.focus();
  rafHandle = requestAnimationFrame(frame);
}

// Points are an account feature (awardPoints() from ../../auth.js is a
// no-op for guests) -- the game itself is fully playable, and replayable
// without limit, whether you're logged in or not. Score IS the point
// amount here (no fixed per-difficulty table like sudoku/minesweeper),
// since there's no discrete "cleared" state -- it's endless until a word
// reaches the bottom.
async function endGame() {
  running = false;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = null;

  gameScreenEl.classList.add("game-over-flash");
  await new Promise((resolve) => setTimeout(resolve, 200));
  gameScreenEl.classList.remove("game-over-flash");

  gameScreenEl.hidden = true;
  resultOverlayEl.hidden = false;
  resultScoreEl.textContent = `점수 ${score} · 생존 ${formatTime(elapsedSeconds)}`;
  resultPointsEl.textContent = currentUser ? "" : "로그인하면 점수가 쌓여요.";
  if (score > 0) {
    const awarded = await awardPoints(score, "typing", "타자 연습");
    if (awarded) resultPointsEl.textContent = `+${score}점 적립!`;
  }
}

startBtn.addEventListener("click", startGame);
restartBtn.addEventListener("click", startGame);
