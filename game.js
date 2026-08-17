"use strict";

const CONFIG = Object.freeze({
  duration: 60,
  normalPoints: 10,
  rarePoints: 50,
  missPenalty: 5,
  hazardPenalty: 10,
  hazardChance: 0.12,
  rareChance: 0.05,
  rareGuaranteeAt: 50,
  playerSpeedRatio: 0.8,
  playerWidthRatio: 0.19,
  itemSizeRatio: 0.095,
  phases: [
    { until: 20, interval: 1.2, fallTime: [3.2, 4.0], maxItems: 3 },
    { until: 40, interval: 1.0, fallTime: [2.7, 3.5], maxItems: 4 },
    { until: 61, interval: 0.8, fallTime: [2.2, 3.0], maxItems: 5 }
  ],
  comboMilestones: [5, 10, 20],
  items: ["🍩", "🍬", "🍪", "🧸", "🧢", "🧴"]
});

const $ = (selector) => document.querySelector(selector);
const elements = {
  canvas: $("#gameCanvas"), hud: $("#hud"), score: $("#score"), time: $("#time"), combo: $("#combo"),
  title: $("#titleScreen"), titleHigh: $("#titleHighScore"), pause: $("#pauseScreen"), result: $("#resultScreen"),
  resultScore: $("#resultScore"), resultHigh: $("#resultHighScore"), resultTitle: $("#resultTitle"), resultBadge: $("#resultBadge"),
  countdown: $("#countdown"), announcement: $("#announcement"), confetti: $("#confetti"),
  start: $("#startButton"), pauseButton: $("#pauseButton"), resume: $("#resumeButton"), quit: $("#quitButton"),
  replay: $("#replayButton"), home: $("#homeButton"), sound: $("#soundButton"),
  left: $("#leftButton"), right: $("#rightButton")
};

const ctx = elements.canvas.getContext("2d");
const emojiSpriteCache = new Map();
const itemHitboxRatios = Object.freeze({
  "🍩": { width: 0.72, height: 0.72 },
  "🍬": { width: 0.82, height: 0.58 },
  "🍪": { width: 0.7, height: 0.7 },
  "🧸": { width: 0.68, height: 0.8 },
  "🧢": { width: 0.82, height: 0.6 },
  "🧴": { width: 0.5, height: 0.84 },
  "🎁": { width: 0.76, height: 0.76 },
  "💣": { width: 0.7, height: 0.72 }
});
let state = "title";
let width = 0;
let height = 0;
let dpr = 1;
let lastFrame = 0;
let animationId = 0;
let elapsed = 0;
let spawnTimer = 0;
let score = 0;
let combo = 0;
let items = [];
let particles = [];
let floaters = [];
let rareSpawned = false;
let highScore = safeGetNumber("shoppingCatchHighScore");
let runHighScore = highScore;
let beatHighScore = false;
let highScoreAnnounced = false;
let soundEnabled = safeGetBool("shoppingCatchSound", true);
let audioContext = null;
let bgmTimer = null;
let resizeObserver = null;
const input = { left: new Set(), right: new Set() };
const player = { x: 0.5, bounce: 0 };

function safeGetNumber(key) {
  try { return Math.max(0, Number(localStorage.getItem(key)) || 0); } catch { return 0; }
}

function safeGetBool(key, fallback) {
  try { const value = localStorage.getItem(key); return value === null ? fallback : value === "true"; } catch { return fallback; }
}

function safeSet(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* Storage is optional. */ }
}

function resizeCanvas() {
  const rect = elements.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const previousWidth = width;
  width = rect.width;
  height = rect.height;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  elements.canvas.width = Math.round(width * dpr);
  elements.canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const horizontalScale = previousWidth > 0 ? width / previousWidth : 1;
  player.x = player.x <= 1 ? width * player.x : player.x * horizontalScale;
  player.x = Math.max(getPlayerWidth() / 2, Math.min(width - getPlayerWidth() / 2, player.x));
  items.forEach((item) => { item.x = Math.max(getItemSize() / 2, Math.min(width - getItemSize() / 2, item.x * horizontalScale)); });
  draw();
}

function getPlayerWidth() { return Math.min(160, Math.max(72, width * CONFIG.playerWidthRatio)); }
function getPlayerHeight() { return getPlayerWidth() * 0.55; }
function getItemSize() { return Math.min(72, Math.max(36, width * CONFIG.itemSizeRatio)); }
function getPlayerY() { return height - getPlayerHeight() - Math.max(14, height * 0.025); }

function getBasketHitbox() {
  const basketWidth = getPlayerWidth();
  const basketHeight = getPlayerHeight();
  return {
    x: player.x - basketWidth * 0.44,
    y: getPlayerY() + basketHeight * 0.1,
    w: basketWidth * 0.88,
    h: basketHeight * 0.3
  };
}

function getItemHitbox(item, previousY = item.y) {
  const size = getItemSize();
  const ratio = itemHitboxRatios[item.icon] || { width: 0.7, height: 0.7 };
  const itemWidth = size * ratio.width;
  const itemHeight = size * ratio.height;
  const top = Math.min(previousY, item.y) - itemHeight / 2;
  const bottom = Math.max(previousY, item.y) + itemHeight / 2;
  return { x: item.x - itemWidth / 2, y: top, w: itemWidth, h: bottom - top };
}

function setState(next) {
  state = next;
  elements.title.hidden = next !== "title";
  elements.pause.hidden = next !== "paused";
  elements.result.hidden = next !== "result";
  elements.hud.hidden = next === "title";
  elements.pauseButton.disabled = !["playing", "paused"].includes(next);
}

function resetGame() {
  elapsed = 0;
  spawnTimer = 0;
  score = 0;
  combo = 0;
  items = [];
  particles = [];
  floaters = [];
  rareSpawned = false;
  runHighScore = highScore;
  beatHighScore = false;
  highScoreAnnounced = false;
  player.x = width / 2;
  player.bounce = 0;
  clearInput();
  updateHud();
}

async function startGame() {
  initAudio();
  stopLoop();
  setState("countdown");
  resetGame();
  elements.countdown.hidden = false;
  elements.hud.hidden = false;
  playSound("start");
  for (const value of [3, 2, 1]) {
    if (state !== "countdown") return;
    elements.countdown.textContent = value;
    elements.countdown.classList.remove("is-pop");
    void elements.countdown.offsetWidth;
    elements.countdown.classList.add("is-pop");
    await delay(800);
  }
  if (state !== "countdown") return;
  elements.countdown.textContent = "GO!";
  elements.countdown.classList.remove("is-pop");
  void elements.countdown.offsetWidth;
  elements.countdown.classList.add("is-pop");
  await delay(450);
  if (state !== "countdown") return;
  elements.countdown.hidden = true;
  setState("playing");
  lastFrame = performance.now();
  startBgm();
  animationId = requestAnimationFrame(loop);
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function loop(now) {
  if (state !== "playing") return;
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;
  update(dt);
  draw();
  animationId = requestAnimationFrame(loop);
}

function update(dt) {
  elapsed = Math.min(CONFIG.duration, elapsed + dt);
  if (elapsed >= CONFIG.duration) {
    updateHud();
    finishGame();
    return;
  }
  const direction = input.left.size === input.right.size ? 0 : input.left.size ? -1 : 1;
  const playerHalf = getPlayerWidth() / 2;
  player.x = Math.max(playerHalf, Math.min(width - playerHalf, player.x + direction * width * CONFIG.playerSpeedRatio * dt));
  player.bounce = Math.max(0, player.bounce - dt * 5);

  const phase = CONFIG.phases.find((candidate) => elapsed < candidate.until) || CONFIG.phases.at(-1);
  spawnTimer -= dt;
  if (spawnTimer <= 0 && items.length < phase.maxItems) {
    spawnItem(phase);
    spawnTimer = phase.interval;
  }

  const itemSize = getItemSize();
  const basket = getBasketHitbox();
  for (const item of items) {
    const previousY = item.y;
    item.y += item.speed * dt;
    item.rotation += item.spin * dt;
    const box = getItemHitbox(item, previousY);
    if (intersects(box, basket)) catchItem(item);
    else if (item.y - itemSize * 0.7 > height) missItem(item);
  }
  items = items.filter((item) => !item.done);
  particles.forEach((particle) => { particle.x += particle.vx * dt; particle.y += particle.vy * dt; particle.vy += 160 * dt; particle.life -= dt; });
  particles = particles.filter((particle) => particle.life > 0);
  floaters.forEach((floater) => { floater.y -= 44 * dt; floater.life -= dt; });
  floaters = floaters.filter((floater) => floater.life > 0);
  updateHud();
}

function intersects(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }

function spawnItem(phase) {
  const size = getItemSize();
  const activeRare = items.some((item) => item.rare);
  const activeHazard = items.some((item) => item.hazard);
  const forceRare = elapsed >= CONFIG.rareGuaranteeAt && !rareSpawned;
  const rare = !activeRare && (forceRare || Math.random() < CONFIG.rareChance);
  const hazard = !rare && !activeHazard && Math.random() < CONFIG.hazardChance;
  const minX = size;
  const maxX = width - size;
  let x = minX + Math.random() * Math.max(1, maxX - minX);
  const topItems = items.filter((item) => item.y < size * 2.2);
  for (let attempt = 0; attempt < 5 && topItems.some((item) => Math.abs(item.x - x) < size * 1.35); attempt += 1) {
    x = minX + Math.random() * Math.max(1, maxX - minX);
  }
  const fallTime = phase.fallTime[0] + Math.random() * (phase.fallTime[1] - phase.fallTime[0]);
  const icon = rare ? "🎁" : hazard ? "💣" : CONFIG.items[Math.floor(Math.random() * CONFIG.items.length)];
  items.push({ x, y: -size, speed: (height + size * 2) / fallTime, icon, rare, hazard, rotation: 0, spin: (Math.random() - .5) * 1.6, done: false });
  if (rare) rareSpawned = true;
}

function comboBonus(value) {
  if (value >= 20) return 20;
  if (value >= 10) return 10;
  if (value >= 5) return 5;
  return 0;
}

function catchItem(item) {
  if (item.done || state !== "playing") return;
  item.done = true;
  if (item.hazard) {
    score = Math.max(0, score - CONFIG.hazardPenalty);
    combo = 0;
    player.bounce = 1;
    addFloater(item.x, item.y, `-${CONFIG.hazardPenalty}`, "#c82f53");
    burst(item.x, item.y, 14, false, true);
    flashScore("score-down");
    playSound("hazard");
    announce(`DANGER! -${CONFIG.hazardPenalty}`);
    return;
  }
  combo += 1;
  const points = (item.rare ? CONFIG.rarePoints : CONFIG.normalPoints) + comboBonus(combo);
  score += points;
  player.bounce = 1;
  addFloater(item.x, item.y, `+${points}`, item.rare ? "#b66c00" : "#087e5b");
  burst(item.x, item.y, item.rare ? 18 : 7, item.rare);
  flashScore("score-up");
  playSound(item.rare ? "rare" : "catch");
  if (CONFIG.comboMilestones.includes(combo)) announce(`${combo} COMBO!`);
  checkHighScore();
}

function missItem(item) {
  if (item.done || state !== "playing") return;
  item.done = true;
  if (item.hazard) return;
  score = Math.max(0, score - CONFIG.missPenalty);
  combo = 0;
  addFloater(item.x, height - 22, `-${CONFIG.missPenalty}`, "#c82f53");
  flashScore("score-down");
  playSound("miss");
}

function checkHighScore() {
  if (score > runHighScore) {
    beatHighScore = true;
    elements.score.classList.add("new-best");
    if (!highScoreAnnounced) {
      highScoreAnnounced = true;
      announce("NEW HIGH SCORE!", true);
    }
  }
}

function addFloater(x, y, text, color) { floaters.push({ x, y, text, color, life: .65, maxLife: .65 }); }

function burst(x, y, count, rare, hazard = false) {
  const colors = hazard ? ["#c82f53", "#ff6b35", "#24324a", "#fff"] : rare ? ["#ffd84d", "#ff9f1c", "#fff", "#f04469"] : ["#fff", "#83dfc2", "#ffd84d"];
  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 45 + Math.random() * 100;
    particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 35, life: .45 + Math.random() * .35, color: colors[i % colors.length], size: 3 + Math.random() * 5 });
  }
}

function announce(text, high = false) {
  elements.announcement.textContent = text;
  elements.announcement.className = `announcement show${high ? " high-score" : ""}`;
  clearTimeout(announce.timer);
  announce.timer = setTimeout(() => { elements.announcement.className = "announcement"; }, 950);
}

function updateHud() {
  elements.score.textContent = score;
  const remaining = Math.max(0, Math.ceil(CONFIG.duration - elapsed));
  elements.time.textContent = remaining;
  elements.time.classList.toggle("is-urgent", state === "playing" && remaining <= 10);
  elements.combo.hidden = combo < 2;
  elements.combo.textContent = `${combo} COMBO!`;
}

function flashScore(className) {
  elements.score.classList.remove("score-up", "score-down");
  void elements.score.offsetWidth;
  elements.score.classList.add(className);
  setTimeout(() => elements.score.classList.remove(className), 350);
}

function draw() {
  if (!width || !height) return;
  ctx.clearRect(0, 0, width, height);
  drawBackground();
  drawItems();
  drawBasket();
  drawEffects();
}

function drawBackground() {
  const wall = ctx.createLinearGradient(0, 0, 0, height);
  wall.addColorStop(0, "#e9f7f6");
  wall.addColorStop(.57, "#fff8e8");
  wall.addColorStop(.58, "#ead9c7");
  wall.addColorStop(1, "#f7e8d7");
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, width, height);

  // 天井と照明
  ctx.fillStyle = "#d8ebea";
  ctx.fillRect(0, 0, width, height * .1);
  ctx.strokeStyle = "rgba(67, 112, 117, .16)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += width / 8) {
    ctx.beginPath();
    ctx.moveTo(width / 2, height * .1);
    ctx.lineTo(x, 0);
    ctx.stroke();
  }
  for (const x of [width * .17, width * .5, width * .83]) {
    ctx.fillStyle = "rgba(255, 244, 169, .24)";
    ctx.beginPath();
    ctx.moveTo(x - width * .05, height * .055);
    ctx.lineTo(x - width * .13, height * .5);
    ctx.lineTo(x + width * .13, height * .5);
    ctx.lineTo(x + width * .05, height * .055);
    ctx.fill();
    ctx.fillStyle = "#fffdf2";
    roundedRect(ctx, x - width * .045, height * .035, width * .09, height * .035, 5);
    ctx.fill();
  }

  // 奥の店舗サインとショーウィンドウ
  const stores = [
    { x: .035, w: .28, color: "#f27a91", label: "SWEETS" },
    { x: .36, w: .28, color: "#37a6a2", label: "MARKET" },
    { x: .685, w: .28, color: "#f0a33c", label: "GOODS" }
  ];
  for (const store of stores) {
    const x = width * store.x;
    const storeWidth = width * store.w;
    ctx.fillStyle = "#f8fbfa";
    ctx.fillRect(x, height * .14, storeWidth, height * .38);
    ctx.fillStyle = store.color;
    roundedRect(ctx, x, height * .14, storeWidth, height * .075, 7);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `900 ${Math.max(8, width * .018)}px sans-serif`;
    ctx.fillText(store.label, x + storeWidth / 2, height * .177);
    ctx.fillStyle = "#b8dde1";
    ctx.fillRect(x + storeWidth * .06, height * .235, storeWidth * .88, height * .24);
    ctx.strokeStyle = "rgba(255,255,255,.8)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + storeWidth * .5, height * .235);
    ctx.lineTo(x + storeWidth * .5, height * .475);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,.42)";
    ctx.beginPath();
    ctx.moveTo(x + storeWidth * .13, height * .245);
    ctx.lineTo(x + storeWidth * .37, height * .245);
    ctx.lineTo(x + storeWidth * .24, height * .465);
    ctx.lineTo(x + storeWidth * .08, height * .465);
    ctx.closePath();
    ctx.fill();
  }

  // 左右の商品棚。中央は商品が見やすい落下レーンとして空ける。
  drawShelf(width * .015, height * .33, width * .16, height * .3, ["#f04469", "#ffd84d", "#2f81d4"]);
  drawShelf(width * .825, height * .33, width * .16, height * .3, ["#83dfc2", "#f0a33c", "#d56cc1"]);

  // モールの床と奥行きのあるタイル
  ctx.fillStyle = "rgba(255,255,255,.32)";
  ctx.fillRect(0, height * .58, width, height * .42);
  ctx.strokeStyle = "rgba(133, 101, 79, .17)";
  ctx.lineWidth = 1;
  for (let row = 0; row <= 6; row += 1) {
    const progress = row / 6;
    const y = height * (.58 + .42 * progress * progress);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  for (let column = -4; column <= 4; column += 1) {
    ctx.beginPath();
    ctx.moveTo(width * .5, height * .58);
    ctx.lineTo(width * (.5 + column * .17), height);
    ctx.stroke();
  }
}

function drawShelf(x, y, shelfWidth, shelfHeight, colors) {
  ctx.fillStyle = "#806750";
  roundedRect(ctx, x, y, shelfWidth, shelfHeight, 5);
  ctx.fill();
  ctx.fillStyle = "#f6eadb";
  ctx.fillRect(x + shelfWidth * .06, y + shelfHeight * .04, shelfWidth * .88, shelfHeight * .88);
  for (let row = 0; row < 3; row += 1) {
    const shelfY = y + shelfHeight * (.28 + row * .29);
    ctx.fillStyle = "#806750";
    ctx.fillRect(x + shelfWidth * .04, shelfY, shelfWidth * .92, shelfHeight * .035);
    for (let product = 0; product < 3; product += 1) {
      ctx.fillStyle = colors[(row + product) % colors.length];
      roundedRect(ctx, x + shelfWidth * (.11 + product * .28), shelfY - shelfHeight * .17, shelfWidth * .18, shelfHeight * .14, 3);
      ctx.fill();
    }
  }
}

function roundedRect(context, x, y, rectWidth, rectHeight, radius) {
  const r = Math.min(radius, rectWidth / 2, rectHeight / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + rectWidth, y, x + rectWidth, y + rectHeight, r);
  context.arcTo(x + rectWidth, y + rectHeight, x, y + rectHeight, r);
  context.arcTo(x, y + rectHeight, x, y, r);
  context.arcTo(x, y, x + rectWidth, y, r);
  context.closePath();
}

function drawItems() {
  const size = getItemSize();
  for (const item of items) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.translate(item.x, item.y);
    ctx.rotate(item.rotation);
    if (item.rare) {
      ctx.shadowColor = "#ffd43b";
      ctx.shadowBlur = 20;
      ctx.fillStyle = "#9a6200";
      ctx.font = `900 ${Math.max(10, size * .2)}px sans-serif`;
      ctx.fillText("★ RARE", 0, -size * .65);
    } else if (item.hazard) {
      ctx.shadowColor = "#f04469";
      ctx.shadowBlur = 16;
      ctx.fillStyle = "#a51d3d";
      ctx.font = `900 ${Math.max(9, size * .18)}px sans-serif`;
      ctx.fillText("! DANGER", 0, -size * .65);
    }
    const sprite = getOpaqueEmojiSprite(item.icon, size);
    ctx.drawImage(sprite, -size * .7, -size * .7, size * 1.4, size * 1.4);
    ctx.restore();
  }
}

function getOpaqueEmojiSprite(icon, size) {
  const roundedSize = Math.max(1, Math.round(size));
  const cacheKey = `${icon}:${roundedSize}`;
  if (emojiSpriteCache.has(cacheKey)) return emojiSpriteCache.get(cacheKey);

  const scale = 2;
  const side = Math.ceil(roundedSize * 1.4 * scale);
  const sprite = document.createElement("canvas");
  sprite.width = side;
  sprite.height = side;
  const spriteContext = sprite.getContext("2d", { willReadFrequently: true });
  spriteContext.textAlign = "center";
  spriteContext.textBaseline = "middle";
  spriteContext.font = `${roundedSize * scale}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  spriteContext.fillText(icon, side / 2, side / 2);

  // カラー絵文字に含まれる半透明ピクセルを、背景を追加せず商品部分だけ補強する。
  const image = spriteContext.getImageData(0, 0, side, side);
  for (let index = 3; index < image.data.length; index += 4) {
    const alpha = image.data[index];
    if (alpha >= 24) image.data[index] = 255;
    else if (alpha > 0) image.data[index] = Math.min(255, alpha * 8);
  }
  spriteContext.putImageData(image, 0, 0);
  emojiSpriteCache.set(cacheKey, sprite);
  return sprite;
}

function drawBasket() {
  if (state === "title") return;
  const w = getPlayerWidth();
  const h = getPlayerHeight();
  const y = getPlayerY() - Math.sin(player.bounce * Math.PI) * 8;
  ctx.save();
  ctx.translate(player.x, y);
  ctx.strokeStyle = "#814621";
  ctx.lineWidth = Math.max(4, w * .055);
  ctx.beginPath();
  ctx.arc(0, h * .12, w * .32, Math.PI, 0);
  ctx.stroke();
  ctx.fillStyle = "#f2a94b";
  ctx.strokeStyle = "#814621";
  ctx.lineWidth = Math.max(3, w * .035);
  ctx.beginPath();
  ctx.moveTo(-w * .48, h * .18);
  ctx.lineTo(w * .48, h * .18);
  ctx.lineTo(w * .36, h * .86);
  ctx.quadraticCurveTo(0, h, -w * .36, h * .86);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.globalAlpha = .45;
  for (const offset of [-.22, 0, .22]) {
    ctx.beginPath(); ctx.moveTo(w * offset, h * .23); ctx.lineTo(w * offset * .72, h * .84); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(-w * .42, h * .5); ctx.lineTo(w * .42, h * .5); ctx.stroke();
  ctx.restore();
}

function drawEffects() {
  for (const particle of particles) {
    ctx.globalAlpha = Math.min(1, particle.life * 2);
    ctx.fillStyle = particle.color;
    ctx.fillRect(particle.x - particle.size / 2, particle.y - particle.size / 2, particle.size, particle.size);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = "center";
  ctx.font = "900 22px sans-serif";
  for (const floater of floaters) {
    ctx.globalAlpha = floater.life / floater.maxLife;
    ctx.fillStyle = floater.color;
    ctx.strokeStyle = "white";
    ctx.lineWidth = 4;
    ctx.strokeText(floater.text, floater.x, floater.y);
    ctx.fillText(floater.text, floater.x, floater.y);
  }
  ctx.globalAlpha = 1;
}

function pauseGame() {
  if (state !== "playing") return;
  cancelAnimationFrame(animationId);
  clearInput();
  setState("paused");
  stopBgm();
  draw();
  elements.resume.focus();
}

function resumeGame() {
  if (state !== "paused") return;
  setState("playing");
  lastFrame = performance.now();
  startBgm();
  animationId = requestAnimationFrame(loop);
  elements.canvas.focus?.();
}

function finishGame() {
  if (state !== "playing") return;
  stopLoop();
  clearInput();
  stopBgm();
  const isNewRecord = score > runHighScore;
  if (isNewRecord) {
    highScore = score;
    safeSet("shoppingCatchHighScore", highScore);
  }
  elements.resultScore.textContent = score;
  elements.resultHigh.textContent = highScore;
  elements.resultTitle.textContent = isNewRecord ? "ハイスコア更新！" : "RESULT";
  elements.resultBadge.textContent = isNewRecord ? "👑" : "🛍️";
  elements.resultBadge.classList.toggle("is-record", isNewRecord);
  createConfetti(isNewRecord);
  setState("result");
  playSound(isNewRecord ? "record" : "finish");
  elements.replay.focus();
}

function goHome() {
  stopLoop();
  stopBgm();
  clearInput();
  elements.countdown.hidden = true;
  elements.titleHigh.textContent = highScore;
  elements.score.classList.remove("new-best");
  setState("title");
  resizeCanvas();
  elements.start.focus();
}

function stopLoop() { cancelAnimationFrame(animationId); animationId = 0; }
function clearInput() { input.left.clear(); input.right.clear(); elements.left.classList.remove("is-active"); elements.right.classList.remove("is-active"); }

function createConfetti(show) {
  elements.confetti.replaceChildren();
  if (!show || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#f04469", "#ffd84d", "#2f81d4", "#83dfc2"];
  for (let i = 0; i < 28; i += 1) {
    const piece = document.createElement("i");
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${Math.random() * 1.5}s`;
    piece.style.animationDuration = `${1.8 + Math.random() * 1.5}s`;
    elements.confetti.append(piece);
  }
}

function initAudio() {
  if (!soundEnabled || audioContext) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  audioContext = new AudioContext();
}

function tone(frequency, duration, type = "sine", volume = .045, delaySeconds = 0) {
  if (!soundEnabled || !audioContext) return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const start = audioContext.currentTime + delaySeconds;
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + .015);
  gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + .02);
}

function playSound(kind) {
  if (!soundEnabled) return;
  initAudio();
  const sounds = {
    start: () => [523, 659, 784].forEach((f, i) => tone(f, .16, "triangle", .05, i * .1)),
    catch: () => { tone(740, .09, "sine"); tone(988, .12, "sine", .04, .06); },
    rare: () => [659, 880, 1175].forEach((f, i) => tone(f, .2, "triangle", .055, i * .07)),
    miss: () => { tone(220, .18, "square", .025); tone(165, .2, "square", .02, .08); },
    hazard: () => { tone(150, .22, "sawtooth", .04); tone(95, .28, "square", .035, .08); },
    finish: () => [523, 392].forEach((f, i) => tone(f, .28, "triangle", .045, i * .18)),
    record: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, .3, "triangle", .055, i * .12))
  };
  sounds[kind]?.();
}

function startBgm() {
  stopBgm();
  if (!soundEnabled) return;
  initAudio();
  let step = 0;
  const notes = [262, 330, 392, 330, 294, 349, 440, 349];
  bgmTimer = setInterval(() => { if (state === "playing") tone(notes[step++ % notes.length], .14, "triangle", .012); }, 360);
}

function stopBgm() { clearInterval(bgmTimer); bgmTimer = null; }

function toggleSound() {
  soundEnabled = !soundEnabled;
  safeSet("shoppingCatchSound", soundEnabled);
  elements.sound.textContent = soundEnabled ? "♪" : "×";
  elements.sound.setAttribute("aria-pressed", String(!soundEnabled));
  elements.sound.setAttribute("aria-label", soundEnabled ? "サウンドをオフにする" : "サウンドをオンにする");
  if (soundEnabled) { initAudio(); playSound("catch"); if (state === "playing") startBgm(); } else stopBgm();
}

function setDirection(direction, source, active) {
  const set = input[direction];
  if (active) set.add(source); else set.delete(source);
}

function bindControl(button, direction) {
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    button.setPointerCapture?.(event.pointerId);
    setDirection(direction, event.pointerId, true);
    button.classList.add("is-active");
  });
  const release = (event) => {
    setDirection(direction, event.pointerId, false);
    if (!input[direction].size) button.classList.remove("is-active");
  };
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("lostpointercapture", release);
  button.addEventListener("pointerleave", (event) => { if (event.buttons) release(event); });
  button.addEventListener("pointermove", (event) => {
    if (!event.buttons) return;
    const rect = button.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) release(event);
  });
}

function onKeyDown(event) {
  const key = event.key.toLowerCase();
  if (["arrowleft", "arrowright", "a", "d", " "].includes(key)) event.preventDefault();
  if (["arrowleft", "a"].includes(key)) setDirection("left", key, true);
  if (["arrowright", "d"].includes(key)) setDirection("right", key, true);
  if (event.repeat) return;
  if ((key === "enter" || key === " ") && state === "title") startGame();
  else if ((key === "enter" || key === " ") && state === "result") startGame();
  else if ((key === "p" || key === "escape") && state === "playing") pauseGame();
  else if ((key === "p" || key === "escape") && state === "paused") resumeGame();
}

function onKeyUp(event) {
  const key = event.key.toLowerCase();
  if (["arrowleft", "a"].includes(key)) setDirection("left", key, false);
  if (["arrowright", "d"].includes(key)) setDirection("right", key, false);
}

function onCanvasPointerMove(event) {
  if (event.pointerType !== "mouse" || state !== "playing") return;
  const rect = elements.canvas.getBoundingClientRect();
  if (!rect.width) return;
  const playerHalf = getPlayerWidth() / 2;
  const pointerX = (event.clientX - rect.left) * (width / rect.width);
  player.x = Math.max(playerHalf, Math.min(width - playerHalf, pointerX));
}

elements.start.addEventListener("click", startGame);
elements.replay.addEventListener("click", startGame);
elements.pauseButton.addEventListener("click", pauseGame);
elements.resume.addEventListener("click", resumeGame);
elements.quit.addEventListener("click", goHome);
elements.home.addEventListener("click", goHome);
elements.sound.addEventListener("click", toggleSound);
bindControl(elements.left, "left");
bindControl(elements.right, "right");
elements.canvas.addEventListener("pointermove", onCanvasPointerMove);
window.addEventListener("keydown", onKeyDown);
window.addEventListener("keyup", onKeyUp);
window.addEventListener("blur", clearInput);
document.addEventListener("visibilitychange", () => { if (document.hidden && state === "playing") pauseGame(); });

elements.titleHigh.textContent = highScore;
elements.sound.textContent = soundEnabled ? "♪" : "×";
elements.sound.setAttribute("aria-pressed", String(!soundEnabled));
elements.sound.setAttribute("aria-label", soundEnabled ? "サウンドをオフにする" : "サウンドをオンにする");
resizeObserver = new ResizeObserver(resizeCanvas);
resizeObserver.observe(elements.canvas);
setState("title");
requestAnimationFrame(resizeCanvas);
