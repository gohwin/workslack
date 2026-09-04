// Login/signup/logout and the shared `currentUser` state live in the
// site-wide ../../auth.js (loaded via a <script> tag before this file, so
// its top-level declarations are plain globals here too, same as
// ../../firebase-config.js's window.__firebaseConfig). COMMON_POOL comes
// from ../crossword/crossword_words.js -- the exact same word list the
// crossword uses, reused here instead of duplicated.

const LIVES_START = 3;

// Which word lengths are in play at a given score -- widens as score climbs
// so both "how long the word is" and "how fast you must type it" ramp up
// together, matching a real typing-game difficulty curve.
const LENGTH_TIERS = [
  { minScore: 0, maxLen: 2 },
  { minScore: 5, maxLen: 3 },
  { minScore: 12, maxLen: 4 },
  { minScore: 20, maxLen: 5 },
];

const BASE_TIME_PER_SYLLABLE = 1.15;
const MIN_TIME = 1.3;
const SPEED_DECAY_PER_SCORE = 0.018;
const SPEED_FLOOR = 0.5;

let score = 0;
let lives = LIVES_START;
let currentWord = null;
let timeLimit = 0;
let remaining = 0;
let tickHandle = null;
let lastAnswer = null; // avoid immediately repeating the same word

const startScreenEl = document.getElementById("start-screen");
const gameScreenEl = document.getElementById("game-screen");
const resultOverlayEl = document.getElementById("result-overlay");
const scoreLabelEl = document.getElementById("score-label");
const livesLabelEl = document.getElementById("lives-label");
const wordDisplayEl = document.getElementById("word-display");
const timerBarEl = document.getElementById("timer-bar");
const inputEl = document.getElementById("typing-input");
const resultScoreEl = document.getElementById("result-score");
const resultPointsEl = document.getElementById("result-points");
const startBtn = document.getElementById("start-btn");
const restartBtn = document.getElementById("restart-btn");
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
  accountHintInlineEl.appendChild(document.createTextNode(" 상단에서 할 수 있어요. 로그인하면 점수만큼 그대로 적립됩니다."));
}

// Called by auth.js whenever login state resolves or changes.
function onAccountReady() {
  updateAccountHintInline();
}

function currentMaxLen() {
  let maxLen = LENGTH_TIERS[0].maxLen;
  for (const tier of LENGTH_TIERS) {
    if (score >= tier.minScore) maxLen = tier.maxLen;
  }
  return maxLen;
}

function pickWord() {
  const maxLen = currentMaxLen();
  const candidates = COMMON_POOL.filter((w) => w.answer.length <= maxLen && w.answer !== lastAnswer);
  const pool = candidates.length ? candidates : COMMON_POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}

function timeForWord(word) {
  const speedFactor = Math.max(SPEED_FLOOR, 1 - score * SPEED_DECAY_PER_SCORE);
  return Math.max(MIN_TIME, word.answer.length * BASE_TIME_PER_SYLLABLE * speedFactor);
}

function updateHud() {
  scoreLabelEl.textContent = `점수 ${score}`;
  livesLabelEl.textContent = "❤".repeat(lives) + "🖤".repeat(LIVES_START - lives);
}

function stopTick() {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

function nextWord() {
  currentWord = pickWord();
  lastAnswer = currentWord.answer;
  wordDisplayEl.textContent = currentWord.answer;
  inputEl.value = "";

  timeLimit = timeForWord(currentWord);
  remaining = timeLimit;
  timerBarEl.style.transform = "scaleX(1)";
  timerBarEl.classList.remove("timer-bar--low");

  stopTick();
  const tickMs = 50;
  tickHandle = setInterval(() => {
    remaining -= tickMs / 1000;
    const ratio = Math.max(0, remaining / timeLimit);
    timerBarEl.style.transform = `scaleX(${ratio})`;
    timerBarEl.classList.toggle("timer-bar--low", ratio < 0.3);
    if (remaining <= 0) {
      stopTick();
      onMiss();
    }
  }, tickMs);
}

function onMiss() {
  lives -= 1;
  updateHud();
  wordDisplayEl.classList.add("shake");
  setTimeout(() => wordDisplayEl.classList.remove("shake"), 300);
  if (lives <= 0) {
    endGame();
  } else {
    nextWord();
  }
}

function onCorrect() {
  score += 1;
  updateHud();
  stopTick();
  nextWord();
}

function checkInput(value) {
  if (currentWord && value === currentWord.answer) onCorrect();
}

// 한글은 IME로 자모를 조합해 완성하므로, 조합이 끝나는 시점(compositionend)에만
// 검사하고, 그 외 입력(영문 타이핑 등)은 input 이벤트에서 처리한다. 같은 입력에
// 두 이벤트가 겹쳐 두 번 처리되는 걸 막기 위해 skipNextInput으로 한 번 걸러준다
// (../crossword/script.js와 동일한 패턴).
let skipNextInput = false;
inputEl.addEventListener("compositionend", (e) => {
  skipNextInput = true;
  checkInput(e.target.value);
});
inputEl.addEventListener("input", (e) => {
  if (skipNextInput) {
    skipNextInput = false;
    return;
  }
  if (e.isComposing) return;
  checkInput(e.target.value);
});

function startGame() {
  score = 0;
  lives = LIVES_START;
  lastAnswer = null;
  startScreenEl.hidden = true;
  resultOverlayEl.hidden = true;
  gameScreenEl.hidden = false;
  updateHud();
  nextWord();
  inputEl.focus();
}

// Points are an account feature (awardPoints() from ../../auth.js is a
// no-op for guests) -- the game itself is fully playable, and replayable
// without limit, whether you're logged in or not. Score IS the point
// amount here (no fixed per-difficulty table like sudoku/minesweeper),
// since this game has no discrete "cleared" state to attach a flat award
// to -- it's endless until you run out of lives.
async function endGame() {
  stopTick();
  gameScreenEl.hidden = true;
  resultOverlayEl.hidden = false;
  resultScoreEl.textContent = `최종 점수: ${score}`;
  resultPointsEl.textContent = currentUser ? "" : "로그인하면 점수가 쌓여요.";
  if (score > 0) {
    const awarded = await awardPoints(score, "typing", "타자 연습");
    if (awarded) resultPointsEl.textContent = `+${score}점 적립!`;
  }
}

startBtn.addEventListener("click", startGame);
restartBtn.addEventListener("click", startGame);

if (typeof isFirebaseConfigured === "function" && isFirebaseConfigured()) {
  updateAccountHintInline();
}
