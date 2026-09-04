const DEFAULT_THUMBNAIL = "assets/default-thumb.svg";

const els = {
  loading: document.getElementById("loading-state"),
  empty: document.getElementById("empty-state"),
  error: document.getElementById("error-state"),
  grid: document.getElementById("game-grid"),
};

function showState(state) {
  els.loading.hidden = state !== "loading";
  els.empty.hidden = state !== "empty";
  els.error.hidden = state !== "error";
  els.grid.hidden = state !== "grid";
}

function createGameCard(game) {
  const title = game.title || "제목 없음";
  const description = game.description || "";
  const path = game.path;
  const thumbnail = game.thumbnail || DEFAULT_THUMBNAIL;

  const card = document.createElement("a");
  card.className = "game-card";
  card.href = path;

  const img = document.createElement("img");
  img.className = "game-card__thumb";
  img.src = thumbnail;
  img.alt = title;
  img.loading = "lazy";
  img.onerror = () => {
    img.onerror = null;
    img.src = DEFAULT_THUMBNAIL;
  };

  const body = document.createElement("div");
  body.className = "game-card__body";

  const titleEl = document.createElement("h3");
  titleEl.className = "game-card__title";
  titleEl.textContent = title;

  const descEl = document.createElement("p");
  descEl.className = "game-card__desc";
  descEl.textContent = description;

  body.append(titleEl, descEl);
  card.append(img, body);
  return card;
}

async function loadGames() {
  showState("loading");
  try {
    const res = await fetch("games.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const games = await res.json();

    if (!Array.isArray(games) || games.length === 0) {
      showState("empty");
      return;
    }

    const validGames = games.filter((g) => g && g.id && g.path);

    els.grid.innerHTML = "";
    validGames.forEach((game) => {
      els.grid.appendChild(createGameCard(game));
    });

    if (validGames.length === 0) {
      showState("empty");
    } else {
      showState("grid");
    }
  } catch (err) {
    console.error("게임 목록을 불러오지 못했습니다:", err);
    showState("error");
  }
}

loadGames();
