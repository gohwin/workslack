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

// Each class leans into a different identity via its base stats instead of
// starting identical and only diverging through level-ups: the warrior
// hits hard and slow, the mage hits light and fast.
const CLASS_CONFIG = {
  warrior: {
    label: "전사",
    attackType: "melee",
    attackCooldownMs: 1000,
    baseAttackDamage: 20,
    baseMaxHp: 150,
    meleeRadius: 78,
    color: "#f87171",
  },
  mage: {
    label: "마법사",
    attackType: "ranged",
    attackCooldownMs: 500,
    baseAttackDamage: 15,
    baseMaxHp: 100,
    projectileSpeed: 340,
    color: "#22d3ee",
  },
};

const BASE_MOVE_SPEED = 200; // px/s

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
// one). `apply` runs on pickup; invincibility just sets a countdown (ms)
// that other systems below check each frame, same shape as the existing
// player.invulnMs.
const ITEM_DROP_CHANCE = 0.12;
const INVINCIBILITY_ITEM_MS = 4000;

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
    // Instant burst instead of a timed pickup-radius buff: grabs every xp
    // orb and dropped item currently on the field once, right away.
    apply: (p) => {
      for (const orb of xpOrbs) gainXp(orb.value);
      xpOrbs = [];
      for (const it of droppedItems) it.type.apply(p);
      droppedItems = [];
    },
  },
  {
    id: "bomb",
    emoji: "💣",
    color: "#f97316",
    // Bosses are immune -- otherwise the fight meant to be the run's one
    // real test just evaporates the instant a bomb happens to drop.
    apply: () => { for (const e of [...enemies]) { if (!e.isBoss) killEnemy(e); } },
  },
];

// These are multiplicative and stack every level, so they compound
// exponentially over a long run (1.35x damage 15 times over is ~90x, not
// 15x) -- the previous +35%/+22% pass made it trivial to hit absurd
// numbers (attackDamage 381 by level 20) well before the enemy scaling
// (linear in time) could keep up. Pulled the percentages back down hard
// and moved the power into higher base stats instead (see
// CLASS_CONFIG.baseAttackDamage/baseMaxHp and BASE_MOVE_SPEED above), which
// only ever apply once and can't snowball the same way.
const LEVEL_UP_OPTIONS = [
  {
    id: "damage",
    label: "공격력 +15%",
    apply: (p) => { p.attackDamage = Math.round(p.attackDamage * 1.15); },
  },
  {
    id: "atkspeed",
    label: "공격속도 +12%",
    apply: (p) => { p.attackCooldownMs = Math.max(150, Math.round(p.attackCooldownMs * 0.88)); },
  },
  {
    id: "health",
    label: "체력 +18%",
    apply: (p) => {
      const inc = Math.round(p.maxHp * 0.18);
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
    label: "흡혈 +3%",
    apply: (p) => { p.lifesteal = Math.min(0.45, (p.lifesteal || 0) + 0.03); },
  },
];

// Only 3 of these show at each level-up, chosen at random (see
// pickRandomOptions below) -- picking every time used to be "which of the
// fixed ones do I want", now it's also "which 3 did I even get offered."
// (Move speed used to be one of these but got dropped entirely -- the map
// is small enough that it never felt like it mattered.)
function pickRandomOptions(pool, n) {
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

// Boss-kill reward: bigger versions of the usual stat boosts (2 random,
// picked from this pool) plus one class-specific ability that a normal
// level-up never offers.
const BOSS_STAT_OPTIONS = [
  {
    id: "boss_damage",
    label: "공격력 +40%",
    apply: (p) => { p.attackDamage = Math.round(p.attackDamage * 1.4); },
  },
  {
    id: "boss_health",
    label: "체력 +40%",
    apply: (p) => {
      const inc = Math.round(p.maxHp * 0.4);
      p.maxHp += inc;
      p.hp = Math.min(p.maxHp, p.hp + inc);
    },
  },
  {
    id: "boss_atkspeed",
    label: "공격속도 +25%",
    apply: (p) => { p.attackCooldownMs = Math.max(150, Math.round(p.attackCooldownMs * 0.75)); },
  },
];

// `special: true` marks these for the gold button styling in
// openNextChoice() below -- they're rarer/more impactful than a normal
// stat tick, so they shouldn't look like just another purple button.
// Each class maps to a list now (warrior has two distinct specials) --
// pickClassSpecial() below picks one at random whenever a special slot
// is offered.
const CLASS_SPECIAL_OPTIONS = {
  warrior: [
    {
      id: "melee_size",
      label: "크기 +10%",
      special: true,
      apply: (p) => { p.meleeRadiusMult = Math.round((p.meleeRadiusMult || 1) * 1.1 * 100) / 100; },
    },
    {
      id: "melee_angle",
      label: "각도 +10도",
      special: true,
      apply: (p) => { p.meleeAngleBonusDeg = (p.meleeAngleBonusDeg || 0) + 10; },
    },
  ],
  mage: [
    {
      id: "extra_projectile",
      label: "투사체 +1개",
      special: true,
      apply: (p) => { p.projectileCount = (p.projectileCount || 1) + 1; },
    },
  ],
};

function pickClassSpecial() {
  return pickRandomOptions(CLASS_SPECIAL_OPTIONS[player.classKey], 1)[0];
}

// Extremely rare chance for the class-specific special to sneak into a
// normal level-up's 3 choices too, not just guaranteed boss rewards.
const RARE_SPECIAL_IN_LEVELUP_CHANCE = 0.04;

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
let choiceQueue = [];
let choiceModalOpen = false;
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
const hpTextEl = document.getElementById("hp-text");
const xpTextEl = document.getElementById("xp-text");
const levelupModalEl = document.getElementById("levelup-modal");
const levelupTitleEl = document.getElementById("levelup-title");
const levelupOptionsEl = document.getElementById("levelup-options");
const resultOverlayEl = document.getElementById("result-overlay");
const resultSummaryEl = document.getElementById("result-summary");
const resultPointsEl = document.getElementById("result-points");
const canvasWrapperEl = document.querySelector(".canvas-wrapper");
const barRowEl = document.querySelector(".bar-row");
const bossBannerEl = document.getElementById("boss-banner");
const statsSidebarEl = document.getElementById("stats-sidebar");
const statsListEl = document.getElementById("stats-list");
const enemyStatsListEl = document.getElementById("enemy-stats-list");

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
  // The stats sidebar (see .stats-sidebar in style.css) sits beside the
  // board via flex, only actually shown once the viewport is wide enough --
  // when it is, its width + the flex gap has to come out of the board's
  // width budget too, or the two would overflow the viewport together.
  const sidebarVisible = getComputedStyle(statsSidebarEl).display !== "none";
  const sidebarReserved = sidebarVisible ? statsSidebarEl.offsetWidth + 24 : 0;
  const maxWidthByViewport = Math.min(980, window.innerWidth * 0.94 - sidebarReserved);
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
    hp: cfg.baseMaxHp,
    maxHp: cfg.baseMaxHp,
    moveSpeed: BASE_MOVE_SPEED,
    attackDamage: cfg.baseAttackDamage,
    attackCooldownMs: cfg.attackCooldownMs,
    attackTimerMs: 0,
    invulnMs: 0,
    regenPerSec: 0,
    lifesteal: 0,
    meleeRadiusMult: 1, // warrior-only special (attack size)
    meleeAngleBonusDeg: 0, // warrior-only special (extra cone width, in degrees)
    projectileCount: 1, // mage-only special (extra projectiles)
    facingAngle: 0, // warrior-only: melee is a cone in front of this
  };
  enemies = [];
  projectiles = [];
  xpOrbs = [];
  droppedItems = [];
  meleeEffects = [];
  level = 1;
  xp = 0;
  xpToNext = levelXpRequirement(1);
  choiceQueue = [];
  choiceModalOpen = false;
  elapsedSeconds = 0;
  spawnTimerMs = 0;
  nextBossAt = BOSS_INTERVAL_SECONDS;
  lastFrameTime = 0;
  pointerActive = false;

  classScreenEl.hidden = true;
  gameScreenEl.hidden = false;
  resultOverlayEl.hidden = true;
  levelupModalEl.hidden = true;
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
  if (enemy.isBoss) {
    choiceQueue.push({ type: "boss" });
    if (!choiceModalOpen) openNextChoice();
  }
}

function gainXp(amount) {
  xp += amount;
  while (xp >= xpToNext) {
    xp -= xpToNext;
    level++;
    xpToNext = levelXpRequirement(level);
    choiceQueue.push({ type: "levelup" });
  }
  if (choiceQueue.length && !choiceModalOpen) openNextChoice();
}

// Builds the boss-reward option set fresh each time: 2 random picks from
// BOSS_STAT_OPTIONS (bigger versions of the usual boosts) plus the one
// ability a normal level-up never offers -- attack range for the warrior,
// an extra projectile for the mage -- then shuffled together so the
// class-specific pick isn't always shown last.
function buildBossRewardOptions() {
  const picks = pickRandomOptions(BOSS_STAT_OPTIONS, 2);
  picks.push(pickClassSpecial());
  return pickRandomOptions(picks, picks.length);
}

function openNextChoice() {
  if (!choiceQueue.length) return;
  const choice = choiceQueue.shift();
  choiceModalOpen = true;
  running = false;
  if (rafHandle) cancelAnimationFrame(rafHandle);

  const isBossReward = choice.type === "boss";
  levelupTitleEl.textContent = isBossReward ? "🏆 보스 처치 보상!" : "🆙 레벨 업!";
  const options = isBossReward ? buildBossRewardOptions() : buildLevelUpOptions();
  sfx.levelUp();

  levelupOptionsEl.innerHTML = "";
  for (const opt of options) {
    const btn = document.createElement("button");
    btn.textContent = opt.label;
    if (opt.special) btn.classList.add("choice-option-special");
    btn.addEventListener("click", () => pickChoiceOption(opt));
    levelupOptionsEl.appendChild(btn);
  }
  levelupModalEl.hidden = false;
}

// Normally just 3 random picks from LEVEL_UP_OPTIONS, but there's a small
// chance the class-specific special (otherwise only ever guaranteed on a
// boss kill) sneaks in as one of the 3 instead.
function buildLevelUpOptions() {
  if (Math.random() < RARE_SPECIAL_IN_LEVELUP_CHANCE) {
    const picks = pickRandomOptions(LEVEL_UP_OPTIONS, 2);
    picks.push(pickClassSpecial());
    return pickRandomOptions(picks, picks.length);
  }
  return pickRandomOptions(LEVEL_UP_OPTIONS, 3);
}

function pickChoiceOption(opt) {
  opt.apply(player);
  levelupModalEl.hidden = true;
  choiceModalOpen = false;
  updateHud();

  if (choiceQueue.length) {
    openNextChoice();
  } else {
    running = true;
    lastFrameTime = 0;
    rafHandle = requestAnimationFrame(frame);
  }
}

// Lives in the sidebar next to the board (see .stats-sidebar in
// style.css -- only shown when there's actually room beside the canvas),
// not a button+modal, so it just re-renders every HUD update instead of
// needing an open/close toggle.
function renderStatsSidebar() {
  const atkPerSec = (1000 / player.attackCooldownMs).toFixed(2);
  const rows = [
    ["공격력", player.attackDamage],
    ["공격속도", `초당 ${atkPerSec}회`],
    ["이동속도", player.moveSpeed],
    ["체력 재생", player.regenPerSec ? `초당 +${player.regenPerSec}` : "없음"],
    ["흡혈", player.lifesteal ? `${Math.round(player.lifesteal * 100)}%` : "없음"],
  ];
  // Class-specific special stats, only worth showing once actually picked.
  if (player.classKey === "warrior") {
    if (player.meleeRadiusMult > 1) {
      const cfg = CLASS_CONFIG.warrior;
      rows.push(["크기", Math.round(cfg.meleeRadius * player.meleeRadiusMult)]);
    }
    if (player.meleeAngleBonusDeg > 0) {
      rows.push(["각도", `${180 + player.meleeAngleBonusDeg}도`]);
    }
  } else if (player.classKey === "mage" && player.projectileCount > 1) {
    rows.push(["투사체 수", player.projectileCount]);
  }
  statsListEl.innerHTML = rows
    .map(([label, value]) => `<li><span>${label}</span><span>${value}</span></li>`)
    .join("");
}

// Mirrors renderStatsSidebar() but for what the enemies are currently doing
// -- everything here is the same math spawnEnemy()/currentSpawnIntervalMs()
// use, just surfaced live so "it's escalating" isn't only felt, it's seen.
function renderEnemyStatsSidebar() {
  const baseHp = Math.round(ENEMY_BASE_HP + elapsedSeconds * ENEMY_HP_PER_SEC);
  const baseSpeed = Math.round(Math.min(ENEMY_SPEED_CAP, ENEMY_BASE_SPEED + elapsedSeconds * ENEMY_SPEED_PER_SEC));
  const spawnSec = (currentSpawnIntervalMs() / 1000).toFixed(2);
  const variety = elapsedSeconds < 20 ? "일반" : elapsedSeconds < 45 ? "일반 + 스피드형" : "일반 + 스피드형 + 브루트";
  const bossAlive = enemies.some((e) => e.isBoss);
  const bossStatus = bossAlive ? "전투 중!" : `${Math.max(0, Math.ceil(nextBossAt - elapsedSeconds))}초 후`;

  const rows = [
    ["기본 체력", baseHp],
    ["기본 이동속도", baseSpeed],
    ["스폰 간격", `${spawnSec}초`],
    ["종류", variety],
    ["다음 보스", bossStatus],
  ];
  enemyStatsListEl.innerHTML = rows
    .map(([label, value]) => `<li><span>${label}</span><span>${value}</span></li>`)
    .join("");
}

function applyLifesteal(damage) {
  if (player.lifesteal) player.hp = Math.min(player.maxHp, player.hp + damage * player.lifesteal);
}

// Warrior's melee is a cone in front of wherever the player is currently
// facing (player.facingAngle, updated from movement direction), not a full
// circle -- an earlier version hit everything around the player regardless
// of angle, which the visual (a wedge) was misrepresenting either way: a
// random-angle wedge looked like it should sometimes miss enemies that were
// actually always hit, and a full-circle flash didn't read as an aimable
// attack at all. Making the cone real (not just visual) means facing your
// enemies now actually matters for the warrior. Base width is 180 degrees
// (halfAngle = PI/2); the "각도 +10도" special widens it further.
function angleWithinFacingCone(fromX, fromY, toX, toY, facingAngle, halfAngle) {
  const angleToTarget = Math.atan2(toY - fromY, toX - fromX);
  const diff = Math.atan2(Math.sin(angleToTarget - facingAngle), Math.cos(angleToTarget - facingAngle));
  return Math.abs(diff) <= halfAngle;
}

function performAttack() {
  const cfg = CLASS_CONFIG[player.classKey];
  sfx.attack();
  if (cfg.attackType === "melee") {
    const radius = cfg.meleeRadius * player.meleeRadiusMult;
    const halfAngle = Math.PI / 2 + ((player.meleeAngleBonusDeg || 0) * Math.PI) / 180 / 2;
    meleeEffects.push({ x: player.x, y: player.y, radius, angle: player.facingAngle, halfAngle, ageMs: 0 });
    for (const enemy of enemies) {
      if (
        dist(player.x, player.y, enemy.x, enemy.y) <= radius + enemy.radius &&
        angleWithinFacingCone(player.x, player.y, enemy.x, enemy.y, player.facingAngle, halfAngle)
      ) {
        enemy.hp -= player.attackDamage;
        applyLifesteal(player.attackDamage);
      }
    }
    for (const enemy of [...enemies]) {
      if (enemy.hp <= 0) killEnemy(enemy);
    }
  } else {
    // Extra projectiles (mage's boss reward) each go to a different nearby
    // enemy instead of stacking multiple shots on the same target -- sorted
    // by distance and taking the closest N naturally falls back to the
    // original single-nearest-target behavior when projectileCount is 1.
    const targets = [...enemies]
      .sort((a, b) => dist(player.x, player.y, a.x, a.y) - dist(player.x, player.y, b.x, b.y))
      .slice(0, player.projectileCount);
    for (const target of targets) {
      const dx = target.x - player.x;
      const dy = target.y - player.y;
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
}

function updateHud() {
  timeLabelEl.textContent = formatTime(elapsedSeconds);
  levelLabelEl.textContent = `Lv.${level}`;
  hpFillEl.style.width = `${Math.max(0, (player.hp / player.maxHp) * 100)}%`;
  xpFillEl.style.width = `${Math.min(100, (xp / xpToNext) * 100)}%`;
  hpTextEl.textContent = `${Math.max(0, Math.round(player.hp))} / ${player.maxHp}`;
  xpTextEl.textContent = `${xp} / ${xpToNext}`;
  renderStatsSidebar();
  renderEnemyStatsSidebar();
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
  if (dx !== 0 || dy !== 0) player.facingAngle = Math.atan2(dy, dx);
  player.x = Math.min(CANVAS_W - PLAYER_RADIUS, Math.max(PLAYER_RADIUS, player.x + dx * player.moveSpeed * dt));
  player.y = Math.min(CANVAS_H - PLAYER_RADIUS, Math.max(PLAYER_RADIUS, player.y + dy * player.moveSpeed * dt));

  // spawning
  spawnTimerMs += dt * 1000;
  if (spawnTimerMs >= currentSpawnIntervalMs()) {
    spawnTimerMs = 0;
    if (enemies.length < MAX_ALIVE_ENEMIES) spawnEnemy();
  }
  // If the previous boss is still alive when the next one is due, wait --
  // otherwise two (or more) end up on screen at once, which is less "epic
  // fight" and more "instant unwinnable pile-up." The timer only advances
  // once a boss actually spawns, so it doesn't fire in a rapid catch-up
  // burst either.
  if (elapsedSeconds >= nextBossAt && !enemies.some((e) => e.isBoss)) {
    spawnEnemy("boss");
    showBossBanner();
    sfx.boss();
    nextBossAt = elapsedSeconds + BOSS_INTERVAL_SECONDS;
  }

  // enemies chase the player and hurt on contact
  if (player.invulnMs > 0) player.invulnMs -= dt * 1000;
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

  // xp orb + item pickup. The `includes()` checks guard against the magnet
  // item: its apply() clears xpOrbs/droppedItems outright (see DROP_TYPES
  // above), so if it's picked up in the same tick as other entries this
  // loop already snapshotted, those entries are gone by the time we get to
  // them here -- without the guard they'd get applied a second time.
  for (const orb of [...xpOrbs]) {
    if (!xpOrbs.includes(orb)) continue;
    if (dist(player.x, player.y, orb.x, orb.y) <= XP_PICKUP_RADIUS) {
      xpOrbs = xpOrbs.filter((o) => o !== orb);
      gainXp(orb.value);
    }
  }
  for (const item of [...droppedItems]) {
    if (!droppedItems.includes(item)) continue;
    if (dist(player.x, player.y, item.x, item.y) <= XP_PICKUP_RADIUS) {
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
  if (!choiceModalOpen) rafHandle = requestAnimationFrame(frame);
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


  // Warrior's melee: a range ring (max reach) plus the actual hit cone
  // (eff.angle is the facing direction, eff.halfAngle is how far it spans
  // to each side -- see angleWithinFacingCone() in performAttack()). This
  // used to be a full-circle or spinning-360 visual while hit detection
  // was omnidirectional; now that the cone is real (facing your enemies
  // matters, and the "각도 +10도" special can widen it), the drawn wedge IS
  // the hit boundary, not a rough approximation of one -- so it's outlined
  // precisely rather than animated as a spin or flash.
  const OPEN_MS = 90; // the cone opens to its full width within this window
  for (const eff of meleeEffects) {
    const t = eff.ageMs / 250;
    const fade = 1 - t;

    ctx.strokeStyle = `rgba(248, 113, 113, ${fade})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(eff.x, eff.y, eff.radius * (0.6 + 0.4 * t), 0, Math.PI * 2);
    ctx.stroke();

    const openT = Math.min(1, eff.ageMs / OPEN_MS);
    const halfSweep = eff.halfAngle * openT;
    const startAngle = eff.angle - halfSweep;
    const endAngle = eff.angle + halfSweep;

    ctx.beginPath();
    ctx.moveTo(eff.x, eff.y);
    ctx.arc(eff.x, eff.y, eff.radius, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = `rgba(248, 113, 113, ${fade * 0.4})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(255, 255, 255, ${fade * 0.9})`;
    ctx.lineWidth = 2;
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
