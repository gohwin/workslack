// Login/signup/logout and the shared `currentUser` state live in the
// site-wide ../../auth.js (loaded via a <script> tag before this file), same
// pattern as every other game here.

// Unlike the other games, this one has to juggle dozens of moving entities
// at once (enemies, projectiles, xp orbs), so it's canvas-rendered instead
// of DOM-element-per-thing like the typing game -- redrawing a couple
// hundred DOM nodes every frame would fall over well before canvas does.

const CANVAS_W = 640;
const CANVAS_H = 440;
const PLAYER_RADIUS = 14;

const CLASS_CONFIG = {
  warrior: {
    label: "전사",
    attackType: "melee",
    attackCooldownMs: 700,
    meleeRadius: 78,
    color: "#f87171",
  },
  mage: {
    label: "마법사",
    attackType: "ranged",
    attackCooldownMs: 650,
    projectileSpeed: 340,
    color: "#22d3ee",
  },
};

const BASE_MOVE_SPEED = 160; // px/s
const BASE_ATTACK_DAMAGE = 10;

const ENEMY_BASE_HP = 20;
const ENEMY_BASE_SPEED = 55; // px/s
const ENEMY_HP_PER_SEC = 0.18; // enemies slowly get tougher the longer you survive
const ENEMY_SPEED_PER_SEC = 0.12;
const ENEMY_SPEED_CAP = 130;

// Each enemy is one of these. hpMult/speedMult apply on top of the
// time-scaled base hp/speed above, so a speedster is always relatively
// fast/fragile and a brute always relatively slow/tanky no matter how far
// into a run you are.
const ENEMY_TYPES = {
  normal: { hpMult: 1, speedMult: 1, radius: 13, color: "#ef4444", contactDamage: 10, xpValue: 1 },
  speedster: { hpMult: 0.5, speedMult: 1.8, radius: 10, color: "#fbbf24", contactDamage: 7, xpValue: 1 },
  brute: { hpMult: 2.6, speedMult: 0.55, radius: 19, color: "#a855f7", contactDamage: 16, xpValue: 2 },
  // hpMult was 9 at first -- at the first boss (60s in) that's ~277 hp
  // against a base warrior doing 10 dmg/0.7s (~14 dps), so killing it took
  // ~20s of uninterrupted melee uptime while normal spawns kept adding
  // contact damage on top. Not really killable before other enemies
  // overwhelmed the player. 4x brings the first boss to ~123 hp (~9s to
  // kill at base stats), and contact damage down 25 -> 18 so committing to
  // the fight isn't a near-guaranteed big hit every time it connects.
  boss: { hpMult: 4, speedMult: 0.5, radius: 30, color: "#7f1d1d", contactDamage: 18, xpValue: 6 },
};

// Speedsters/brutes phase in over time instead of being available from
// second 1 -- early game stays simple, variety shows up once there's
// already some pressure.
function pickEnemyType() {
  const roll = Math.random();
  if (elapsedSeconds < 20) return "normal";
  if (elapsedSeconds < 45) return roll < 0.22 ? "speedster" : "normal";
  if (roll < 0.2) return "brute";
  if (roll < 0.42) return "speedster";
  return "normal";
}

const BOSS_INTERVAL_SECONDS = 60;

const SPAWN_START_MS = 1300;
const SPAWN_MIN_MS = 450;
const SPAWN_RAMP_SECONDS = 130;
// Nothing was capping how many enemies could be alive at once -- spawns
// keep coming no matter what, so if the kill rate ever dips below the
// spawn rate for a while (very plausible around the 60s mark, when spawn
// interval is already down near its floor), the enemy count snowballs
// without bound until the player is surrounded from every direction with
// no way out. This caps the swarm size so survival stays about dodging and
// clearing space, not an unwinnable pile-up.
const MAX_ALIVE_ENEMIES = 45;

const PLAYER_HIT_INVULN_MS = 500;

const XP_ORB_VALUE = 1;
const XP_PICKUP_RADIUS = PLAYER_RADIUS + 10;

// Special item drops -- separate from the always-on xp orb, each kill has a
// small extra chance of also dropping one of these (bosses always drop
// one). `apply` runs on pickup; invincibility/magnet just set a countdown
// (ms) that other systems below check each frame, same shape as the
// existing player.invulnMs.
const ITEM_DROP_CHANCE = 0.12;
const INVINCIBILITY_ITEM_MS = 4000;
const MAGNET_ITEM_MS = 6000;
const MAGNET_PICKUP_RADIUS = 260;

const DROP_TYPES = [
  {
    id: "heal",
    emoji: "❤️",
    color: "#4ade80",
    apply: (p) => { p.hp = Math.min(p.maxHp, p.hp + Math.round(p.maxHp * 0.25)); },
  },
  {
    id: "invincible",
    emoji: "🛡️",
    color: "#facc15",
    apply: (p) => { p.invulnMs = Math.max(p.invulnMs, INVINCIBILITY_ITEM_MS); },
  },
  {
    id: "magnet",
    emoji: "🧲",
    color: "#a78bfa",
    apply: (p) => { p.magnetMs = MAGNET_ITEM_MS; },
  },
  {
    id: "bomb",
    emoji: "💣",
    color: "#f97316",
    apply: () => { for (const e of [...enemies]) killEnemy(e); },
  },
];

const LEVEL_UP_OPTIONS = [
  {
    id: "damage",
    label: "공격력 +20%",
    apply: (p) => { p.attackDamage = Math.round(p.attackDamage * 1.2); },
  },
  {
    id: "atkspeed",
    label: "공격속도 +15%",
    apply: (p) => { p.attackCooldownMs = Math.max(150, Math.round(p.attackCooldownMs * 0.85)); },
  },
  {
    id: "movespeed",
    label: "이동속도 +10%",
    apply: (p) => { p.moveSpeed = Math.round(p.moveSpeed * 1.1); },
  },
  {
    id: "health",
    label: "체력 +20%",
    apply: (p) => {
      const inc = Math.round(p.maxHp * 0.2);
      p.maxHp += inc;
      p.hp = Math.min(p.maxHp, p.hp + inc);
    },
  },
  {
    id: "regen",
    label: "체력 재생 +1/초",
    apply: (p) => { p.regenPerSec = (p.regenPerSec || 0) + 1; },
  },
  {
    id: "lifesteal",
    label: "흡혈 +10%",
    apply: (p) => { p.lifesteal = Math.min(0.5, (p.lifesteal || 0) + 0.1); },
  },
];

// Points are paused site-wide while more games get added, so nobody has to
// re-tune every game's point scale each time a new one shows up. Flip this
// back to true (same everywhere else this flag appears) to resume scoring.
const POINTS_ENABLED = false;

const BEST_STORAGE_KEY = "survivor-best-record";

function levelXpRequirement(level) {
  return 5 + level * 4;
}

// Tiny procedural sound effects via Web Audio -- no audio files to ship for
// a handful of short blips. Browsers block audio until a user gesture, so
// ensureAudioCtx() is also called directly from the class-select button's
// click handler below to unlock it right away; every call here is wrapped
// so a browser refusing audio for any reason never breaks gameplay.
let audioCtx = null;
function ensureAudioCtx() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}
function playTone(freq, durationMs, type, gainValue, delaySec) {
  const ctxA = ensureAudioCtx();
  if (!ctxA) return;
  try {
    const osc = ctxA.createOscillator();
    const gain = ctxA.createGain();
    osc.type = type || "sine";
    osc.frequency.value = freq;
    gain.gain.value = gainValue || 0.12;
    osc.connect(gain).connect(ctxA.destination);
    const start = ctxA.currentTime + (delaySec || 0);
    osc.start(start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + durationMs / 1000);
    osc.stop(start + durationMs / 1000 + 0.03);
  } catch {
    // sound is a nice-to-have -- never let it interrupt gameplay
  }
}
const sfx = {
  attack: () => playTone(200, 60, "square", 0.05),
  kill: (isBoss) => playTone(isBoss ? 180 : 440, isBoss ? 220 : 90, "square", isBoss ? 0.18 : 0.08),
  pickup: () => playTone(880, 80, "sine", 0.1),
  levelUp: () => {
    playTone(523, 90, "sine", 0.14);
    playTone(659, 90, "sine", 0.14, 0.09);
    playTone(784, 160, "sine", 0.14, 0.18);
  },
  gameOver: () => {
    playTone(392, 160, "sawtooth", 0.1);
    playTone(261, 320, "sawtooth", 0.1, 0.16);
  },
  boss: () => {
    playTone(140, 260, "sawtooth", 0.16);
    playTone(110, 320, "sawtooth", 0.16, 0.1);
  },
};

function loadBestRecord() {
  try {
    return JSON.parse(localStorage.getItem(BEST_STORAGE_KEY)) || null;
  } catch {
    return null;
  }
}
function saveBestRecordIfBetter(seconds, lvl) {
  try {
    const cur = loadBestRecord();
    if (!cur || seconds > cur.seconds) {
      localStorage.setItem(BEST_STORAGE_KEY, JSON.stringify({ seconds, level: lvl }));
    }
  } catch {
    // localStorage unavailable; ignore
  }
}
function renderBestRecord() {
  const best = loadBestRecord();
  bestRecordEl.textContent = best ? `최고 기록: ${formatTime(best.seconds)} · Lv.${best.level}` : "";
}

let player = null;
let enemies = [];
let projectiles = [];
let xpOrbs = [];
let droppedItems = []; // { x, y, type }
let meleeEffects = []; // { x, y, radius, ageMs }
let level = 1;
let xp = 0;
let xpToNext = levelXpRequirement(1);
let levelUpQueue = [];
let levelUpModalOpen = false;
let statsModalOpen = false;
let elapsedSeconds = 0;
let spawnTimerMs = 0;
let nextBossAt = BOSS_INTERVAL_SECONDS;
let bossBannerTimer = null;
let lastFrameTime = 0;
let rafHandle = null;
let running = false;

const keysDown = new Set();
let pointerActive = false;
let pointerTarget = { x: CANVAS_W / 2, y: CANVAS_H / 2 };

const classScreenEl = document.getElementById("class-screen");
const gameScreenEl = document.getElementById("game-screen");
const bestRecordEl = document.getElementById("best-record");
const canvasEl = document.getElementById("game-canvas");
const ctx = canvasEl.getContext("2d");
// The canvas element's HTML width/height (640x440) is the game's logical
// coordinate space -- everything below (player/enemy positions, radii,
// speeds) is written in those units. CSS then displays it up to ~980px
// wide (see style.css / fitBoardToViewport below), so without this the
// browser would just upscale a 640x440 raster and every circle would come
// out visibly blurry/blocky. Instead we bump the canvas's actual pixel
// buffer up and scale the context to match, so drawing code keeps using
// the same logical coordinates but renders at a resolution sharp enough
// for the larger display size (and for retina screens, via
// devicePixelRatio).
const RENDER_SCALE = Math.min(3, (window.devicePixelRatio || 1) * 1.6);
canvasEl.width = CANVAS_W * RENDER_SCALE;
canvasEl.height = CANVAS_H * RENDER_SCALE;
ctx.scale(RENDER_SCALE, RENDER_SCALE);
const timeLabelEl = document.getElementById("time-label");
const levelLabelEl = document.getElementById("level-label");
const hpFillEl = document.getElementById("hp-fill");
const xpFillEl = document.getElementById("xp-fill");
const levelupModalEl = document.getElementById("levelup-modal");
const levelupOptionsEl = document.getElementById("levelup-options");
const resultOverlayEl = document.getElementById("result-overlay");
const resultSummaryEl = document.getElementById("result-summary");
const resultPointsEl = document.getElementById("result-points");
const canvasWrapperEl = document.querySelector(".canvas-wrapper");
const barRowEl = document.querySelector(".bar-row");
const bossBannerEl = document.getElementById("boss-banner");
const statsBtn = document.getElementById("stats-btn");
const statsModalEl = document.getElementById("stats-modal");
const statsListEl = document.getElementById("stats-list");

renderBestRecord();

// Sizes the board to the largest width that still lets the whole page fit
// in the viewport with no scrolling. An earlier version tried to do this in
// pure CSS with calc(100vh - <guessed chrome height>px), but that constant
// has to match the real rendered height of the header/title/status bar,
// which shifts across browsers/OSes/font stacks -- it kept coming out
// wrong (board too tall, page scrolls, sticky nav bar hides the
// title/bars above the fold). Measuring the actual layout instead of
// guessing a constant is the fix. The canvas-wrapper is the last thing in
// game-screen (the controls hint text lives on the class-select screen
// instead, to give the board this room), so all that's left below it is
// the body's own bottom padding.
function fitBoardToViewport() {
  if (gameScreenEl.hidden) return;
  canvasWrapperEl.style.width = "";
  barRowEl.style.width = "";

  const wrapperTop = canvasWrapperEl.getBoundingClientRect().top;
  const bottomPadding = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
  // Extra safety margin (beyond just body's bottom padding) so the board
  // comes out comfortably smaller than the theoretical max instead of
  // brushing right up against the edge of what fits.
  const availableHeight = Math.max(200, window.innerHeight - wrapperTop - bottomPadding - 20);
  const maxWidthByViewport = Math.min(980, window.innerWidth * 0.94);
  const widthByHeight = availableHeight * (CANVAS_W / CANVAS_H);
  const width = Math.max(240, Math.min(maxWidthByViewport, widthByHeight));

  canvasWrapperEl.style.width = `${width}px`;
  barRowEl.style.width = `${width}px`;
}

window.addEventListener("resize", fitBoardToViewport);

function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function currentSpawnIntervalMs() {
  const ramp = Math.min(1, elapsedSeconds / SPAWN_RAMP_SECONDS);
  return SPAWN_START_MS - (SPAWN_START_MS - SPAWN_MIN_MS) * ramp;
}

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function getCanvasPoint(e) {
  const rect = canvasEl.getBoundingClientRect();
  // Map to the logical CANVAS_W/CANVAS_H coordinate space (what game code
  // uses), not the raster pixel buffer -- those differ now by RENDER_SCALE.
  const scaleX = CANVAS_W / rect.width;
  const scaleY = CANVAS_H / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

function startClass(classKey) {
  const cfg = CLASS_CONFIG[classKey];
  player = {
    classKey,
    x: CANVAS_W / 2,
    y: CANVAS_H / 2,
    hp: 100,
    maxHp: 100,
    moveSpeed: BASE_MOVE_SPEED,
    attackDamage: BASE_ATTACK_DAMAGE,
    attackCooldownMs: cfg.attackCooldownMs,
    attackTimerMs: 0,
    invulnMs: 0,
    magnetMs: 0,
    regenPerSec: 0,
    lifesteal: 0,
  };
  enemies = [];
  projectiles = [];
  xpOrbs = [];
  droppedItems = [];
  meleeEffects = [];
  level = 1;
  xp = 0;
  xpToNext = levelXpRequirement(1);
  levelUpQueue = [];
  levelUpModalOpen = false;
  statsModalOpen = false;
  elapsedSeconds = 0;
  spawnTimerMs = 0;
  nextBossAt = BOSS_INTERVAL_SECONDS;
  lastFrameTime = 0;
  pointerActive = false;

  classScreenEl.hidden = true;
  gameScreenEl.hidden = false;
  resultOverlayEl.hidden = true;
  levelupModalEl.hidden = true;
  statsModalEl.hidden = true;
  bossBannerEl.hidden = true;
  fitBoardToViewport();
  updateHud();

  running = true;
  rafHandle = requestAnimationFrame(frame);
}

function spawnEnemy(forcedType) {
  const typeKey = forcedType || pickEnemyType();
  const type = ENEMY_TYPES[typeKey];

  const edge = Math.floor(Math.random() * 4);
  let x, y;
  if (edge === 0) { x = Math.random() * CANVAS_W; y = -type.radius; }
  else if (edge === 1) { x = CANVAS_W + type.radius; y = Math.random() * CANVAS_H; }
  else if (edge === 2) { x = Math.random() * CANVAS_W; y = CANVAS_H + type.radius; }
  else { x = -type.radius; y = Math.random() * CANVAS_H; }

  const baseHp = ENEMY_BASE_HP + elapsedSeconds * ENEMY_HP_PER_SEC;
  const baseSpeed = Math.min(ENEMY_SPEED_CAP, ENEMY_BASE_SPEED + elapsedSeconds * ENEMY_SPEED_PER_SEC);
  const hp = baseHp * type.hpMult;
  const speed = baseSpeed * type.speedMult;

  enemies.push({
    x, y, hp, maxHp: hp, speed,
    radius: type.radius,
    color: type.color,
    contactDamage: type.contactDamage,
    xpValue: type.xpValue,
    isBoss: typeKey === "boss",
  });
}

function showBossBanner() {
  bossBannerEl.hidden = false;
  clearTimeout(bossBannerTimer);
  bossBannerTimer = setTimeout(() => { bossBannerEl.hidden = true; }, 2200);
}

function killEnemy(enemy) {
  enemies = enemies.filter((e) => e !== enemy);
  xpOrbs.push({ x: enemy.x, y: enemy.y, value: enemy.xpValue || XP_ORB_VALUE });
  const dropChance = enemy.isBoss ? 1 : ITEM_DROP_CHANCE;
  if (Math.random() < dropChance) {
    const type = DROP_TYPES[Math.floor(Math.random() * DROP_TYPES.length)];
    droppedItems.push({ x: enemy.x, y: enemy.y, type });
  }
  sfx.kill(enemy.isBoss);
}

function gainXp(amount) {
  xp += amount;
  while (xp >= xpToNext) {
    xp -= xpToNext;
    level++;
    xpToNext = levelXpRequirement(level);
    levelUpQueue.push(level);
  }
  if (levelUpQueue.length && !levelUpModalOpen) openNextLevelUp();
}

function openNextLevelUp() {
  if (!levelUpQueue.length) return;
  levelUpQueue.shift();
  levelUpModalOpen = true;
  running = false;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  sfx.levelUp();

  levelupOptionsEl.innerHTML = "";
  for (const opt of LEVEL_UP_OPTIONS) {
    const btn = document.createElement("button");
    btn.textContent = opt.label;
    btn.addEventListener("click", () => pickLevelUpOption(opt));
    levelupOptionsEl.appendChild(btn);
  }
  levelupModalEl.hidden = false;
}

function pickLevelUpOption(opt) {
  opt.apply(player);
  levelupModalEl.hidden = true;
  levelUpModalOpen = false;
  updateHud();

  if (levelUpQueue.length) {
    openNextLevelUp();
  } else {
    running = true;
    lastFrameTime = 0;
    rafHandle = requestAnimationFrame(frame);
  }
}

function renderStatsList() {
  const atkPerSec = (1000 / player.attackCooldownMs).toFixed(2);
  const rows = [
    ["공격력", player.attackDamage],
    ["공격속도", `초당 ${atkPerSec}회`],
    ["이동속도", player.moveSpeed],
    ["체력", `${Math.round(player.hp)} / ${player.maxHp}`],
    ["체력 재생", player.regenPerSec ? `초당 +${player.regenPerSec}` : "없음"],
    ["흡혈", player.lifesteal ? `${Math.round(player.lifesteal * 100)}%` : "없음"],
  ];
  statsListEl.innerHTML = rows
    .map(([label, value]) => `<li><span>${label}</span><span>${value}</span></li>`)
    .join("");
}

// Opening this pauses the game (same as a level-up) so reading the numbers
// doesn't cost you a hit -- only allowed during normal play, not stacked on
// top of a level-up choice or after the run has already ended.
function openStatsModal() {
  if (!running || levelUpModalOpen || statsModalOpen) return;
  statsModalOpen = true;
  running = false;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  renderStatsList();
  statsModalEl.hidden = false;
}

function closeStatsModal() {
  if (!statsModalOpen) return;
  statsModalOpen = false;
  statsModalEl.hidden = true;
  running = true;
  lastFrameTime = 0;
  rafHandle = requestAnimationFrame(frame);
}

function applyLifesteal(damage) {
  if (player.lifesteal) player.hp = Math.min(player.maxHp, player.hp + damage * player.lifesteal);
}

function performAttack() {
  const cfg = CLASS_CONFIG[player.classKey];
  sfx.attack();
  if (cfg.attackType === "melee") {
    meleeEffects.push({ x: player.x, y: player.y, radius: cfg.meleeRadius, ageMs: 0 });
    for (const enemy of enemies) {
      if (dist(player.x, player.y, enemy.x, enemy.y) <= cfg.meleeRadius + enemy.radius) {
        enemy.hp -= player.attackDamage;
        applyLifesteal(player.attackDamage);
      }
    }
    for (const enemy of [...enemies]) {
      if (enemy.hp <= 0) killEnemy(enemy);
    }
  } else {
    let nearest = null;
    let nearestDist = Infinity;
    for (const enemy of enemies) {
      const d = dist(player.x, player.y, enemy.x, enemy.y);
      if (d < nearestDist) { nearestDist = d; nearest = enemy; }
    }
    if (!nearest) return;
    const dx = nearest.x - player.x;
    const dy = nearest.y - player.y;
    const len = Math.hypot(dx, dy) || 1;
    projectiles.push({
      x: player.x,
      y: player.y,
      vx: (dx / len) * cfg.projectileSpeed,
      vy: (dy / len) * cfg.projectileSpeed,
      damage: player.attackDamage,
    });
  }
}

function updateHud() {
  timeLabelEl.textContent = formatTime(elapsedSeconds);
  levelLabelEl.textContent = `Lv.${level}`;
  hpFillEl.style.width = `${Math.max(0, (player.hp / player.maxHp) * 100)}%`;
  xpFillEl.style.width = `${Math.min(100, (xp / xpToNext) * 100)}%`;
}

function frame(ts) {
  if (!running) return;
  const dt = lastFrameTime ? Math.min(0.05, (ts - lastFrameTime) / 1000) : 0;
  lastFrameTime = ts;
  elapsedSeconds += dt;

  // movement: keyboard takes priority over the pointer-drag target
  let dx = 0, dy = 0;
  if (keysDown.has("left")) dx -= 1;
  if (keysDown.has("right")) dx += 1;
  if (keysDown.has("up")) dy -= 1;
  if (keysDown.has("down")) dy += 1;
  if (dx !== 0 || dy !== 0) {
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
  } else if (pointerActive) {
    const ddx = pointerTarget.x - player.x;
    const ddy = pointerTarget.y - player.y;
    const d = Math.hypot(ddx, ddy);
    if (d > 4) { dx = ddx / d; dy = ddy / d; }
  }
  player.x = Math.min(CANVAS_W - PLAYER_RADIUS, Math.max(PLAYER_RADIUS, player.x + dx * player.moveSpeed * dt));
  player.y = Math.min(CANVAS_H - PLAYER_RADIUS, Math.max(PLAYER_RADIUS, player.y + dy * player.moveSpeed * dt));

  // spawning
  spawnTimerMs += dt * 1000;
  if (spawnTimerMs >= currentSpawnIntervalMs()) {
    spawnTimerMs = 0;
    if (enemies.length < MAX_ALIVE_ENEMIES) spawnEnemy();
  }
  if (elapsedSeconds >= nextBossAt) {
    spawnEnemy("boss");
    showBossBanner();
    sfx.boss();
    nextBossAt += BOSS_INTERVAL_SECONDS;
  }

  // enemies chase the player and hurt on contact
  if (player.invulnMs > 0) player.invulnMs -= dt * 1000;
  if (player.magnetMs > 0) player.magnetMs -= dt * 1000;
  if (player.regenPerSec) player.hp = Math.min(player.maxHp, player.hp + player.regenPerSec * dt);
  for (const enemy of enemies) {
    const ddx = player.x - enemy.x;
    const ddy = player.y - enemy.y;
    const d = Math.hypot(ddx, ddy) || 1;
    enemy.x += (ddx / d) * enemy.speed * dt;
    enemy.y += (ddy / d) * enemy.speed * dt;
    if (d <= PLAYER_RADIUS + enemy.radius && player.invulnMs <= 0) {
      player.hp -= enemy.contactDamage;
      player.invulnMs = PLAYER_HIT_INVULN_MS;
    }
  }

  // player attack timer
  player.attackTimerMs += dt * 1000;
  if (player.attackTimerMs >= player.attackCooldownMs) {
    player.attackTimerMs = 0;
    performAttack();
  }

  // projectiles
  for (const p of projectiles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
  projectiles = projectiles.filter(
    (p) => p.x > -20 && p.x < CANVAS_W + 20 && p.y > -20 && p.y < CANVAS_H + 20
  );
  for (const p of [...projectiles]) {
    for (const enemy of enemies) {
      if (dist(p.x, p.y, enemy.x, enemy.y) <= enemy.radius + 4) {
        enemy.hp -= p.damage;
        applyLifesteal(p.damage);
        projectiles = projectiles.filter((x) => x !== p);
        break;
      }
    }
  }
  for (const enemy of [...enemies]) {
    if (enemy.hp <= 0) killEnemy(enemy);
  }

  // xp orb + item pickup -- magnet temporarily widens the pickup radius
  // instead of animating orbs flying toward the player, simplest way to get
  // the "everything nearby gets sucked in" feel
  const pickupRadius = player.magnetMs > 0 ? MAGNET_PICKUP_RADIUS : XP_PICKUP_RADIUS;
  for (const orb of [...xpOrbs]) {
    if (dist(player.x, player.y, orb.x, orb.y) <= pickupRadius) {
      xpOrbs = xpOrbs.filter((o) => o !== orb);
      gainXp(orb.value);
    }
  }
  for (const item of [...droppedItems]) {
    if (dist(player.x, player.y, item.x, item.y) <= pickupRadius) {
      droppedItems = droppedItems.filter((d) => d !== item);
      item.type.apply(player);
      sfx.pickup();
    }
  }

  // melee visual effects aging out
  for (const eff of meleeEffects) eff.ageMs += dt * 1000;
  meleeEffects = meleeEffects.filter((eff) => eff.ageMs < 250);

  updateHud();
  render();

  if (player.hp <= 0) {
    endGame();
    return;
  }
  if (!levelUpModalOpen) rafHandle = requestAnimationFrame(frame);
}

function render() {
  ctx.fillStyle = "#0b0c10";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  for (const orb of xpOrbs) {
    ctx.fillStyle = "#22d3ee";
    ctx.beginPath();
    ctx.arc(orb.x, orb.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const item of droppedItems) {
    ctx.fillStyle = item.type.color;
    ctx.beginPath();
    ctx.arc(item.x, item.y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(item.type.emoji, item.x, item.y + 1);
  }

  if (player.magnetMs > 0) {
    ctx.strokeStyle = "rgba(167, 139, 250, 0.4)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(player.x, player.y, MAGNET_PICKUP_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
  }

  for (const eff of meleeEffects) {
    const t = eff.ageMs / 250;
    ctx.strokeStyle = `rgba(248, 113, 113, ${1 - t})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(eff.x, eff.y, eff.radius * (0.6 + 0.4 * t), 0, Math.PI * 2);
    ctx.stroke();
  }

  for (const enemy of enemies) {
    ctx.fillStyle = enemy.color;
    ctx.beginPath();
    ctx.arc(enemy.x, enemy.y, enemy.radius, 0, Math.PI * 2);
    ctx.fill();
    if (enemy.isBoss) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  for (const p of projectiles) {
    ctx.fillStyle = "#67e8f9";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  const cfg = CLASS_CONFIG[player.classKey];
  ctx.fillStyle = player.invulnMs > 0 && Math.floor(elapsedSeconds * 20) % 2 === 0 ? "#ffffff" : cfg.color;
  ctx.beginPath();
  ctx.arc(player.x, player.y, PLAYER_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.stroke();
}

async function endGame() {
  running = false;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = null;
  sfx.gameOver();

  saveBestRecordIfBetter(Math.floor(elapsedSeconds), level);

  resultOverlayEl.hidden = false;
  resultSummaryEl.textContent = `${CLASS_CONFIG[player.classKey].label} · 생존 ${formatTime(elapsedSeconds)} · Lv.${level}`;
  resultPointsEl.textContent = "";
  if (!POINTS_ENABLED) return;

  resultPointsEl.textContent = currentUser ? "" : "로그인하면 점수가 쌓여요.";
  const points = Math.min(900, level * 15 + Math.floor(elapsedSeconds));
  if (points > 0 && typeof awardPoints === "function") {
    const awarded = await awardPoints(points, "survivor", "서바이버");
    if (awarded) resultPointsEl.textContent = `+${points}점 적립!`;
  }
}

function backToClassSelect() {
  running = false;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  gameScreenEl.hidden = true;
  classScreenEl.hidden = false;
  renderBestRecord();
}

document.querySelectorAll(".class-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    ensureAudioCtx(); // unlock audio here, inside a real user gesture
    startClass(btn.dataset.class);
  });
});
document.getElementById("result-close-btn").addEventListener("click", backToClassSelect);
statsBtn.addEventListener("click", openStatsModal);
document.getElementById("stats-close-btn").addEventListener("click", closeStatsModal);

const KEY_MAP = {
  ArrowLeft: "left", a: "left", A: "left",
  ArrowRight: "right", d: "right", D: "right",
  ArrowUp: "up", w: "up", W: "up",
  ArrowDown: "down", s: "down", S: "down",
};

document.addEventListener("keydown", (e) => {
  const dir = KEY_MAP[e.key];
  if (!dir) return;
  e.preventDefault();
  keysDown.add(dir);
});
document.addEventListener("keyup", (e) => {
  const dir = KEY_MAP[e.key];
  if (!dir) return;
  keysDown.delete(dir);
});

canvasEl.addEventListener("pointerdown", (e) => {
  pointerActive = true;
  pointerTarget = getCanvasPoint(e);
  canvasEl.setPointerCapture(e.pointerId);
});
canvasEl.addEventListener("pointermove", (e) => {
  if (pointerActive) pointerTarget = getCanvasPoint(e);
});
window.addEventListener("pointerup", () => {
  pointerActive = false;
});
