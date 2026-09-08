// Login/signup/logout and the shared `currentUser` state live in the
// site-wide ../../auth.js (loaded via a <script> tag before this file, so
// its top-level declarations are plain globals here too, same as
// ../../firebase-config.js's window.__firebaseConfig). Only the 1v1 room
// modes need login -- a real match needs a stable way to tell "which of
// the two players is me" apart, including across a refresh, and a guest
// identity doesn't survive that. Bot mode is fully local (no Firestore at
// all) so it works for guests too.

const BOARD_SIZE = 15;
const WIN_LENGTH = 5;
const ROOM_CODE_LENGTH = 6;
// Excludes 0/O and 1/I so a spoken-aloud or handwritten code isn't
// ambiguous between a friend reading it back and typing it in.
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const loginRequiredEl = document.getElementById("login-required");
const lobbyScreenEl = document.getElementById("lobby-screen");
const waitingScreenEl = document.getElementById("waiting-screen");
const gameScreenEl = document.getElementById("game-screen");

const colorBlackBtn = document.getElementById("color-black-btn");
const colorWhiteBtn = document.getElementById("color-white-btn");
const botGameEasyBtn = document.getElementById("bot-game-easy-btn");
const botGameHardBtn = document.getElementById("bot-game-hard-btn");
const createRoomBtn = document.getElementById("create-room-btn");
const joinCodeInputEl = document.getElementById("join-code-input");
const joinRoomBtn = document.getElementById("join-room-btn");
const lobbyErrorEl = document.getElementById("lobby-error");

const roomCodeDisplayEl = document.getElementById("room-code-display");
const copyLinkBtn = document.getElementById("copy-link-btn");
const copyCodeBtn = document.getElementById("copy-code-btn");
const leaveWaitingBtn = document.getElementById("leave-waiting-btn");

const playerChipBlackEl = document.getElementById("player-chip-black");
const playerChipWhiteEl = document.getElementById("player-chip-white");
const blackNameEl = document.getElementById("black-name");
const whiteNameEl = document.getElementById("white-name");
const turnIndicatorEl = document.getElementById("turn-indicator");
const omokBoardEl = document.getElementById("omok-board");
const leaveGameBtn = document.getElementById("leave-game-btn");

const resultOverlayEl = document.getElementById("result-overlay");
const resultTitleEl = document.getElementById("result-title");
const rematchBtn = document.getElementById("rematch-btn");
const resultLeaveBtn = document.getElementById("result-leave-btn");

const SCREENS = {
  "login-required": loginRequiredEl,
  lobby: lobbyScreenEl,
  waiting: waitingScreenEl,
  game: gameScreenEl,
};
function showScreen(name) {
  for (const [key, el] of Object.entries(SCREENS)) el.hidden = key !== name;
}

let currentRoomCode = null;
let myRole = null; // "host" | "guest" | null
let roomData = null;
let unsubscribeRoom = null;
let isBotGame = false;
let botDifficulty = "hard"; // "easy" | "hard" -- see pickBotMove()
let humanColor = "host"; // "host" (black, goes first) | "guest" (white) -- picked in the lobby, only used for bot games

function generateRoomCode() {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

function emptyBoard() {
  return new Array(BOARD_SIZE * BOARD_SIZE).fill(0);
}

// Checks the 4 lines (–, |, \, /) through the just-placed stone for a run
// of WIN_LENGTH+ of the same value. Freestyle rules -- no forbidden-move
// restrictions on either color, and an "overline" (6+ in a row) still
// counts as a win, unlike stricter Renju rulesets. Returns the full list
// of connected indices (for highlighting), or null.
function checkWin(board, lastIndex, value) {
  const r0 = Math.floor(lastIndex / BOARD_SIZE);
  const c0 = lastIndex % BOARD_SIZE;
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  for (const [dr, dc] of directions) {
    const line = [lastIndex];
    for (const sign of [1, -1]) {
      let r = r0 + dr * sign;
      let c = c0 + dc * sign;
      while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r * BOARD_SIZE + c] === value) {
        line.push(r * BOARD_SIZE + c);
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (line.length >= WIN_LENGTH) return line;
  }
  return null;
}

async function createRoom() {
  if (!currentUser) return;
  createRoomBtn.disabled = true;
  lobbyErrorEl.hidden = true;
  try {
    const fsHandle = await ensureFirestore();
    if (!fsHandle) throw new Error("Firebase not configured");
    const { db, api } = fsHandle;
    let code = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateRoomCode();
      const snap = await api.getDoc(api.doc(db, "omok-rooms", candidate));
      if (!snap.exists()) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new Error("could not find a free room code");

    const room = {
      hostUid: currentUser.uid,
      hostNickname: currentUser.nickname,
      guestUid: null,
      guestNickname: null,
      board: emptyBoard(),
      turn: "host",
      status: "waiting",
      winner: null,
      winLine: null,
      lastMove: null,
      moveCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await api.setDoc(api.doc(db, "omok-rooms", code), room);
    enterRoom(code, "host");
  } catch (err) {
    console.error(err);
    lobbyErrorEl.textContent = "방 생성 중 문제가 발생했습니다.";
    lobbyErrorEl.hidden = false;
  }
  createRoomBtn.disabled = false;
}

async function joinRoom(rawCode) {
  if (!currentUser) return;
  const code = (rawCode || "").trim().toUpperCase();
  if (!code) return;
  joinRoomBtn.disabled = true;
  lobbyErrorEl.hidden = true;
  try {
    const fsHandle = await ensureFirestore();
    if (!fsHandle) throw new Error("Firebase not configured");
    const { db, api } = fsHandle;
    const ref = api.doc(db, "omok-rooms", code);
    const snap = await api.getDoc(ref);
    if (!snap.exists()) {
      lobbyErrorEl.textContent = "존재하지 않는 방 코드입니다.";
      lobbyErrorEl.hidden = false;
      return;
    }
    const data = snap.data();
    // Rejoining a room you're already part of (refresh, or clicking the
    // shared link again) should never fail as "room full."
    if (data.hostUid === currentUser.uid) {
      enterRoom(code, "host");
      return;
    }
    if (data.guestUid === currentUser.uid) {
      enterRoom(code, "guest");
      return;
    }
    if (data.guestUid) {
      lobbyErrorEl.textContent = "이미 다른 사람이 참가한 방입니다.";
      lobbyErrorEl.hidden = false;
      return;
    }
    await api.updateDoc(ref, {
      guestUid: currentUser.uid,
      guestNickname: currentUser.nickname,
      status: "playing",
      updatedAt: Date.now(),
    });
    enterRoom(code, "guest");
  } catch (err) {
    console.error(err);
    lobbyErrorEl.textContent = "방 참가 중 문제가 발생했습니다.";
    lobbyErrorEl.hidden = false;
  }
  joinRoomBtn.disabled = false;
}

function enterRoom(code, role) {
  currentRoomCode = code;
  myRole = role;
  isBotGame = false;
  leaveGameBtn.textContent = "방 나가기";
  resultLeaveBtn.textContent = "방 나가기";
  const url = new URL(window.location.href);
  url.searchParams.set("room", code);
  history.replaceState(null, "", url);
  subscribeRoom(code);
}

async function subscribeRoom(code) {
  if (unsubscribeRoom) unsubscribeRoom();
  const fsHandle = await ensureFirestore();
  if (!fsHandle) return;
  const { db, api } = fsHandle;
  unsubscribeRoom = api.onSnapshot(
    api.doc(db, "omok-rooms", code),
    (snap) => {
      if (!snap.exists()) {
        lobbyErrorEl.textContent = "방을 찾을 수 없습니다 (삭제되었거나 코드가 잘못됐어요).";
        lobbyErrorEl.hidden = false;
        leaveRoom();
        return;
      }
      roomData = snap.data();
      renderRoom();
    },
    (err) => console.error(err)
  );
}

function leaveRoom() {
  if (unsubscribeRoom) {
    unsubscribeRoom();
    unsubscribeRoom = null;
  }
  currentRoomCode = null;
  myRole = null;
  roomData = null;
  isBotGame = false;
  omokBoardEl.innerHTML = "";
  boardCellEls = null;
  const url = new URL(window.location.href);
  url.searchParams.delete("room");
  history.replaceState(null, "", url);
  resultOverlayEl.hidden = true;
  showScreen("lobby");
}

function renderRoom() {
  if (!roomData) return;
  if (roomData.status === "waiting") {
    showScreen("waiting");
    roomCodeDisplayEl.textContent = currentRoomCode;
    return;
  }
  showScreen("game");
  renderStatusBar();
  renderBoard();
  if (roomData.status === "finished") {
    showResult();
  } else {
    resultOverlayEl.hidden = true;
  }
}

function renderStatusBar() {
  blackNameEl.textContent = roomData.hostNickname || "?";
  whiteNameEl.textContent = roomData.guestNickname || "대기 중";
  playerChipBlackEl.classList.toggle("is-turn", roomData.status === "playing" && roomData.turn === "host");
  playerChipWhiteEl.classList.toggle("is-turn", roomData.status === "playing" && roomData.turn === "guest");
  if (roomData.status === "finished") {
    turnIndicatorEl.textContent = "게임 종료";
  } else {
    turnIndicatorEl.textContent = roomData.turn === myRole ? "내 차례예요" : "상대 차례예요";
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

// Real omok/go boards are a grid of *lines*, with stones sitting on the
// intersections -- not a checkerboard of filled squares. Draws BOARD_SIZE
// horizontal + BOARD_SIZE vertical hairlines across a 0..100 unit square
// (matches the percentage math buildBoardDom() uses to position stones),
// so the lines and the actual clickable intersections always line up
// exactly regardless of the board's rendered pixel size.
function buildBoardLinesSvg() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("omok-lines");
  const step = 100 / (BOARD_SIZE - 1);
  for (let i = 0; i < BOARD_SIZE; i++) {
    const pos = i * step;
    const hLine = document.createElementNS(SVG_NS, "line");
    hLine.setAttribute("x1", "0");
    hLine.setAttribute("x2", "100");
    hLine.setAttribute("y1", String(pos));
    hLine.setAttribute("y2", String(pos));
    svg.appendChild(hLine);
    const vLine = document.createElementNS(SVG_NS, "line");
    vLine.setAttribute("y1", "0");
    vLine.setAttribute("y2", "100");
    vLine.setAttribute("x1", String(pos));
    vLine.setAttribute("x2", String(pos));
    svg.appendChild(vLine);
  }
  return svg;
}

let boardCellEls = null;

function buildBoardDom() {
  omokBoardEl.innerHTML = "";
  const inner = document.createElement("div");
  inner.className = "omok-board-inner";
  inner.appendChild(buildBoardLinesSvg());

  boardCellEls = [];
  const step = 100 / (BOARD_SIZE - 1);
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const i = r * BOARD_SIZE + c;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "omok-cell";
      btn.style.left = `${c * step}%`;
      btn.style.top = `${r * step}%`;
      btn.addEventListener("click", () => placeStone(i));
      inner.appendChild(btn);
      boardCellEls.push(btn);
    }
  }
  omokBoardEl.appendChild(inner);
}

function renderBoard() {
  if (!boardCellEls) buildBoardDom();
  const winSet = new Set(roomData.winLine || []);
  const canPlay = roomData.status === "playing" && roomData.turn === myRole;
  for (let i = 0; i < boardCellEls.length; i++) {
    const cell = boardCellEls[i];
    const value = roomData.board[i];
    cell.classList.toggle("win-cell", winSet.has(i));
    cell.classList.toggle("last-move", i === roomData.lastMove);
    cell.disabled = value !== 0 || !canPlay;
    if (value === 0) {
      cell.innerHTML = "";
    } else if (!cell.firstChild) {
      const stone = document.createElement("span");
      stone.className = `stone ${value === 1 ? "black" : "white"}`;
      cell.appendChild(stone);
    }
  }
}

function showResult() {
  let title;
  if (roomData.winner === "draw") title = "무승부예요";
  else if (roomData.winner === myRole) title = "승리했습니다! 🎉";
  else title = "패배했습니다";
  resultTitleEl.textContent = title;
  resultOverlayEl.hidden = false;
}

function startBotGame(difficulty) {
  isBotGame = true;
  botDifficulty = difficulty;
  currentRoomCode = null;
  myRole = humanColor; // "host" (black) or "guest" (white), from the lobby's color picker
  leaveGameBtn.textContent = "나가기";
  resultLeaveBtn.textContent = "나가기";
  const url = new URL(window.location.href);
  url.searchParams.delete("room");
  history.replaceState(null, "", url);

  const humanIsHost = myRole === "host";
  const humanLabel = currentUser ? currentUser.nickname : "나";
  const botLabel = difficulty === "easy" ? "🤖 봇 (쉬움)" : "🤖 봇 (어려움)";
  roomData = {
    hostUid: humanIsHost ? "local-player" : "bot",
    hostNickname: humanIsHost ? humanLabel : botLabel,
    guestUid: humanIsHost ? "bot" : "local-player",
    guestNickname: humanIsHost ? botLabel : humanLabel,
    board: emptyBoard(),
    turn: "host", // black always goes first, whoever picked black
    status: "playing",
    winner: null,
    winLine: null,
    lastMove: null,
    moveCount: 0,
  };
  renderRoom();
  // If the human picked white, the bot (black) has to open -- normally
  // botTakeTurn() only ever runs right after the human's own move.
  if (!humanIsHost) setTimeout(botTakeTurn, BOT_THINK_DELAY_MS);
}

// Applies a move straight to the local roomData object and re-renders --
// used for bot games only, where there's no Firestore doc to write to and
// no second client to race against.
function applyLocalMove(index, role) {
  const value = role === "host" ? 1 : 2;
  const newBoard = [...roomData.board];
  newBoard[index] = value;
  const win = checkWin(newBoard, index, value);
  const isDraw = !win && newBoard.every((v) => v !== 0);
  roomData = {
    ...roomData,
    board: newBoard,
    turn: role === "host" ? "guest" : "host",
    moveCount: roomData.moveCount + 1,
    status: win || isDraw ? "finished" : "playing",
    winner: win ? role : isDraw ? "draw" : null,
    winLine: win || null,
    lastMove: index,
  };
  renderRoom();
}

// Rough (no lookahead/minimax -- just single-move pattern scoring) but
// genuinely non-trivial opponent: always takes an immediate win, always
// blocks an immediate opponent win, and otherwise scores every empty cell
// by how strong a line it would extend for either side (open ends count
// for more than blocked ones, since an open three threatens to become an
// open four next turn) plus a small centrality nudge for early-game ties.
// The bot isn't always white -- the lobby's color picker lets the human
// take either side -- so its stone value is derived from myRole (the
// human's role) rather than hardcoded.
function botRole() {
  return myRole === "host" ? "guest" : "host";
}
function roleValue(role) {
  return role === "host" ? 1 : 2;
}

function patternScore(runLength, openEnds) {
  if (runLength >= 5) return 100000;
  if (runLength === 4) return openEnds === 2 ? 10000 : openEnds === 1 ? 1000 : 0;
  if (runLength === 3) return openEnds === 2 ? 800 : openEnds === 1 ? 150 : 0;
  if (runLength === 2) return openEnds === 2 ? 60 : openEnds === 1 ? 15 : 0;
  return openEnds === 2 ? 5 : 1; // runLength === 1
}

function lineScoreAt(board, index, value) {
  const r0 = Math.floor(index / BOARD_SIZE);
  const c0 = index % BOARD_SIZE;
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  let total = 0;
  for (const [dr, dc] of directions) {
    let runLength = 1;
    let openEnds = 0;
    for (const sign of [1, -1]) {
      let r = r0 + dr * sign;
      let c = c0 + dc * sign;
      while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r * BOARD_SIZE + c] === value) {
        runLength++;
        r += dr * sign;
        c += dc * sign;
      }
      if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r * BOARD_SIZE + c] === 0) openEnds++;
    }
    total += patternScore(runLength, openEnds);
  }
  return total;
}

// Hard mode plays every cell's score exactly (never misses a block, always
// picks the top-scored move). Easy mode uses the same scoring but with two
// knobs that keep it from playing perfectly every turn, so it's still a
// real opponent, not a total pushover: BOT_BLOCK_RELIABILITY is one coin
// flip per turn (not per cell, so a double-threat doesn't get "half
// blocked") deciding whether it even bothers defending this turn, and
// BOT_MISTAKE_CHANCE occasionally has it play a decent-but-not-optimal
// move instead of the top-scored one. Both difficulties always take a
// guaranteed win when one's available -- skipping it would read as
// broken, not "easier."
const BOT_BLOCK_RELIABILITY = 0.7; // easy mode only
const BOT_MISTAKE_CHANCE = 0.3; // easy mode only

function pickBotMove(board) {
  const emptyIndices = [];
  for (let i = 0; i < board.length; i++) if (board[i] === 0) emptyIndices.push(i);
  if (emptyIndices.length === 0) return null;
  if (emptyIndices.length === board.length) return Math.floor(board.length / 2); // empty board -> take the center

  const botValue = roleValue(botRole());
  const humanValue = roleValue(myRole);
  const isEasy = botDifficulty === "easy";
  const willBlock = isEasy ? Math.random() < BOT_BLOCK_RELIABILITY : true;
  const center = (BOARD_SIZE - 1) / 2;
  const scored = [];
  for (const i of emptyIndices) {
    const winBoard = [...board];
    winBoard[i] = botValue;
    if (checkWin(winBoard, i, botValue)) return i; // take a guaranteed win immediately

    const blockBoard = [...board];
    blockBoard[i] = humanValue;
    const mustBlock = !!checkWin(blockBoard, i, humanValue);

    let score = lineScoreAt(board, i, botValue) + lineScoreAt(board, i, humanValue) * 0.9;
    if (mustBlock && willBlock) score += 50000;
    const r = Math.floor(i / BOARD_SIZE);
    const c = i % BOARD_SIZE;
    score += (1 - (Math.abs(r - center) + Math.abs(c - center)) / BOARD_SIZE) * 2;

    scored.push({ i, score });
  }
  scored.sort((a, b) => b.score - a.score);

  if (isEasy && Math.random() < BOT_MISTAKE_CHANCE && scored.length > 1) {
    const pool = scored.slice(1, Math.min(6, scored.length));
    return pool[Math.floor(Math.random() * pool.length)].i;
  }

  const bestScore = scored[0].score;
  const bestMoves = scored.filter((s) => s.score === bestScore).map((s) => s.i);
  return bestMoves[Math.floor(Math.random() * bestMoves.length)];
}

const BOT_THINK_DELAY_MS = 500;

function botTakeTurn() {
  if (!isBotGame || !roomData || roomData.status !== "playing" || roomData.turn !== botRole()) return;
  const move = pickBotMove(roomData.board);
  if (move === null) return;
  applyLocalMove(move, botRole());
}

// Wrapped in a transaction against the live server doc (not the locally
// cached roomData) so two clients racing on the same cell -- e.g. one
// player's snapshot listener is a beat behind after the opponent's last
// move -- can't both write a stone into it; the loser of the race just
// finds board[index] already taken inside the transaction and aborts.
// Bot games skip Firestore entirely and just mutate roomData locally.
async function placeStone(index) {
  if (!roomData) return;
  if (roomData.status !== "playing") return;
  if (roomData.turn !== myRole) return;
  if (roomData.board[index] !== 0) return;

  if (isBotGame) {
    applyLocalMove(index, myRole);
    if (roomData.status === "playing") setTimeout(botTakeTurn, BOT_THINK_DELAY_MS);
    return;
  }
  if (!currentRoomCode) return;

  const fsHandle = await ensureFirestore();
  if (!fsHandle) return;
  const { db, api } = fsHandle;
  const ref = api.doc(db, "omok-rooms", currentRoomCode);
  const myValue = myRole === "host" ? 1 : 2;

  try {
    await api.runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("room gone");
      const data = snap.data();
      if (data.status !== "playing") throw new Error("not playing");
      if (data.turn !== myRole) throw new Error("not your turn");
      if (data.board[index] !== 0) throw new Error("cell already taken");

      const newBoard = [...data.board];
      newBoard[index] = myValue;
      const win = checkWin(newBoard, index, myValue);
      const isDraw = !win && newBoard.every((v) => v !== 0);

      const update = {
        board: newBoard,
        turn: myRole === "host" ? "guest" : "host",
        moveCount: data.moveCount + 1,
        lastMove: index,
        updatedAt: Date.now(),
      };
      if (win) {
        update.status = "finished";
        update.winner = myRole;
        update.winLine = win;
      } else if (isDraw) {
        update.status = "finished";
        update.winner = "draw";
      }
      tx.update(ref, update);
    });
  } catch (err) {
    console.error(err);
  }
}

async function rematch() {
  if (isBotGame) {
    roomData = {
      ...roomData,
      board: emptyBoard(),
      turn: "host",
      status: "playing",
      winner: null,
      winLine: null,
      lastMove: null,
      moveCount: 0,
    };
    renderRoom();
    return;
  }
  if (!currentRoomCode) return;
  const fsHandle = await ensureFirestore();
  if (!fsHandle) return;
  const { db, api } = fsHandle;
  await api.updateDoc(api.doc(db, "omok-rooms", currentRoomCode), {
    board: emptyBoard(),
    turn: "host",
    status: "playing",
    winner: null,
    winLine: null,
    lastMove: null,
    moveCount: 0,
    updatedAt: Date.now(),
  });
}

function showLobbyError(message) {
  lobbyErrorEl.textContent = message;
  lobbyErrorEl.hidden = false;
}

function selectHumanColor(color) {
  humanColor = color;
  colorBlackBtn.classList.toggle("is-selected", color === "host");
  colorWhiteBtn.classList.toggle("is-selected", color === "guest");
}
colorBlackBtn.addEventListener("click", () => selectHumanColor("host"));
colorWhiteBtn.addEventListener("click", () => selectHumanColor("guest"));

botGameEasyBtn.addEventListener("click", () => startBotGame("easy"));
botGameHardBtn.addEventListener("click", () => startBotGame("hard"));

createRoomBtn.addEventListener("click", () => {
  if (!currentUser) {
    showLobbyError("로그인이 필요해요. 위 헤더에서 로그인해주세요.");
    return;
  }
  createRoom();
});
joinRoomBtn.addEventListener("click", () => {
  if (!currentUser) {
    showLobbyError("로그인이 필요해요. 위 헤더에서 로그인해주세요.");
    return;
  }
  joinRoom(joinCodeInputEl.value);
});
joinCodeInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinRoomBtn.click();
});
leaveWaitingBtn.addEventListener("click", leaveRoom);
leaveGameBtn.addEventListener("click", leaveRoom);
resultLeaveBtn.addEventListener("click", leaveRoom);
rematchBtn.addEventListener("click", rematch);

function flashButtonLabel(btn, tempLabel, originalLabel) {
  btn.textContent = tempLabel;
  setTimeout(() => {
    btn.textContent = originalLabel;
  }, 1500);
}

copyLinkBtn.addEventListener("click", async () => {
  const url = `${window.location.origin}${window.__gameBase}?room=${currentRoomCode}`;
  try {
    await navigator.clipboard.writeText(url);
    flashButtonLabel(copyLinkBtn, "복사됨!", "링크 복사");
  } catch {
    // clipboard API unavailable (permissions, insecure context) -- the
    // code is still shown on screen, so this is a nice-to-have, not
    // essential.
  }
});

copyCodeBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentRoomCode);
    flashButtonLabel(copyCodeBtn, "복사됨!", "코드만 복사");
  } catch {
    // see copyLinkBtn above
  }
});

// auth.js calls this once login state is known (both "logged in" and
// "logged out" count as known) and again on every subsequent login/logout.
// A bot game or a room already joined is left alone here -- this only
// decides the *initial* screen / auto-join from a shared link, and only
// the room-based 1v1 modes actually need login (bot mode works logged out).
function onAccountReady() {
  if (isBotGame || currentRoomCode) return;
  const roomParam = new URLSearchParams(window.location.search).get("room");
  if (!currentUser) {
    // Only a shared-room link actually requires login right now -- the
    // default (no room param) screen is the lobby regardless, since bot
    // mode needs no account at all.
    if (roomParam) showScreen("login-required");
    return;
  }
  if (roomParam) {
    joinRoom(roomParam);
  } else {
    showScreen("lobby");
  }
}

// Shown immediately, before Firebase/auth even finishes loading (or at
// all, if it's not configured) -- bot mode needs neither, so there's no
// reason to make the player wait or see a blank page for it. onAccountReady()
// (once auth resolves) only overrides this for the shared-room-link case.
showScreen("lobby");
