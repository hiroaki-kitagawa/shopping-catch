"use strict";

const CONFIG = Object.freeze({
  duration: 60,
  normalPoints: 10,
  rarePoints: 50,
  missPenalty: 5,
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

function getPlayerWidth() { return Math.max(72, width * CONFIG.playerWidthRatio); }
function getPlayerHeight() { return getPlayerWidth() * 0.55; }
function getItemSize() { return Math.max(34, width * CONFIG.itemSizeRatio); }
function getPlayerY() { return height - getPlayerHeight() - Math.max(14, height * 0.025); }

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
  const basket = { x: player.x - getPlayerWidth() * 0.42, y: getPlayerY() + getPlayerHeight() * 0.14, w: getPlayerWidth() * 0.84, h: getPlayerHeight() * 0.45 };
  for (const item of items) {
    item.y += item.speed * dt;
    item.rotation += item.spin * dt;
    const box = { x: item.x - itemSize * 0.38, y: item.y - itemSize * 0.38, w: itemSize * 0.76, h: itemSize * 0.76 };
    if (intersects(box, basket)) catchItem(item);
    else if (item.y - itemSize / 2 > height) missItem(item);
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
  const forceRare = elapsed >= CONFIG.rareGuaranteeAt && !rareSpawned;
  const rare = !activeRare && (forceRare || Math.random() < CONFIG.rareChance);
  const minX = size;
  const maxX = width - size;
  let x = minX + Math.random() * Math.max(1, maxX - minX);
  const topItems = items.filter((item) => item.y < size * 2.2);
  for (let attempt = 0; attempt < 5 && topItems.some((item) => Math.abs(item.x - x) < size * 1.35); attempt += 1) {
    x = minX + Math.random() * Math.max(1, maxX - minX);
  }
  const fallTime = phase.fallTime[0] + Math.random() * (phase.fallTime[1] - phase.fallTime[0]);
  items.push({ x, y: -size, speed: (height + size * 2) / fallTime, icon: rare ? "🎁" : CONFIG.items[Math.floor(Math.random() * CONFIG.items.length)], rare, rotation: 0, spin: (Math.random() - .5) * 1.6, done: false });
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

function burst(x, y, count, rare) {
  const colors = rare ? ["#ffd84d", "#ff9f1c", "#fff", "#f04469"] : ["#fff", "#83dfc2", "#ffd84d"];
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
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#b9eff0");
  sky.addColorStop(.72, "#e5f8e8");
  sky.addColorStop(1, "#fff0bf");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "rgba(255,255,255,.72)";
  for (let i = 0; i < 5; i += 1) {
    const x = ((i * 173 + 30) % 610) / 610 * width;
    const y = (55 + (i % 3) * 78) / 720 * height;
    ctx.beginPath();
    ctx.ellipse(x, y, 28, 11, 0, 0, Math.PI * 2);
    ctx.ellipse(x + 22, y + 2, 21, 9, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "rgba(77,187,124,.25)";
  ctx.beginPath();
  ctx.moveTo(0, height);
  for (let x = 0; x <= width; x += width / 8) ctx.lineTo(x, height * (.86 + .035 * Math.sin(x * .03)));
  ctx.lineTo(width, height);
  ctx.fill();
}

function drawItems() {
  const size = getItemSize();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const item of items) {
    ctx.save();
    ctx.translate(item.x, item.y);
    ctx.rotate(item.rotation);
    if (item.rare) {
      ctx.shadowColor = "#ffd43b";
      ctx.shadowBlur = 20;
      ctx.fillStyle = "rgba(255,216,77,.5)";
      ctx.beginPath();
      ctx.arc(0, 0, size * .58, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#9a6200";
      ctx.font = `900 ${Math.max(10, size * .2)}px sans-serif`;
      ctx.fillText("★ RARE", 0, -size * .65);
    }
    ctx.font = `${size}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.fillText(item.icon, 0, 0);
    ctx.restore();
  }
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

elements.start.addEventListener("click", startGame);
elements.replay.addEventListener("click", startGame);
elements.pauseButton.addEventListener("click", pauseGame);
elements.resume.addEventListener("click", resumeGame);
elements.quit.addEventListener("click", goHome);
elements.home.addEventListener("click", goHome);
elements.sound.addEventListener("click", toggleSound);
bindControl(elements.left, "left");
bindControl(elements.right, "right");
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
