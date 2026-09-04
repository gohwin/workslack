// 사이트 전체에서 쓰는 공용 계정(로그인/회원가입/로그아웃) 모듈.
// firebase-config.js 다음, 각 페이지의 게임/화면 스크립트보다 먼저 로드해야 합니다.
// account-area 관련 DOM이 있는 페이지(메인 index.html)에서는 헤더 UI까지 그려주고,
// 없는 페이지(예: games/crossword)에서는 조용히 로그인 상태(currentUser)만 유지합니다 —
// 같은 브라우저에서 Firebase Auth 세션이 페이지를 넘나들며 그대로 유지되기 때문에,
// 메인 페이지에서 로그인하면 게임 페이지에서도 곧바로 로그인 상태로 인식됩니다.
const FIREBASE_SDK_VERSION = "10.14.1";
const AUTH_EMAIL_DOMAIN = "crossword.local";
const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,16}$/;

let currentUser = null; // { uid, username, nickname, totalScore } | null
let authMode = null; // "login" | "signup" | null

function siteTodayDateString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const accountAreaEl = document.getElementById("account-area");
const accountGuestEl = document.getElementById("account-guest");
const accountLoggedInEl = document.getElementById("account-logged-in");
const accountInfoEl = document.getElementById("account-info");
const showLoginBtn = document.getElementById("show-login-btn");
const showSignupBtn = document.getElementById("show-signup-btn");
const myInfoBtn = document.getElementById("my-info-btn");
const logoutBtn = document.getElementById("logout-btn");
const authFormAreaEl = document.getElementById("auth-form-area");
const authUsernameEl = document.getElementById("auth-username");
const authPasswordEl = document.getElementById("auth-password");
const authNicknameEl = document.getElementById("auth-nickname");
const authSubmitBtn = document.getElementById("auth-submit-btn");
const authCancelBtn = document.getElementById("auth-cancel-btn");
const authStatusEl = document.getElementById("auth-status");
const myInfoAreaEl = document.getElementById("my-info-area");
const myInfoCloseBtn = document.getElementById("my-info-close-btn");
const myInfoScoreEl = document.getElementById("my-info-score");
const nicknameChangeInputEl = document.getElementById("nickname-change-input");
const nicknameChangeBtn = document.getElementById("nickname-change-btn");
const nicknameChangeStatusEl = document.getElementById("nickname-change-status");
const scoreHistoryStatusEl = document.getElementById("score-history-status");
const scoreHistoryListEl = document.getElementById("score-history-list");

function isFirebaseConfigured() {
  const cfg = window.__firebaseConfig;
  return !!(cfg && cfg.apiKey && !cfg.apiKey.startsWith("YOUR_"));
}

let firebaseAppHandle = null;
let firestoreHandle = null;
let authHandle = null;

// Both Firestore and Auth need the same underlying Firebase app instance --
// calling initializeApp() twice throws "app already exists", so this is the
// one place that creates it.
async function ensureFirebaseApp() {
  if (!isFirebaseConfigured()) return null;
  if (firebaseAppHandle) return firebaseAppHandle;
  const { initializeApp } = await import(
    `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`
  );
  firebaseAppHandle = initializeApp(window.__firebaseConfig);
  return firebaseAppHandle;
}

async function ensureFirestore() {
  if (!isFirebaseConfigured()) return null;
  if (firestoreHandle) return firestoreHandle;
  const app = await ensureFirebaseApp();
  const firestoreApi = await import(
    `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-firestore.js`
  );
  const db = firestoreApi.getFirestore(app);
  firestoreHandle = { db, api: firestoreApi };
  return firestoreHandle;
}

async function ensureAuth() {
  if (!isFirebaseConfigured()) return null;
  if (authHandle) return authHandle;
  const app = await ensureFirebaseApp();
  const authApi = await import(
    `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-auth.js`
  );
  const auth = authApi.getAuth(app);
  authHandle = { auth, api: authApi };
  return authHandle;
}

// Firebase Auth's email/password provider is the easiest way to get real
// password hashing + storage without running our own server, but it wants
// something email-shaped as the identifier. Users only ever see "아이디" --
// this suffix is purely an internal implementation detail.
function usernameToEmail(username) {
  return `${username.trim().toLowerCase()}@${AUTH_EMAIL_DOMAIN}`;
}

async function signUp(username, password, nickname) {
  const handle = await ensureAuth();
  if (!handle) throw new Error("Firebase not configured");
  const cred = await handle.api.createUserWithEmailAndPassword(handle.auth, usernameToEmail(username), password);
  const uid = cred.user.uid;
  const fsHandle = await ensureFirestore();
  await fsHandle.api.setDoc(fsHandle.api.doc(fsHandle.db, "crossword-users", uid), {
    username,
    nickname,
    totalScore: 0,
    createdAt: Date.now(),
  });
  // createUserWithEmailAndPassword() firing onAuthStateChanged races against
  // this function's own profile-doc write above -- if that listener's
  // loadCurrentUserProfile() reads the doc before this write lands, it falls
  // back to a placeholder "익명"/0점 profile. Set the authoritative value
  // here too, after our own write is confirmed, so signup always ends with
  // the correct nickname regardless of which one resolves last.
  currentUser = { uid, username, nickname, totalScore: 0 };
  renderAccountUI();
  if (typeof onAccountReady === "function") onAccountReady();
  return uid;
}

async function logIn(username, password) {
  const handle = await ensureAuth();
  if (!handle) throw new Error("Firebase not configured");
  await handle.api.signInWithEmailAndPassword(handle.auth, usernameToEmail(username), password);
}

async function logOut() {
  const handle = await ensureAuth();
  if (!handle) return;
  await handle.api.signOut(handle.auth);
}

async function changeNickname(newNickname) {
  if (!currentUser) throw new Error("not logged in");
  const fsHandle = await ensureFirestore();
  if (!fsHandle) throw new Error("Firebase not configured");
  await fsHandle.api.updateDoc(fsHandle.api.doc(fsHandle.db, "crossword-users", currentUser.uid), {
    nickname: newNickname,
  });
  currentUser.nickname = newNickname;
  renderAccountUI();
}

// Games call this after awarding points so "내 정보" can show a per-game
// history, not just the running total. Kept as a subcollection under the
// user's own profile doc so it can only ever be read by that user.
async function logScoreHistory(points, game, gameLabel) {
  if (!currentUser) return;
  const fsHandle = await ensureFirestore();
  if (!fsHandle) return;
  const { db, api } = fsHandle;
  const historyCol = api.collection(db, "crossword-users", currentUser.uid, "history");
  await api.setDoc(api.doc(historyCol), {
    game,
    gameLabel,
    points,
    createdAt: Date.now(),
  });
}

// Shared by every game: bump the account's running total, today's entry in
// the "오늘 획득한 점수" sidebar ranking, and the per-user score history --
// all in one call. Games decide their own rules for how often this can fire
// (once per puzzle, unlimited replay, etc.); this function doesn't gate
// anything itself beyond requiring a logged-in user. No-op (returns false)
// for guests, since points are an account feature.
async function awardPoints(points, game, gameLabel) {
  if (!currentUser) return false;
  try {
    const fsHandle = await ensureFirestore();
    if (!fsHandle) return false;
    const { db, api } = fsHandle;
    await api.updateDoc(api.doc(db, "crossword-users", currentUser.uid), {
      totalScore: api.increment(points),
    });
    currentUser.totalScore += points;
    renderAccountUI();
    await api.setDoc(
      api.doc(db, "daily-scores", siteTodayDateString(), "entries", currentUser.uid),
      { nickname: currentUser.nickname, points: api.increment(points), updatedAt: Date.now() },
      { merge: true }
    );
    await logScoreHistory(points, game, gameLabel);
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

async function fetchScoreHistory(uid) {
  const fsHandle = await ensureFirestore();
  if (!fsHandle) return [];
  const { db, api } = fsHandle;
  const q = api.query(
    api.collection(db, "crossword-users", uid, "history"),
    api.orderBy("createdAt", "desc"),
    api.limit(20)
  );
  const snap = await api.getDocs(q);
  return snap.docs.map((d) => d.data());
}

function formatHistoryDate(ms) {
  const d = new Date(ms);
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${mo}/${day} ${hh}:${mm}`;
}

async function loadCurrentUserProfile(uid) {
  const fsHandle = await ensureFirestore();
  if (!fsHandle) return;
  const ref = fsHandle.api.doc(fsHandle.db, "crossword-users", uid);
  const snap = await fsHandle.api.getDoc(ref);
  if (snap.exists()) {
    const data = snap.data();
    currentUser = { uid, username: data.username, nickname: data.nickname, totalScore: data.totalScore || 0 };
  } else {
    currentUser = { uid, username: "", nickname: "익명", totalScore: 0 };
  }
  renderAccountUI();
  if (typeof onAccountReady === "function") onAccountReady();
}

async function initAuthListener() {
  const handle = await ensureAuth();
  if (!handle) return;
  handle.api.onAuthStateChanged(handle.auth, (user) => {
    if (user) {
      loadCurrentUserProfile(user.uid);
    } else {
      currentUser = null;
      renderAccountUI();
      if (typeof onAccountReady === "function") onAccountReady();
    }
  });
}

// Pages without the account-area markup (e.g. a game page that only needs
// currentUser in the background) simply have nothing to render here.
function renderAccountUI() {
  if (!accountAreaEl) return;
  accountAreaEl.hidden = false;
  if (currentUser) {
    accountGuestEl.hidden = true;
    accountLoggedInEl.hidden = false;
    accountInfoEl.textContent = `${currentUser.nickname}님 (누적 ${currentUser.totalScore}점)`;
  } else {
    accountGuestEl.hidden = false;
    accountLoggedInEl.hidden = true;
    closeMyInfo();
  }
}

function describeAuthError(err) {
  const code = err && err.code;
  if (code === "auth/email-already-in-use") return "이미 있는 아이디입니다.";
  if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
    return "아이디 또는 비밀번호가 올바르지 않습니다.";
  }
  if (code === "auth/weak-password") return "비밀번호는 6자 이상이어야 합니다.";
  console.error(err);
  return "처리 중 문제가 발생했습니다.";
}

function openAuthForm(mode) {
  if (!authFormAreaEl) return;
  authMode = mode;
  authFormAreaEl.hidden = false;
  authNicknameEl.hidden = mode !== "signup";
  authSubmitBtn.textContent = mode === "signup" ? "회원가입" : "로그인";
  authStatusEl.textContent = "";
  authUsernameEl.value = "";
  authPasswordEl.value = "";
  authNicknameEl.value = "";
  authUsernameEl.focus();
}

function closeAuthForm() {
  if (!authFormAreaEl) return;
  authFormAreaEl.hidden = true;
  authMode = null;
}

function renderScoreHistory(entries) {
  scoreHistoryListEl.innerHTML = "";
  if (entries.length === 0) {
    scoreHistoryStatusEl.textContent = "아직 점수 내역이 없습니다.";
    return;
  }
  scoreHistoryStatusEl.textContent = "";
  entries.forEach((entry) => {
    const li = document.createElement("li");
    const left = document.createElement("span");
    const gameSpan = document.createElement("span");
    gameSpan.className = "score-history-game";
    gameSpan.textContent = entry.gameLabel || entry.game || "게임";
    const dateSpan = document.createElement("span");
    dateSpan.className = "score-history-date";
    dateSpan.textContent = formatHistoryDate(entry.createdAt);
    left.appendChild(gameSpan);
    left.appendChild(dateSpan);
    const right = document.createElement("span");
    right.className = "score-history-points";
    right.textContent = `+${entry.points}점`;
    li.appendChild(left);
    li.appendChild(right);
    scoreHistoryListEl.appendChild(li);
  });
}

async function openMyInfo() {
  if (!myInfoAreaEl || !currentUser) return;
  myInfoAreaEl.hidden = false;
  myInfoScoreEl.textContent = `누적 ${currentUser.totalScore}점`;
  nicknameChangeInputEl.value = currentUser.nickname;
  nicknameChangeStatusEl.textContent = "";
  scoreHistoryStatusEl.textContent = "불러오는 중...";
  scoreHistoryListEl.innerHTML = "";
  try {
    const entries = await fetchScoreHistory(currentUser.uid);
    renderScoreHistory(entries);
  } catch (err) {
    console.error(err);
    scoreHistoryStatusEl.textContent = "점수 내역을 불러오지 못했습니다.";
  }
}

function closeMyInfo() {
  if (!myInfoAreaEl) return;
  myInfoAreaEl.hidden = true;
}

if (showLoginBtn) {
  showLoginBtn.addEventListener("click", () => openAuthForm("login"));
  showSignupBtn.addEventListener("click", () => openAuthForm("signup"));
  authCancelBtn.addEventListener("click", closeAuthForm);

  logoutBtn.addEventListener("click", async () => {
    try {
      await logOut();
    } catch (err) {
      console.error(err);
    }
  });

  authSubmitBtn.addEventListener("click", async () => {
    const username = authUsernameEl.value.trim();
    const password = authPasswordEl.value;
    const nickname = authNicknameEl.value.trim().slice(0, 12);

    if (!USERNAME_REGEX.test(username)) {
      authStatusEl.textContent = "아이디는 영문/숫자/밑줄 3~16자로 입력해주세요.";
      return;
    }
    if (password.length < 6) {
      authStatusEl.textContent = "비밀번호는 6자 이상이어야 합니다.";
      return;
    }
    if (authMode === "signup" && !nickname) {
      authStatusEl.textContent = "닉네임을 입력해주세요.";
      return;
    }

    authSubmitBtn.disabled = true;
    authStatusEl.textContent = authMode === "signup" ? "가입 중..." : "로그인 중...";
    try {
      if (authMode === "signup") {
        await signUp(username, password, nickname);
      } else {
        await logIn(username, password);
      }
      closeAuthForm();
    } catch (err) {
      authStatusEl.textContent = describeAuthError(err);
    }
    authSubmitBtn.disabled = false;
  });

  // The inputs aren't inside a <form>, so Enter doesn't submit by default --
  // wire it up manually. isComposing guards against firing mid-IME
  // composition (닉네임 입력 중 한글 조합이 끝나기 전에 Enter가 눌리는 경우).
  for (const el of [authUsernameEl, authPasswordEl, authNicknameEl]) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        authSubmitBtn.click();
      }
    });
  }
}

if (myInfoBtn) {
  myInfoBtn.addEventListener("click", () => {
    if (myInfoAreaEl.hidden) openMyInfo();
    else closeMyInfo();
  });
  myInfoCloseBtn.addEventListener("click", closeMyInfo);

  nicknameChangeBtn.addEventListener("click", async () => {
    const newNickname = nicknameChangeInputEl.value.trim().slice(0, 12);
    if (!newNickname) {
      nicknameChangeStatusEl.textContent = "닉네임을 입력해주세요.";
      return;
    }
    if (newNickname === currentUser.nickname) {
      nicknameChangeStatusEl.textContent = "";
      return;
    }
    nicknameChangeBtn.disabled = true;
    nicknameChangeStatusEl.textContent = "변경 중...";
    try {
      await changeNickname(newNickname);
      nicknameChangeStatusEl.textContent = "변경되었습니다.";
      myInfoScoreEl.textContent = `누적 ${currentUser.totalScore}점`;
    } catch (err) {
      console.error(err);
      nicknameChangeStatusEl.textContent = "닉네임 변경에 실패했습니다.";
    }
    nicknameChangeBtn.disabled = false;
  });
}

if (isFirebaseConfigured()) {
  if (accountAreaEl) accountAreaEl.hidden = false;
  initAuthListener();
} else if (accountAreaEl) {
  accountAreaEl.hidden = true;
}
