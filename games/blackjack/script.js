// Login/signup/logout and the shared `currentUser` state live in the
// site-wide ../../auth.js (loaded via a <script> tag before this file, so
// its top-level declarations are plain globals here too, same as
// ../../firebase-config.js's window.__firebaseConfig). Login is required
// (same reasoning as games/omok) -- several people share one table, and a
// refresh needs to reclaim the right seat.
//
// Chips are a real "buy-in" against the account's site-wide totalScore --
// deliberately, for a bit of actual stakes (see the commit message for the
// discussion). A player starts a table with 0 chips and has to explicitly
// "환전" (exchange) some of their real score for chips before betting;
// they can "현금화" (cash out) chips back to real score any time they're
// not mid-turn. Only those two explicit actions touch totalScore, and a
// player only ever does so to their OWN account doc -- exactly the
// existing "only your own account doc" Firestore rule, no changes needed
// there beyond allowing totalScore to decrease (a buy-in spends it).
//
// Everything WITHIN a round (bets, hits, wins, losses) only ever moves
// chips -- the ephemeral, host-resolved table-local field it always was.
// A loss during play never touches your real score; only cashing out
// (or not) decides whether a session's chip swings actually stick.
//
// There's no player-vs-player secrecy in blackjack (everyone's hand is
// always visible at a real table; only the dealer's hole card is hidden),
// so unlike a hypothetical hidden-hand game there's no need for
// per-player-readable Firestore documents -- the whole table is one
// shared, fully-readable document, same shape as games/omok's room.

const MAX_PLAYERS = 6;
const TABLE_CODE_LENGTH = 6;
const TABLE_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠", "♥", "♦", "♣"];

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push(rank + suit);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
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
function cardValue(card) {
  const rank = cardRank(card);
  if (rank === "A") return 11;
  if (rank === "J" || rank === "Q" || rank === "K") return 10;
  return parseInt(rank, 10);
}
// Aces count as 11 unless that would bust the hand, in which case they
// drop to 1 one at a time -- the standard "soft/hard hand" rule.
function handValue(hand) {
  let total = 0;
  let aces = 0;
  for (const c of hand) {
    total += cardValue(c);
    if (cardRank(c) === "A") aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}
function isBust(hand) {
  return handValue(hand) > 21;
}
// A "natural" -- 21 from the first two cards. Doesn't get to hit at all,
// and pays 3:2 instead of 1:1. (Doesn't apply to a 21 reached by hitting
// later -- that's just a normal 21.)
function isNaturalBlackjack(hand) {
  return hand.length === 2 && handValue(hand) === 21;
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

const myScoreLabelEl = document.getElementById("my-score-label");
const myChipsLabelEl = document.getElementById("my-chips-label");
const exchangeAmountInputEl = document.getElementById("exchange-amount-input");
const buyChipsBtn = document.getElementById("buy-chips-btn");
const cashOutBtn = document.getElementById("cash-out-btn");

const dealerHandEl = document.getElementById("dealer-hand");
const dealerValueEl = document.getElementById("dealer-value");
const roundStatusLabelEl = document.getElementById("round-status-label");
const seatsEl = document.getElementById("seats");

const hostControlsEl = document.getElementById("host-controls");
const startRoundBtn = document.getElementById("start-round-btn");
const nextRoundBtn = document.getElementById("next-round-btn");

const myControlsEl = document.getElementById("my-controls");
const betControlsEl = document.getElementById("bet-controls");
const betAmountLabelEl = document.getElementById("bet-amount-label");
const betResetBtn = document.getElementById("bet-reset-btn");
const betAllinBtn = document.getElementById("bet-allin-btn");
const confirmBetBtn = document.getElementById("confirm-bet-btn");
const actionControlsEl = document.getElementById("action-controls");
const hitBtn = document.getElementById("hit-btn");
const standBtn = document.getElementById("stand-btn");
const doubleBtn = document.getElementById("double-btn");
const myHandValueLabelEl = document.getElementById("my-hand-value-label");

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
let pendingBetAmount = 0;
let dealerResolving = false; // local re-entrancy guard, see resolveDealerTurn()
let dealing = false; // local re-entrancy guard, see maybeDeal()

function generateTableCode() {
  let code = "";
  for (let i = 0; i < TABLE_CODE_LENGTH; i++) {
    code += TABLE_CODE_CHARS[Math.floor(Math.random() * TABLE_CODE_CHARS.length)];
  }
  return code;
}

function newSeatedPlayer(nickname) {
  return { nickname, chips: 0, bet: 0, hand: [], status: "seated", result: null };
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
      const snap = await api.getDoc(api.doc(db, "blackjack-tables", candidate));
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
      deck: [],
      dealerHand: [],
      dealerRevealed: false,
      turnUid: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await api.setDoc(api.doc(db, "blackjack-tables", code), table);
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
    const ref = api.doc(db, "blackjack-tables", code);

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
    api.doc(db, "blackjack-tables", code),
    (snap) => {
      if (!snap.exists()) {
        lobbyErrorEl.textContent = "테이블을 찾을 수 없습니다 (삭제되었거나 코드가 잘못됐어요).";
        lobbyErrorEl.hidden = false;
        leaveTable();
        return;
      }
      tableData = snap.data();
      renderTable();
      // The host's client is the sole authority for playing out the
      // dealer's hand (see resolveDealerTurn()) -- reacting here means it
      // fires the instant every player has stood/bust, without a button.
      // Same idea for maybeDeal() -- every confirmed bet re-renders the
      // table for everyone, and this checks (using this fresh snapshot,
      // not a stale local copy) whether that was the last one needed.
      if (currentUser && currentUser.uid === tableData.hostUid) {
        if (tableData.status === "betting") maybeDeal();
        else if (tableData.status === "dealerTurn") resolveDealerTurn();
      }
    },
    (err) => console.error(err)
  );
}

function leaveTable() {
  if (unsubscribeTable) {
    unsubscribeTable();
    unsubscribeTable = null;
  }
  currentTableCode = null;
  tableData = null;
  pendingBetAmount = 0;
  const url = new URL(window.location.href);
  url.searchParams.delete("table");
  history.replaceState(null, "", url);
  showScreen("lobby");
}

// Shared by starting the very first round and every "다음 판" afterwards --
// resets every seated player's hand/bet/status and moves the table into
// "betting". Chips are left untouched here -- they only ever change via
// betting/payouts during a round or an explicit 환전/현금화 (see the file
// header), never reset by starting a new one. A player sitting on 0 chips
// just can't bet anything until they buy back in.
async function startRound() {
  if (!tableData || !currentUser || currentUser.uid !== tableData.hostUid) return;
  const fsHandle = await ensureFirestore();
  if (!fsHandle) return;
  const { db, api } = fsHandle;
  const ref = api.doc(db, "blackjack-tables", currentTableCode);

  const update = {
    status: "betting",
    deck: [],
    dealerHand: [],
    dealerRevealed: false,
    turnUid: null,
    updatedAt: Date.now(),
  };
  for (const uid of tableData.playerOrder) {
    update[`players.${uid}.bet`] = 0;
    update[`players.${uid}.hand`] = [];
    // A player with 0 chips can't bet anything anyway -- skip straight to
    // sitting-out instead of putting them through the betting screen just
    // to watch their bet clamp to 0. They still see the table and can buy
    // in (환전) for the next round.
    update[`players.${uid}.status`] = tableData.players[uid].chips > 0 ? "betting" : "sitting-out";
    update[`players.${uid}.result`] = null;
  }
  await api.updateDoc(ref, update);
}

async function confirmBet(amount) {
  if (!tableData || !currentUser) return;
  const me = tableData.players[currentUser.uid];
  if (!me || me.status !== "betting") return;
  const clamped = Math.max(0, Math.min(amount, me.chips));
  const fsHandle = await ensureFirestore();
  if (!fsHandle) return;
  const { db, api } = fsHandle;
  const ref = api.doc(db, "blackjack-tables", currentTableCode);
  await api.updateDoc(ref, {
    [`players.${currentUser.uid}.bet`]: clamped,
    [`players.${currentUser.uid}.status`]: clamped > 0 ? "waiting-deal" : "sitting-out",
    updatedAt: Date.now(),
  });
  // Dealing is triggered reactively from the host's snapshot listener (see
  // subscribeTable()), not from here -- this client's own local `tableData`
  // hasn't been updated with the bet just written above yet, so checking
  // readiness against it here would use stale data and could wrongly
  // decide "not everyone's ready" even when this was the last bet needed.
}

// Spends real site score for table chips -- the only place chips ever
// come from (see the file header). Wrapped in a transaction spanning both
// documents (the account doc and the table doc) so a mid-flight failure
// can't dock your score without ever actually granting the chips -- two
// separate non-transactional writes would risk exactly that. A player can
// only ever do this to their own account doc, so it fits the existing
// "only your own account" Firestore rule with just one change: that rule
// has to start allowing totalScore to *decrease* too, since every other
// game on the site only ever adds to it.
async function buyChips(amount) {
  if (!tableData || !currentUser || !currentTableCode) return;
  const requested = Math.max(0, Math.floor(amount));
  if (requested <= 0) return;
  const fsHandle = await ensureFirestore();
  if (!fsHandle) return;
  const { db, api } = fsHandle;
  const userRef = api.doc(db, "crossword-users", currentUser.uid);
  const tableRefDoc = api.doc(db, "blackjack-tables", currentTableCode);
  let newScore = null;
  try {
    await api.runTransaction(db, async (tx) => {
      const userSnap = await tx.get(userRef);
      const tableSnap = await tx.get(tableRefDoc);
      const userData = userSnap.data();
      const liveTable = tableSnap.data();
      const spend = Math.min(requested, userData.totalScore);
      if (spend <= 0) return;
      newScore = userData.totalScore - spend;
      tx.update(userRef, { totalScore: newScore });
      tx.update(tableRefDoc, {
        [`players.${currentUser.uid}.chips`]: (liveTable.players[currentUser.uid]?.chips || 0) + spend,
        updatedAt: Date.now(),
      });
    });
    if (newScore !== null) {
      currentUser.totalScore = newScore;
      if (typeof renderAccountUI === "function") renderAccountUI();
      // The table doc's own onSnapshot listener can fire (from the write
      // inside the transaction above) before this line runs, so it may
      // have already re-rendered the table screen using the OLD
      // currentUser.totalScore -- re-render now that it's actually
      // current, or the 내 점수 line here would lag behind the account
      // header (which renderAccountUI() above always gets right).
      renderTable();
    }
  } catch (err) {
    console.error(err);
  }
}

// The other half of the buy-in/cash-out pair -- converts chips back to
// real score, same cross-document transaction for the same reason. Only
// allowed outside of an active hand (not mid-turn) so a player can't cash
// out to dodge a bet they've already committed to.
async function cashOutChips() {
  if (!tableData || !currentUser || !currentTableCode) return;
  if (tableData.status === "playing" && tableData.turnUid === currentUser.uid) return;
  const fsHandle = await ensureFirestore();
  if (!fsHandle) return;
  const { db, api } = fsHandle;
  const userRef = api.doc(db, "crossword-users", currentUser.uid);
  const tableRefDoc = api.doc(db, "blackjack-tables", currentTableCode);
  let newScore = null;
  try {
    await api.runTransaction(db, async (tx) => {
      const userSnap = await tx.get(userRef);
      const tableSnap = await tx.get(tableRefDoc);
      const userData = userSnap.data();
      const liveTable = tableSnap.data();
      const amount = liveTable.players[currentUser.uid]?.chips || 0;
      if (amount <= 0) return;
      newScore = userData.totalScore + amount;
      tx.update(userRef, { totalScore: newScore });
      tx.update(tableRefDoc, { [`players.${currentUser.uid}.chips`]: 0, updatedAt: Date.now() });
    });
    if (newScore !== null) {
      currentUser.totalScore = newScore;
      if (typeof renderAccountUI === "function") renderAccountUI();
      // The table doc's own onSnapshot listener can fire (from the write
      // inside the transaction above) before this line runs, so it may
      // have already re-rendered the table screen using the OLD
      // currentUser.totalScore -- re-render now that it's actually
      // current, or the 내 점수 line here would lag behind the account
      // header (which renderAccountUI() above always gets right).
      renderTable();
    }
  } catch (err) {
    console.error(err);
  }
}

// Runs on the host's client only, via the snapshot listener -- once nobody
// is still deciding their bet, deals the round.
function allPlayersReadyToDeal(data) {
  return data.playerOrder.every((uid) => data.players[uid].status !== "betting");
}

async function maybeDeal() {
  if (dealing || !tableData || tableData.status !== "betting") return;
  if (!allPlayersReadyToDeal(tableData)) return;
  dealing = true;
  // try/finally, not try/catch-then-a-statement -- the early `return`s below
  // (fsHandle missing, nobody actually bet) exit the whole function, so a
  // plain statement after the try/catch never ran on those paths and
  // `dealing` stayed stuck `true` forever. That's exactly what happened
  // when every seated player bet 0: the "back to waiting" write went
  // through fine, but every *following* attempt to deal silently no-opped
  // on the `if (dealing ...) return;` guard above, since it was never
  // cleared -- the table just sat on "betting" permanently.
  try {
    const activeUids = tableData.playerOrder.filter((uid) => tableData.players[uid].bet > 0);
    const fsHandle = await ensureFirestore();
    if (!fsHandle) return;
    const { db, api } = fsHandle;
    const ref = api.doc(db, "blackjack-tables", currentTableCode);

    if (activeUids.length === 0) {
      // nobody actually bet anything -- back to waiting rather than dealing
      // a round nobody's playing
      await api.updateDoc(ref, { status: "waiting", updatedAt: Date.now() });
      return;
    }

    const deck = buildDeck();
    const dealerHand = [deck.pop(), deck.pop()];
    const update = { deck, dealerHand, dealerRevealed: false, updatedAt: Date.now() };
    for (const uid of tableData.playerOrder) {
      if (!activeUids.includes(uid)) continue;
      const hand = [deck.pop(), deck.pop()];
      update[`players.${uid}.hand`] = hand;
      update[`players.${uid}.status`] = isNaturalBlackjack(hand) ? "blackjack" : "playing";
    }
    const firstTurnUid = activeUids.find((uid) => update[`players.${uid}.status`] === "playing") || null;
    update.turnUid = firstTurnUid;
    update.status = firstTurnUid ? "playing" : "dealerTurn";
    await api.updateDoc(ref, update);
  } catch (err) {
    console.error(err);
  } finally {
    dealing = false;
  }
}

// Searches every OTHER seat in turn order, starting right after afterUid,
// for one still mid-decision ("playing"). Deliberately `i < order.length`
// (not `<=`) so it never wraps back around to check afterUid's own slot --
// `data` here is the pre-update snapshot, where afterUid's status still
// reads "playing" (the caller hasn't written its new stand/bust status
// yet), so an inclusive wraparound would find afterUid "still playing"
// and hand the turn right back to them -- an infinite loop with just one
// active player (the most common case: playing solo against the dealer).
function findNextTurnUid(data, afterUid) {
  const order = data.playerOrder;
  const startIdx = order.indexOf(afterUid);
  for (let i = 1; i < order.length; i++) {
    const uid = order[(startIdx + i) % order.length];
    if (data.players[uid].status === "playing") return uid;
  }
  return null;
}

async function playerAction(action) {
  if (!tableData || !currentUser) return;
  const uid = currentUser.uid;
  if (tableData.status !== "playing" || tableData.turnUid !== uid) return;
  const me = tableData.players[uid];
  const fsHandle = await ensureFirestore();
  if (!fsHandle) return;
  const { db, api } = fsHandle;
  const ref = api.doc(db, "blackjack-tables", currentTableCode);

  const deck = [...tableData.deck];
  const hand = [...me.hand];
  const update = { updatedAt: Date.now() };
  let finishesTurn = false;
  let newBet = me.bet;

  if (action === "hit") {
    hand.push(deck.pop());
    if (isBust(hand)) {
      update[`players.${uid}.status`] = "bust";
      finishesTurn = true;
    }
  } else if (action === "stand") {
    update[`players.${uid}.status`] = "stand";
    finishesTurn = true;
  } else if (action === "double") {
    if (hand.length !== 2 || me.chips < me.bet * 2) return;
    newBet = me.bet * 2;
    hand.push(deck.pop());
    update[`players.${uid}.status`] = isBust(hand) ? "bust" : "stand";
    finishesTurn = true;
  } else {
    return;
  }

  update[`players.${uid}.hand`] = hand;
  update[`players.${uid}.bet`] = newBet;
  update.deck = deck;
  if (finishesTurn) {
    const next = findNextTurnUid(tableData, uid);
    update.turnUid = next;
    if (!next) update.status = "dealerTurn";
  }
  await api.updateDoc(ref, update);
}

// Host-only, triggered reactively (see subscribeTable()) the instant every
// player has stood or bust. Plays the dealer out with the simplest common
// rule (stands on any total of 17+, including a "soft" 17) and settles
// every active player's chips against the final dealer hand.
async function resolveDealerTurn() {
  if (dealerResolving || !tableData) return;
  dealerResolving = true;
  // try/finally -- see the identical fix + explanation in maybeDeal() above.
  try {
    let dealerHand = [...tableData.dealerHand];
    let deck = [...tableData.deck];
    while (handValue(dealerHand) < 17) dealerHand.push(deck.pop());
    const dealerBust = isBust(dealerHand);
    const dealerValue = handValue(dealerHand);
    const dealerHasBlackjack = isNaturalBlackjack(dealerHand);

    const update = {
      dealerHand,
      dealerRevealed: true,
      deck,
      status: "roundOver",
      turnUid: null,
      updatedAt: Date.now(),
    };
    for (const uid of tableData.playerOrder) {
      const p = tableData.players[uid];
      if (p.bet <= 0) continue; // sat out this round
      let result;
      let chipDelta;
      if (p.status === "bust") {
        result = "lose";
        chipDelta = -p.bet;
      } else if (p.status === "blackjack") {
        if (dealerHasBlackjack) {
          result = "push";
          chipDelta = 0;
        } else {
          result = "blackjack";
          chipDelta = Math.floor(p.bet * 1.5);
        }
      } else if (dealerBust) {
        result = "win";
        chipDelta = p.bet;
      } else {
        const myValue = handValue(p.hand);
        if (myValue > dealerValue) {
          result = "win";
          chipDelta = p.bet;
        } else if (myValue < dealerValue) {
          result = "lose";
          chipDelta = -p.bet;
        } else {
          result = "push";
          chipDelta = 0;
        }
      }
      update[`players.${uid}.result`] = result;
      update[`players.${uid}.chips`] = p.chips + chipDelta;
    }
    const fsHandle = await ensureFirestore();
    if (!fsHandle) return;
    const { db, api } = fsHandle;
    await api.updateDoc(api.doc(db, "blackjack-tables", currentTableCode), update);
  } catch (err) {
    console.error(err);
  } finally {
    dealerResolving = false;
  }
}

function renderCard(card, faceDown) {
  const el = document.createElement("div");
  if (faceDown) {
    el.className = "playing-card back";
    el.textContent = "";
    return el;
  }
  el.className = "playing-card" + (isRedCard(card) ? " red" : "");
  el.textContent = card;
  return el;
}

const RESULT_LABELS = {
  win: "승리",
  lose: "패배",
  push: "무승부",
  blackjack: "블랙잭! 🎉",
};
const RESULT_CLASSES = {
  win: "outcome-win",
  lose: "outcome-lose",
  push: "",
  blackjack: "outcome-blackjack",
};
const STATUS_LABELS = {
  seated: "대기 중",
  betting: "베팅 중...",
  "waiting-deal": "딜링 대기",
  "sitting-out": "이번 판 쉼",
  playing: "생각 중...",
  stand: "스탠드",
  bust: "버스트!",
  blackjack: "블랙잭!",
};

function renderTable() {
  if (!tableData || !currentUser) return;
  showScreen("table");
  tableCodeLabelEl.textContent = `테이블 코드: ${currentTableCode}`;

  const isHost = currentUser.uid === tableData.hostUid;
  const me = tableData.players[currentUser.uid];

  // Score <-> chip exchange
  myScoreLabelEl.textContent = currentUser.totalScore;
  myChipsLabelEl.textContent = me ? me.chips : 0;
  const myTurnActive = tableData.status === "playing" && tableData.turnUid === currentUser.uid;
  buyChipsBtn.disabled = currentUser.totalScore <= 0;
  cashOutBtn.disabled = !me || me.chips <= 0 || myTurnActive;

  // Dealer
  dealerHandEl.innerHTML = "";
  tableData.dealerHand.forEach((card, i) => {
    const faceDown = !tableData.dealerRevealed && i === 1;
    dealerHandEl.appendChild(renderCard(card, faceDown));
  });
  if (tableData.dealerHand.length === 0) {
    dealerValueEl.textContent = "";
  } else if (tableData.dealerRevealed) {
    dealerValueEl.textContent = `합계: ${handValue(tableData.dealerHand)}${isBust(tableData.dealerHand) ? " (버스트)" : ""}`;
  } else {
    dealerValueEl.textContent = `첫 장: ${cardValue(tableData.dealerHand[0])}`;
  }

  // Round status line
  const statusText = {
    waiting: isHost ? "\"게임 시작\"을 눌러 라운드를 시작하세요." : "방장이 게임을 시작하길 기다리는 중...",
    betting: "베팅 중...",
    playing: tableData.turnUid === currentUser.uid ? "내 차례입니다!" : `${tableData.players[tableData.turnUid]?.nickname || "상대"}의 차례...`,
    dealerTurn: "딜러가 카드를 뽑는 중...",
    roundOver: "라운드 종료",
  };
  roundStatusLabelEl.textContent = statusText[tableData.status] || "";

  // Seats
  seatsEl.innerHTML = "";
  for (const uid of tableData.playerOrder) {
    const p = tableData.players[uid];
    if (!p) continue;
    const seat = document.createElement("div");
    seat.className = "seat";
    if (uid === tableData.turnUid) seat.classList.add("is-turn");
    if (uid === currentUser.uid) seat.classList.add("is-me");

    const nameRow = document.createElement("div");
    nameRow.className = "seat-name-row";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = p.nickname + (uid === tableData.hostUid ? " 👑" : "") + (uid === currentUser.uid ? " (나)" : "");
    const chipsSpan = document.createElement("span");
    chipsSpan.className = "seat-chips";
    chipsSpan.textContent = `${p.chips}칩`;
    nameRow.appendChild(nameSpan);
    nameRow.appendChild(chipsSpan);
    seat.appendChild(nameRow);

    const handRow = document.createElement("div");
    handRow.className = "hand-row";
    p.hand.forEach((card) => handRow.appendChild(renderCard(card, false)));
    seat.appendChild(handRow);

    const statusP = document.createElement("p");
    statusP.className = "seat-status";
    if (tableData.status === "roundOver" && p.result) {
      let deltaText = "";
      if (p.result === "win") deltaText = ` (+${p.bet})`;
      else if (p.result === "blackjack") deltaText = ` (+${Math.floor(p.bet * 1.5)})`;
      else if (p.result === "lose") deltaText = ` (-${p.bet})`;
      else if (p.result === "push") deltaText = " (±0)";
      statusP.textContent = `${RESULT_LABELS[p.result]}${deltaText}`;
      // "push" maps to "" (no extra color) -- classList.add() throws on an
      // empty string, so only add a class when there actually is one.
      if (RESULT_CLASSES[p.result]) statusP.classList.add(RESULT_CLASSES[p.result]);
    } else if (p.hand.length > 0) {
      statusP.textContent = `${STATUS_LABELS[p.status] || ""} · 합계 ${handValue(p.hand)}${p.bet > 0 ? ` · 베팅 ${p.bet}` : ""}`;
    } else {
      statusP.textContent = STATUS_LABELS[p.status] || "";
    }
    seat.appendChild(statusP);

    seatsEl.appendChild(seat);
  }

  // Host controls
  hostControlsEl.hidden = !isHost;
  startRoundBtn.hidden = tableData.status !== "waiting";
  nextRoundBtn.hidden = tableData.status !== "roundOver";

  // My controls
  const iAmBetting = tableData.status === "betting" && me && me.status === "betting";
  const iAmActing = tableData.status === "playing" && tableData.turnUid === currentUser.uid;
  myControlsEl.hidden = !iAmBetting && !iAmActing;
  betControlsEl.hidden = !iAmBetting;
  actionControlsEl.hidden = !iAmActing;

  if (iAmBetting) {
    pendingBetAmount = Math.min(pendingBetAmount, me.chips);
    betAmountLabelEl.textContent = pendingBetAmount;
  }
  if (iAmActing) {
    doubleBtn.disabled = me.hand.length !== 2 || me.chips < me.bet * 2;
    myHandValueLabelEl.textContent = `내 합계: ${handValue(me.hand)}`;
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

buyChipsBtn.addEventListener("click", () => {
  const amount = Number(exchangeAmountInputEl.value);
  if (!amount || amount <= 0) return;
  buyChips(amount);
  exchangeAmountInputEl.value = "";
});
cashOutBtn.addEventListener("click", cashOutChips);

document.querySelectorAll(".bet-preset-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!tableData || !currentUser) return;
    const me = tableData.players[currentUser.uid];
    pendingBetAmount = Math.min((me ? me.chips : 0), pendingBetAmount + Number(btn.dataset.amount));
    betAmountLabelEl.textContent = pendingBetAmount;
  });
});
betResetBtn.addEventListener("click", () => {
  pendingBetAmount = 0;
  betAmountLabelEl.textContent = pendingBetAmount;
});
betAllinBtn.addEventListener("click", () => {
  if (!tableData || !currentUser) return;
  const me = tableData.players[currentUser.uid];
  pendingBetAmount = me ? me.chips : 0;
  betAmountLabelEl.textContent = pendingBetAmount;
});
confirmBetBtn.addEventListener("click", () => confirmBet(pendingBetAmount));

hitBtn.addEventListener("click", () => playerAction("hit"));
standBtn.addEventListener("click", () => playerAction("stand"));
doubleBtn.addEventListener("click", () => playerAction("double"));

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
  // Unlike games/omok (which has a no-login bot mode), nothing here works
  // without an account -- every seat needs a real identity -- so a guest
  // always lands on login-required, not the lobby.
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
