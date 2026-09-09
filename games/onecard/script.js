// Login/signup/logout and the shared `currentUser` state live in the
// site-wide ../../auth.js (loaded via a <script> tag before this file, so
// its top-level declarations are plain globals here too, same as
// ../../firebase-config.js's window.__firebaseConfig). Login is required
// (same reasoning as games/omok and games/blackjack) -- several people
// share one table, and a refresh needs to reclaim the right seat.
//
// Hand secrecy: real 원카드 needs your own hand hidden from other players.
// The "properly secure" way is a separate per-uid Firestore document with a
// security rule that only that uid can read -- but this site's established
// model everywhere else (오목's board, 블랙잭's whole table incl. the
// dealer's hidden card) is casual trust, not real security: one shared,
// fully-readable document, and the client just doesn't render what it
// shouldn't show. Deliberately kept the same way here too -- every hand,
// the draw pile, everything lives in one `onecard-tables/{code}` document,
// and renderTable() only ever draws face-up cards for `currentUser`'s own
// hand; everyone else's hand is shown as card backs. Anyone who opens
// devtools mid-game can technically read every hand, same as they always
// could see the dealer's hole card in blackjack -- not solved here, same
// as everywhere else on the site.

const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;
const TABLE_CODE_LENGTH = 6;
const TABLE_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const HAND_SIZE = 7;

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠", "♥", "♦", "♣"];
// House rules kept deliberately small for v1 -- no wild/suit-change card
// (no 8, no joker), no stacking a 2 on a 2, no "원카드!" call-penalty
// bluffing mechanic. Just enough to feel like a real game:
//   A  -- skip the next player
//   2  -- next player draws 2 and is skipped
//   J  -- reverse turn order (with exactly 2 players this has no visible
//         effect -- stepping either direction in a 2-player circle always
//         lands on the same other player -- unlike some house rules where
//         reverse acts as an extra skip in a 1v1. Kept simple on purpose.)
const SPECIAL_RANKS = new Set(["A", "2", "J"]);

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push(rank + suit);
  return deck;
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function cardRank(card) {
  return card.slice(0, -1);
}
function cardSuit(card) {
  return card.slice(-1);
}
function isRedCard(card) {
  const s = cardSuit(card);
  return s === "♥" || s === "♦";
}
function cardsMatch(a, b) {
  return cardSuit(a) === cardSuit(b) || cardRank(a) === cardRank(b);
}

// Mutates `state.drawPile`/`state.discardPile` (a working copy made inside
// a transaction, never the live snapshot data directly) and returns the n
// cards drawn. Reshuffles the discard pile -- everything except its current
// top card, which has to stay visible -- back into the draw pile the
// instant there aren't enough cards left, same as any physical card game
// running out of a deck mid-hand. If there's truly nothing left to
// reshuffle either (astronomically unlikely with 52 cards and small hands),
// just returns fewer cards than asked rather than looping forever.
function drawNCards(state, n) {
  const drawn = [];
  for (let i = 0; i < n; i++) {
    if (state.drawPile.length === 0) {
      if (state.discardPile.length <= 1) break;
      const top = state.discardPile[state.discardPile.length - 1];
      state.drawPile = shuffle(state.discardPile.slice(0, -1));
      state.discardPile = [top];
    }
    drawn.push(state.drawPile.pop());
  }
  return drawn;
}

// Circular turn-order math shared by every place that needs "whose turn is
// it after N steps in the current direction" -- playing an A/2/J, a plain
// draw-and-pass, and leaveTable()'s mid-round handoff all go through this.
function stepIndex(order, fromIdx, direction, steps) {
  const n = order.length;
  return (((fromIdx + direction * steps) % n) + n) % n;
}

const loginRequiredEl = document.getElementById("login-required");
const lobbyScreenEl = document.getElementById("lobby-screen");
const tableScreenEl = document.getElementById("table-screen");

const createTableBtn = document.getElementById("create-table-btn");
const joinCodeInputEl = document.getElementById("join-code-input");
const joinTableBtn = document.getElementById("join-table-btn");
const lobbyErrorEl = document.getElementById("lobby-error");

const tableCodeLabelEl = document.getElementById("table-code-label");
const copyLinkBtn = document.getElementById("copy-link-btn");
const leaveTableBtn = document.getElementById("leave-table-btn");

const directionIndicatorEl = document.getElementById("direction-indicator");
const roundStatusLabelEl = document.getElementById("round-status-label");
const drawPileCountEl = document.getElementById("draw-pile-count");
const discardTopCardEl = document.getElementById("discard-top-card");
const seatsEl = document.getElementById("seats");

const hostControlsEl = document.getElementById("host-controls");
const startRoundBtn = document.getElementById("start-round-btn");
const nextRoundBtn = document.getElementById("next-round-btn");

const myHandAreaEl = document.getElementById("my-hand-area");
const myTurnLabelEl = document.getElementById("my-turn-label");
const myHandEl = document.getElementById("my-hand");
const drawCardBtn = document.getElementById("draw-card-btn");

const SCREENS = {
  "login-required": loginRequiredEl,
  lobby: lobbyScreenEl,
  table: tableScreenEl,
};
function showScreen(name) {
  for (const [key, el] of Object.entries(SCREENS)) el.hidden = key !== name;
}

let currentTableCode = null;
let tableData = null;
let unsubscribeTable = null;

function generateTableCode() {
  let code = "";
  for (let i = 0; i < TABLE_CODE_LENGTH; i++) {
    code += TABLE_CODE_CHARS[Math.floor(Math.random() * TABLE_CODE_CHARS.length)];
  }
  return code;
}

function newSeatedPlayer(nickname) {
  return { nickname, hand: [] };
}

async function createTable() {
  if (!currentUser) return;
  createTableBtn.disabled = true;
  lobbyErrorEl.hidden = true;
  try {
    const fsHandle = await ensureFirestore();
    if (!fsHandle) throw new Error("Firebase not configured");
    const { db, api } = fsHandle;
    let code = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateTableCode();
      const snap = await api.getDoc(api.doc(db, "onecard-tables", candidate));
      if (!snap.exists()) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new Error("could not find a free table code");

    const table = {
      hostUid: currentUser.uid,
      status: "waiting",
      playerOrder: [currentUser.uid],
      players: { [currentUser.uid]: newSeatedPlayer(currentUser.nickname) },
      drawPile: [],
      discardPile: [],
      direction: 1,
      turnUid: null,
      winner: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await api.setDoc(api.doc(db, "onecard-tables", code), table);
    enterTable(code);
  } catch (err) {
    console.error(err);
    lobbyErrorEl.textContent = "테이블 생성 중 문제가 발생했습니다.";
    lobbyErrorEl.hidden = false;
  }
  createTableBtn.disabled = false;
}

async function joinTable(rawCode) {
  if (!currentUser) return;
  const code = (rawCode || "").trim().toUpperCase();
  if (!code) return;
  joinTableBtn.disabled = true;
  lobbyErrorEl.hidden = true;
  try {
    const fsHandle = await ensureFirestore();
    if (!fsHandle) throw new Error("Firebase not configured");
    const { db, api } = fsHandle;
    const ref = api.doc(db, "onecard-tables", code);

    let joinError = null;
    await api.runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) {
        joinError = "존재하지 않는 테이블 코드입니다.";
        return;
      }
      const data = snap.data();
      if (data.players[currentUser.uid]) return; // already seated -- just rejoin
      if (data.status !== "waiting") {
        joinError = "이미 게임이 진행 중인 테이블입니다.";
        return;
      }
      if (data.playerOrder.length >= MAX_PLAYERS) {
        joinError = `테이블이 꽉 찼습니다 (최대 ${MAX_PLAYERS}명).`;
        return;
      }
      tx.update(ref, {
        playerOrder: [...data.playerOrder, currentUser.uid],
        [`players.${currentUser.uid}`]: newSeatedPlayer(currentUser.nickname),
        updatedAt: Date.now(),
      });
    });

    if (joinError) {
      lobbyErrorEl.textContent = joinError;
      lobbyErrorEl.hidden = false;
      return;
    }
    enterTable(code);
  } catch (err) {
    console.error(err);
    lobbyErrorEl.textContent = "테이블 참가 중 문제가 발생했습니다.";
    lobbyErrorEl.hidden = false;
  }
  joinTableBtn.disabled = false;
}

function enterTable(code) {
  currentTableCode = code;
  const url = new URL(window.location.href);
  url.searchParams.set("table", code);
  history.replaceState(null, "", url);
  subscribeTable(code);
}

async function subscribeTable(code) {
  if (unsubscribeTable) unsubscribeTable();
  const fsHandle = await ensureFirestore();
  if (!fsHandle) return;
  const { db, api } = fsHandle;
  unsubscribeTable = api.onSnapshot(
    api.doc(db, "onecard-tables", code),
    (snap) => {
      if (!snap.exists()) {
        lobbyErrorEl.textContent = "테이블을 찾을 수 없습니다 (삭제되었거나 코드가 잘못됐어요).";
        lobbyErrorEl.hidden = false;
        leaveTable();
        return;
      }
      tableData = snap.data();
      renderTable();
    },
    (err) => console.error(err)
  );
}

// Shared "remove this one seat" logic for leaveTable() -- unlike blackjack,
// removing a player mid-round also has to correctly hand off whatever
// turn/direction state they were holding, since turn order here is purely
// positional (not "find the next still-active player" like blackjack's
// bet/stand states).
function buildRemovePlayerUpdate(data, uid) {
  const newOrder = data.playerOrder.filter((u) => u !== uid);
  if (newOrder.length === 0) {
    return {
      full: {
        hostUid: null,
        status: "waiting",
        playerOrder: [],
        players: {},
        drawPile: [],
        discardPile: [],
        direction: 1,
        turnUid: null,
        winner: null,
        createdAt: data.createdAt,
        updatedAt: Date.now(),
      },
    };
  }
  const newPlayers = { ...data.players };
  delete newPlayers[uid];
  const patch = { playerOrder: newOrder, players: newPlayers, updatedAt: Date.now() };
  if (data.hostUid === uid) patch.hostUid = newOrder[0];

  if (data.status === "playing") {
    if (newOrder.length === 1) {
      // Last one standing -- the round's effectively over.
      patch.status = "roundOver";
      patch.winner = newOrder[0];
      patch.turnUid = null;
    } else if (data.turnUid === uid) {
      // Walk the OLD order/direction starting right after the leaving
      // player until we land on someone who isn't them -- looking this up
      // by uid (not by index into the new, now-shorter array) means it's
      // correct regardless of how removal reshuffled everyone's indices.
      const oldOrder = data.playerOrder;
      const oldIdx = oldOrder.indexOf(uid);
      for (let i = 1; i <= oldOrder.length; i++) {
        const candidate = oldOrder[stepIndex(oldOrder, oldIdx, data.direction, i)];
        if (candidate !== uid) {
          patch.turnUid = candidate;
          break;
        }
      }
    }
  }
  return { patch };
}

// Explicit "나가기" click -- unlike a refresh (which never calls this at
// all, so the "already seated -> rejoin" path in joinTable() still works
// for that case), this really does vacate the seat in Firestore, same
// reasoning as games/blackjack's leaveTable().
async function leaveTable() {
  const codeLeaving = currentTableCode;
  const uidLeaving = currentUser ? currentUser.uid : null;

  if (unsubscribeTable) {
    unsubscribeTable();
    unsubscribeTable = null;
  }
  currentTableCode = null;
  tableData = null;
  const url = new URL(window.location.href);
  url.searchParams.delete("table");
  history.replaceState(null, "", url);
  showScreen("lobby");

  if (!codeLeaving || !uidLeaving) return;
  try {
    const fsHandle = await ensureFirestore();
    if (!fsHandle) return;
    const { db, api } = fsHandle;
    const ref = api.doc(db, "onecard-tables", codeLeaving);
    await api.runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      const data = snap.data();
      if (!data.players[uidLeaving]) return;
      const removed = buildRemovePlayerUpdate(data, uidLeaving);
      if (removed.full) tx.set(ref, removed.full);
      else tx.update(ref, removed.patch);
    });
  } catch (err) {
    console.error(err);
  }
}

// Shared by starting the very first round and every "다음 판" afterwards --
// host-only, plain updateDoc (not a transaction) since only the host is
// ever allowed to call this, same precedent as games/blackjack's
// startRound(). Deals HAND_SIZE cards to each seated player and flips a
// starting discard card.
async function startRound() {
  if (!tableData || !currentUser || currentUser.uid !== tableData.hostUid) return;
  if (tableData.playerOrder.length < MIN_PLAYERS) return;
  const fsHandle = await ensureFirestore();
  if (!fsHandle) return;
  const { db, api } = fsHandle;
  const ref = api.doc(db, "onecard-tables", currentTableCode);

  const order = tableData.playerOrder;
  const deck = shuffle(buildDeck());
  const update = { updatedAt: Date.now() };
  for (const uid of order) {
    update[`players.${uid}.hand`] = deck.splice(-HAND_SIZE, HAND_SIZE);
  }

  // The starting discard card shouldn't be a special one -- there's no
  // sensible "who does the effect apply to" before anyone's had a turn.
  // Keep popping until a plain card turns up, stashing skipped specials
  // aside and shuffling them back into the deck once we have one.
  const burned = [];
  let starter = null;
  while (deck.length > 0) {
    const card = deck.pop();
    if (SPECIAL_RANKS.has(cardRank(card))) {
      burned.push(card);
      continue;
    }
    starter = card;
    break;
  }
  // Deck was somehow all-special (essentially impossible with a real 52
  // card deck and <=6 players) -- just accept one rather than looping
  // forever; its effect simply doesn't apply since nobody "played" it.
  if (!starter && burned.length > 0) starter = burned.pop();
  deck.push(...burned);

  update.discardPile = starter ? [starter] : [];
  update.drawPile = deck;
  update.direction = 1;
  update.turnUid = order[0];
  update.status = "playing";
  update.winner = null;
  await api.updateDoc(ref, update);
}

// Plays one card from my own hand. A transaction (unlike blackjack's plain
// updateDoc for hit/stand) because -- same reasoning as games/omok's
// placeStone() -- this client's own cached tableData can be a beat behind
// right after the previous player's move, and re-validating "is it
// actually still my turn, does this card actually still match the top"
// against a fresh read at commit time is exactly what a transaction is for.
async function playCard(card) {
  if (!tableData || !currentUser || !currentTableCode) return;
  const fsHandle = await ensureFirestore();
  if (!fsHandle) return;
  const { db, api } = fsHandle;
  const ref = api.doc(db, "onecard-tables", currentTableCode);
  const uid = currentUser.uid;

  try {
    await api.runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("table gone");
      const data = snap.data();
      if (data.status !== "playing" || data.turnUid !== uid) throw new Error("not your turn");
      const me = data.players[uid];
      const idx = me.hand.indexOf(card);
      if (idx === -1) throw new Error("card not in hand");
      const top = data.discardPile[data.discardPile.length - 1];
      if (!top || !cardsMatch(card, top)) throw new Error("card doesn't match the discard pile");

      const order = data.playerOrder;
      const myIdx = order.indexOf(uid);
      const newHand = [...me.hand];
      newHand.splice(idx, 1);

      const state = { drawPile: [...data.drawPile], discardPile: [...data.discardPile, card] };
      const update = { updatedAt: Date.now() };
      update[`players.${uid}.hand`] = newHand;

      if (newHand.length === 0) {
        update.status = "roundOver";
        update.winner = uid;
        update.turnUid = null;
        update.drawPile = state.drawPile;
        update.discardPile = state.discardPile;
        tx.update(ref, update);
        return;
      }

      const rank = cardRank(card);
      let direction = data.direction;
      let steps = 1;
      if (rank === "J") {
        direction = -direction;
      } else if (rank === "A") {
        steps = 2;
      } else if (rank === "2") {
        const victimIdx = stepIndex(order, myIdx, direction, 1);
        const victimUid = order[victimIdx];
        const drawn = drawNCards(state, 2);
        update[`players.${victimUid}.hand`] = [...data.players[victimUid].hand, ...drawn];
        steps = 2;
      }

      update.turnUid = order[stepIndex(order, myIdx, direction, steps)];
      update.direction = direction;
      update.drawPile = state.drawPile;
      update.discardPile = state.discardPile;
      tx.update(ref, update);
    });
  } catch (err) {
    console.error(err);
  }
}

// Draw exactly one card and pass the turn -- always available on your own
// turn (no "you must play if you have a valid card" enforcement; simpler
// and avoids a whole "does this hand have any playable card" check that
// could itself have bugs and soft-lock someone who genuinely has none).
async function drawCard() {
  if (!tableData || !currentUser || !currentTableCode) return;
  const fsHandle = await ensureFirestore();
  if (!fsHandle) return;
  const { db, api } = fsHandle;
  const ref = api.doc(db, "onecard-tables", currentTableCode);
  const uid = currentUser.uid;

  try {
    await api.runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error("table gone");
      const data = snap.data();
      if (data.status !== "playing" || data.turnUid !== uid) throw new Error("not your turn");

      const order = data.playerOrder;
      const myIdx = order.indexOf(uid);
      const state = { drawPile: [...data.drawPile], discardPile: [...data.discardPile] };
      const drawn = drawNCards(state, 1);
      const me = data.players[uid];

      tx.update(ref, {
        [`players.${uid}.hand`]: [...me.hand, ...drawn],
        drawPile: state.drawPile,
        discardPile: state.discardPile,
        turnUid: order[stepIndex(order, myIdx, data.direction, 1)],
        updatedAt: Date.now(),
      });
    });
  } catch (err) {
    console.error(err);
  }
}

function renderCard(card) {
  const el = document.createElement("div");
  el.className = "playing-card" + (isRedCard(card) ? " red" : "");
  el.textContent = card;
  return el;
}
function renderCardBack() {
  const el = document.createElement("div");
  el.className = "playing-card back";
  return el;
}

function renderTable() {
  if (!tableData || !currentUser) return;
  showScreen("table");
  tableCodeLabelEl.textContent = `테이블 코드: ${currentTableCode}`;

  const isHost = currentUser.uid === tableData.hostUid;
  const me = tableData.players[currentUser.uid];

  directionIndicatorEl.textContent = tableData.status === "playing"
    ? (tableData.direction === 1 ? "↻ 시계 방향" : "↺ 반시계 방향")
    : "";

  drawPileCountEl.textContent = tableData.drawPile.length;
  discardTopCardEl.innerHTML = "";
  const top = tableData.discardPile[tableData.discardPile.length - 1];
  if (top) discardTopCardEl.appendChild(renderCard(top));

  const statusText = {
    waiting: isHost
      ? (tableData.playerOrder.length < MIN_PLAYERS ? `${MIN_PLAYERS}명 이상 모이면 시작할 수 있어요.` : "\"게임 시작\"을 눌러 라운드를 시작하세요.")
      : "방장이 게임을 시작하길 기다리는 중...",
    playing: tableData.turnUid === currentUser.uid ? "내 차례입니다!" : `${tableData.players[tableData.turnUid]?.nickname || "상대"}의 차례...`,
    roundOver: tableData.winner === currentUser.uid ? "승리했습니다! 🎉" : `${tableData.players[tableData.winner]?.nickname || "누군가"}가 승리했습니다.`,
  };
  roundStatusLabelEl.textContent = statusText[tableData.status] || "";

  // Seats -- always exactly MAX_PLAYERS chairs (same reasoning as
  // games/blackjack), showing every other player's hand as card BACKS
  // only (see the file header on hand secrecy) plus a live card count.
  seatsEl.innerHTML = "";
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const uid = tableData.playerOrder[i];
    const p = uid ? tableData.players[uid] : null;
    const seat = document.createElement("div");
    seat.className = "seat";

    const chairIcon = document.createElement("span");
    chairIcon.className = "seat-chair-icon";
    chairIcon.textContent = "🪑";
    seat.appendChild(chairIcon);

    if (!p) {
      seat.classList.add("seat-empty");
      const emptyLabel = document.createElement("p");
      emptyLabel.className = "seat-empty-label";
      emptyLabel.textContent = "빈 자리";
      seat.appendChild(emptyLabel);
      seatsEl.appendChild(seat);
      continue;
    }
    if (uid === tableData.turnUid) seat.classList.add("is-turn");
    if (uid === currentUser.uid) seat.classList.add("is-me");
    if (tableData.status === "roundOver" && uid === tableData.winner) seat.classList.add("is-winner");

    const nameRow = document.createElement("div");
    nameRow.className = "seat-name-row";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = p.nickname + (uid === tableData.hostUid ? " 👑" : "") + (uid === currentUser.uid ? " (나)" : "");
    const countSpan = document.createElement("span");
    countSpan.className = "seat-chips";
    countSpan.textContent = `${p.hand.length}장`;
    nameRow.appendChild(nameSpan);
    nameRow.appendChild(countSpan);
    seat.appendChild(nameRow);

    if (p.hand.length > 0) {
      const handRow = document.createElement("div");
      handRow.className = "hand-row";
      for (let j = 0; j < Math.min(p.hand.length, HAND_SIZE); j++) handRow.appendChild(renderCardBack());
      seat.appendChild(handRow);
    }

    seatsEl.appendChild(seat);
  }

  // Host controls
  hostControlsEl.hidden = !isHost;
  startRoundBtn.hidden = tableData.status !== "waiting";
  startRoundBtn.disabled = tableData.playerOrder.length < MIN_PLAYERS;
  nextRoundBtn.hidden = tableData.status !== "roundOver";

  // My hand
  const iAmPlaying = tableData.status === "playing" && !!me;
  myHandAreaEl.hidden = !iAmPlaying;
  if (iAmPlaying) {
    const myTurn = tableData.turnUid === currentUser.uid;
    myTurnLabelEl.textContent = myTurn ? "내 차례입니다 -- 카드를 내거나 뽑으세요." : "상대 차례를 기다리는 중...";
    myHandEl.innerHTML = "";
    me.hand.forEach((card) => {
      const el = renderCard(card);
      el.classList.add("hand-card");
      const playable = myTurn && top && cardsMatch(card, top);
      if (playable) {
        el.classList.add("playable");
        el.addEventListener("click", () => playCard(card));
      } else {
        el.classList.add("unplayable");
      }
      myHandEl.appendChild(el);
    });
    drawCardBtn.disabled = !myTurn;
  }
}

createTableBtn.addEventListener("click", createTable);
joinTableBtn.addEventListener("click", () => joinTable(joinCodeInputEl.value));
joinCodeInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinTableBtn.click();
});
leaveTableBtn.addEventListener("click", leaveTable);
startRoundBtn.addEventListener("click", startRound);
nextRoundBtn.addEventListener("click", startRound);
drawCardBtn.addEventListener("click", drawCard);

copyLinkBtn.addEventListener("click", async () => {
  const url = `${window.location.origin}${window.__gameBase}?table=${currentTableCode}`;
  try {
    await navigator.clipboard.writeText(url);
    copyLinkBtn.textContent = "복사됨!";
    setTimeout(() => (copyLinkBtn.textContent = "링크 복사"), 1500);
  } catch {
    // clipboard API unavailable -- the code is still shown on screen
  }
});

// auth.js calls this once login state is known (both "logged in" and
// "logged out" count as known) and again on every subsequent login/logout.
function onAccountReady() {
  if (currentTableCode) return;
  if (!currentUser) {
    showScreen("login-required");
    return;
  }
  const tableParam = new URLSearchParams(window.location.search).get("table");
  if (tableParam) {
    joinTable(tableParam);
  } else {
    showScreen("lobby");
  }
}

// Shown immediately while auth is still resolving so the page doesn't sit
// blank; onAccountReady() (fired once login state is actually known)
// corrects this to login-required for a guest.
showScreen("lobby");

// If Firebase isn't configured at all, onAccountReady() never fires
// (auth.js's isFirebaseConfigured() guard skips initAuthListener()) --
// without this, the page would sit on the "lobby" default above forever
// with dead create/join buttons instead of explaining why.
if (!window.__firebaseConfig || (window.__firebaseConfig.apiKey || "").startsWith("YOUR_")) {
  showScreen("login-required");
}
