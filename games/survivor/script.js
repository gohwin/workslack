// Login/signup/logout and the shared `currentUser` state live in the
// site-wide ../../auth.js (loaded via a <script> tag before this file), same
// pattern as every other game here.

// Unlike the other games, this one has to juggle dozens of moving entities
// at once (enemies, projectiles, xp orbs), so it's canvas-rendered instead
// of DOM-element-per-thing like the typing game -- redrawing a couple
// hundred DOM nodes every frame would fall over well before canvas does.

const CANVAS_W = 440;
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

const ENEMY_RADIUS = 13;
const ENEMY_BASE_HP = 20;
const ENEMY_BASE_SPEED = 55; // px/s
const ENEMY_CONTACT_DAMAGE = 10;
const ENEMY_HP_PER_SEC = 0.18; // enemies slowly get tougher the longer you survive
const ENEMY_SPEED_PER_SEC = 0.12;
const ENEMY_SPEED_CAP = 130;

const SPAWN_START_MS = 1300;
const SPAWN_MIN_MS = 380;
const SPAWN_RAMP_SECONDS = 100;

const PLAYER_HIT_INVULN_MS = 500;

const XP_ORB_VALUE = 1;
const XP_PICKUP_RADIUS = PLAYER_RADIUS + 10;

// Special item drops -- separate from the always-on xp orb, each kill has a
// small extra chance of also dropping one of these. `apply` runs on pickup;
// invincibility/magnet just set a countdown (ms) that other systems below
// check each frame, same shape as the existing player.invulnMs.
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
];

// Points are paused site-wide while more games get added, so nobody has to
// re-tune every game's point scale each time a new one shows up. Flip this
// back to true (same everywhere else this flag appears) to resume scoring.
const POINTS_ENABLED = false;

function levelXpRequirement(level) {
  return 5 + level * 4;
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
let elapsedSeconds = 0;
let spawnTimerMs = 0;
let lastFrameTime = 0;
let rafHandle = null;
let running = false;

const keysDown = new Set();
let pointerActive = false;
let pointerTarget = { x: CANVAS_W / 2, y: CANVAS_H / 2 };

const classScreenEl = document.getElementById("class-screen");
const gameScreenEl = document.getElementById("game-screen");
const canvasEl = document.getElementById("game-canvas");
const ctx = canvasEl.getContext("2d");
const timeLabelEl = document.getElementById("time-label");
const levelLabelEl = document.getElementById("level-label");
const hpFillEl = document.getElementById("hp-fill");
const xpFillEl = document.getElementById("xp-fill");
const levelupModalEl = document.getElementById("levelup-modal");
const levelupOptionsEl = document.getElementById("levelup-options");
const resultOverlayEl = document.getElementById("result-overlay");
const resultSummaryEl = document.getElementById("result-summary");
const resultPointsEl = document.getElementById("result-points");

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
  const scaleX = canvasEl.width / rect.width;
  const scaleY = canvasEl.height / rect.height;
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
  elapsedSeconds = 0;
  spawnTimerMs = 0;
  lastFrameTime = 0;
  pointerActive = false;

  classScreenEl.hidden = true;
  gameScreenEl.hidden = false;
  resultOverlayEl.hidden = true;
  levelupModalEl.hidden = true;
  updateHud();

  running = true;
  rafHandle = requestAnimationFrame(frame);
}

function spawnEnemy() {
  const edge = Math.floor(Math.random() * 4);
  let x, y;
  if (edge === 0) { x = Math.random() * CANVAS_W; y = -ENEMY_RADIUS; }
  else if (edge === 1) { x = CANVAS_W + ENEMY_RADIUS; y = Math.random() * CANVAS_H; }
  else if (edge === 2) { x = Math.random() * CANVAS_W; y = CANVAS_H + ENEMY_RADIUS; }
  else { x = -ENEMY_RADIUS; y = Math.random() * CANVAS_H; }

  const hp = ENEMY_BASE_HP + elapsedSeconds * ENEMY_HP_PER_SEC;
  const speed = Math.min(ENEMY_SPEED_CAP, ENEMY_BASE_SPEED + elapsedSeconds * ENEMY_SPEED_PER_SEC);
  enemies.push({ x, y, hp, maxHp: hp, speed });
}

function killEnemy(enemy) {
  enemies = enemies.filter((e) => e !== enemy);
  xpOrbs.push({ x: enemy.x, y: enemy.y, value: XP_ORB_VALUE });
  if (Math.random() < ITEM_DROP_CHANCE) {
    const type = DROP_TYPES[Math.floor(Math.random() * DROP_TYPES.length)];
    droppedItems.push({ x: enemy.x, y: enemy.y, type });
  }
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

function performAttack() {
  const cfg = CLASS_CONFIG[player.classKey];
  if (cfg.attackType === "melee") {
    meleeEffects.push({ x: player.x, y: player.y, radius: cfg.meleeRadius, ageMs: 0 });
    for (const enemy of enemies) {
      if (dist(player.x, player.y, enemy.x, enemy.y) <= cfg.meleeRadius + ENEMY_RADIUS) {
        enemy.hp -= player.attackDamage;
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
    spawnEnemy();
  }

  // enemies chase the player and hurt on contact
  if (player.invulnMs > 0) player.invulnMs -= dt * 1000;
  if (player.magnetMs > 0) player.magnetMs -= dt * 1000;
  for (const enemy of enemies) {
    const ddx = player.x - enemy.x;
    const ddy = player.y - enemy.y;
    const d = Math.hypot(ddx, ddy) || 1;
    enemy.x += (ddx / d) * enemy.speed * dt;
    enemy.y += (ddy / d) * enemy.speed * dt;
    if (d <= PLAYER_RADIUS + ENEMY_RADIUS && player.invulnMs <= 0) {
      player.hp -= ENEMY_CONTACT_DAMAGE;
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
      if (dist(p.x, p.y, enemy.x, enemy.y) <= ENEMY_RADIUS + 4) {
        enemy.hp -= p.damage;
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
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    ctx.arc(enemy.x, enemy.y, ENEMY_RADIUS, 0, Math.PI * 2);
    ctx.fill();
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
}

document.querySelectorAll(".class-btn").forEach((btn) => {
  btn.addEventListener("click", () => startClass(btn.dataset.class));
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
