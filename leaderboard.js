// 메인 페이지 사이드바에 표시되는 랭킹. 계정/로그인은 auth.js가 이미 연결한
// Firebase를 그대로 재사용합니다. 두 랭킹 모두 게임 종류와 무관하게 공용
// 점수 시스템(auth.js의 awardPoints())이 쌓는 데이터를 읽습니다 -- 어떤
// 게임이 점수를 주든 자동으로 반영됩니다.
const alltimeLeaderboardStatusEl = document.getElementById("alltime-leaderboard-status");
const alltimeLeaderboardListEl = document.getElementById("alltime-leaderboard-list");
const dailyLeaderboardStatusEl = document.getElementById("daily-leaderboard-status");
const dailyLeaderboardListEl = document.getElementById("daily-leaderboard-list");

async function fetchAlltimeLeaderboard() {
  const handle = await ensureFirestore();
  if (!handle) return [];
  const { db, api } = handle;
  const q = api.query(api.collection(db, "crossword-users"), api.orderBy("totalScore", "desc"), api.limit(10));
  const snap = await api.getDocs(q);
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
}

async function fetchDailyLeaderboard() {
  const handle = await ensureFirestore();
  if (!handle) return [];
  const { db, api } = handle;
  const q = api.query(
    api.collection(db, "daily-scores", siteTodayDateString(), "entries"),
    api.orderBy("points", "desc"),
    api.limit(10)
  );
  const snap = await api.getDocs(q);
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
}

function renderRankList(listEl, statusEl, entries, { myId, idField, emptyText, formatValue }) {
  listEl.innerHTML = "";
  if (entries.length === 0) {
    statusEl.textContent = emptyText;
    return;
  }
  statusEl.textContent = "";
  entries.forEach((entry, i) => {
    const li = document.createElement("li");
    if (myId && entry[idField] === myId) li.classList.add("me");
    const left = document.createElement("span");
    const rank = document.createElement("span");
    rank.className = "leaderboard-rank";
    rank.textContent = `${i + 1}`;
    left.appendChild(rank);
    left.appendChild(document.createTextNode(entry.nickname || "익명"));
    const right = document.createElement("span");
    right.textContent = formatValue(entry);
    li.appendChild(left);
    li.appendChild(right);
    listEl.appendChild(li);
  });
}

async function refreshSidebarLeaderboards() {
  if (!alltimeLeaderboardListEl) return; // page has no sidebar
  if (!isFirebaseConfigured()) {
    alltimeLeaderboardStatusEl.textContent = "랭킹을 사용하려면 Firebase 설정이 필요합니다.";
    dailyLeaderboardStatusEl.textContent = "랭킹을 사용하려면 Firebase 설정이 필요합니다.";
    return;
  }
  alltimeLeaderboardStatusEl.textContent = "불러오는 중...";
  dailyLeaderboardStatusEl.textContent = "불러오는 중...";
  try {
    const [alltime, daily] = await Promise.all([fetchAlltimeLeaderboard(), fetchDailyLeaderboard()]);
    renderRankList(alltimeLeaderboardListEl, alltimeLeaderboardStatusEl, alltime, {
      myId: currentUser ? currentUser.uid : null,
      idField: "uid",
      emptyText: "아직 계정으로 점수를 받은 사람이 없습니다.",
      formatValue: (e) => `${e.totalScore || 0}점`,
    });
    renderRankList(dailyLeaderboardListEl, dailyLeaderboardStatusEl, daily, {
      myId: currentUser ? currentUser.uid : null,
      idField: "uid",
      emptyText: "아직 오늘 점수를 획득한 사람이 없습니다.",
      formatValue: (e) => `${e.points || 0}점`,
    });
  } catch (err) {
    console.error(err);
    alltimeLeaderboardStatusEl.textContent = "랭킹을 불러오지 못했습니다.";
    dailyLeaderboardStatusEl.textContent = "랭킹을 불러오지 못했습니다.";
  }
}

// auth.js calls this once login state resolves (and again on login/logout),
// so the "me" highlight and Firebase readiness are always in sync.
function onAccountReady() {
  refreshSidebarLeaderboards();
}

refreshSidebarLeaderboards();
