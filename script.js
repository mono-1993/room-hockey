"use strict";

const lobby = document.getElementById("lobby");
const game = document.getElementById("game");
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const nameInput = document.getElementById("nameInput");
const roomUrlInput = document.getElementById("roomUrl");
const copyButton = document.getElementById("copyButton");
const cpuCountInput = document.getElementById("cpuCount");
const cpuMinus = document.getElementById("cpuMinus");
const cpuPlus = document.getElementById("cpuPlus");
const startButton = document.getElementById("startButton");
const leaveButton = document.getElementById("leaveButton");
const statusBox = document.getElementById("status");
const playersBox = document.getElementById("players");
const hud = document.getElementById("hud");
const touchPad = document.getElementById("touchPad");
const stick = document.getElementById("stick");
const powerButton = document.getElementById("powerButton");

const ARENA = { width: 800, height: 1200 };
const MAX_PLAYERS = 6;
const keys = new Set();
const input = { x: 0, y: 0, power: false };
const targetInput = { x: 0, y: 0 };

let ws = null;
let roomId = "";
let myId = "";
let snapshot = null;
let connected = false;
let joined = false;
let touchOrigin = null;
let touchId = null;
let lastEventSeq = 0;
const effects = [];
const ballTrails = new Map();

function randomRoom() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function initRoom() {
  const params = new URLSearchParams(location.search);
  roomId = (params.get("room") || randomRoom()).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || randomRoom();
  const url = new URL(location.href);
  url.searchParams.set("room", roomId);
  history.replaceState(null, "", url);
  roomUrlInput.value = url.href;
  nameInput.value = localStorage.getItem("roomHockeyName") || `Player${Math.floor(Math.random() * 90 + 10)}`;
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  statusBox.textContent = "接続中...";

  ws.addEventListener("open", () => {
    connected = true;
    statusBox.textContent = "接続しました。参加ボタンを押してください。";
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "joined") {
      myId = message.id;
      joined = true;
      lobby.classList.add("hidden");
      game.classList.remove("hidden");
      statusBox.textContent = "参加中";
    }
    if (message.type === "full") {
      statusBox.textContent = "このルームは満員です。別のURLで作成してください。";
    }
    if (message.type === "state") {
      snapshot = message.state;
      consumeEvents(snapshot.events || []);
      renderLobbyPlayers();
      updateHud();
    }
  });

  ws.addEventListener("close", () => {
    connected = false;
    joined = false;
    statusBox.textContent = "切断されました。再接続しています...";
    setTimeout(connect, 1200);
  });
}

function send(data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(data));
}

function joinRoom() {
  if (!connected) return;
  const name = nameInput.value.trim() || "Player";
  localStorage.setItem("roomHockeyName", name);
  send({ type: "join", room: roomId, name, cpuCount: Number(cpuCountInput.value) || 0 });
}

function updateHud() {
  if (!snapshot) return;
  const me = snapshot.players.find((player) => player.id === myId);
  const team = me?.team === 0 ? "A" : "B";
  hud.innerHTML = `
    <div class="chip">Room ${roomId}</div>
    <div class="chip">Team A ${snapshot.scores[0]}</div>
    <div class="chip">Team B ${snapshot.scores[1]}</div>
    <div class="chip">You ${team}</div>
    <div class="chip">${snapshot.players.length}/${MAX_PLAYERS}</div>
  `;
  const cooldown = me ? Math.max(0, me.cooldown) : 0;
  powerButton.classList.toggle("cooldown", cooldown > 0);
  powerButton.textContent = cooldown > 0 ? cooldown.toFixed(1) : "POWER";
}

function renderLobbyPlayers() {
  if (!snapshot || joined) return;
  playersBox.innerHTML = snapshot.players.map((player) => `
    <div class="player-row ${player.cpu ? "cpu" : ""}">
      <strong>${escapeHtml(player.name)}${player.cpu ? " CPU" : ""}</strong>
      <span class="${player.team === 0 ? "team-a" : "team-b"}">Team ${player.team === 0 ? "A" : "B"}</span>
    </div>
  `).join("") || "<span>まだ参加者はいません</span>";
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}

function resize() {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  canvas.width = Math.floor(innerWidth * dpr);
  canvas.height = Math.floor(innerHeight * dpr);
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function view() {
  const marginX = Math.max(18, Math.min(innerWidth, innerHeight) * 0.045);
  const top = Math.max(74, Math.min(innerWidth, innerHeight) * 0.08);
  const bottom = Math.max(126, Math.min(innerWidth, innerHeight) * 0.16);
  const width = Math.min(innerWidth - marginX * 2, Math.max(280, innerHeight * 0.48));
  const height = Math.min(innerHeight - top - bottom, width * 1.5);
  return { x: (innerWidth - width) / 2, y: top, w: width, h: height };
}

function sx(x, v) {
  return v.x + (x / ARENA.width) * v.w;
}

function sy(y, v) {
  return v.y + (screenY(y) / ARENA.height) * v.h;
}

function sr(r, v) {
  return r * (v.w / ARENA.width);
}

function me() {
  return snapshot?.players.find((player) => player.id === myId);
}

function isFlipped() {
  return me()?.team === 1;
}

function screenY(y) {
  return isFlipped() ? ARENA.height - y : y;
}

function inputForServer() {
  return {
    x: input.x,
    y: isFlipped() ? -input.y : input.y,
    power: input.power,
  };
}

function draw() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  const v = view();
  updateEffects();

  ctx.fillStyle = "#121b22";
  ctx.fillRect(v.x, v.y, v.w, v.h);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 3;
  ctx.strokeRect(v.x, v.y, v.w, v.h);

  ctx.fillStyle = "rgba(255,255,255,0.035)";
  ctx.fillRect(v.x, v.y, v.w, v.h / 2);
  ctx.fillStyle = "rgba(53,216,135,0.055)";
  ctx.fillRect(v.x, v.y + v.h / 2, v.w, v.h / 2);
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.beginPath();
  ctx.moveTo(v.x, v.y + v.h / 2);
  ctx.lineTo(v.x + v.w, v.y + v.h / 2);
  ctx.stroke();

  drawGoal(v, 0);
  drawGoal(v, 1);

  if (snapshot) {
    snapshot.balls.forEach((ball) => drawBall(ball, v));
  }
  drawEffects(v);
  if (snapshot) {
    snapshot.players.forEach((player) => drawPlayer(player, v));
  }

  requestAnimationFrame(draw);
}

function drawGoal(v, team) {
  const color = team === 0 ? "#35d887" : "#ffbf42";
  const worldY = team === 0 ? ARENA.height : 0;
  const y = sy(worldY, v);
  const half = v.w * 0.28;
  ctx.strokeStyle = color;
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(v.x + v.w / 2 - half, y);
  ctx.lineTo(v.x + v.w / 2 + half, y);
  ctx.stroke();
}

function drawPlayer(player, v) {
  const x = sx(player.x, v);
  const y = sy(player.y, v);
  const color = player.team === 0 ? "#35d887" : "#ffbf42";
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, sr(player.r, v), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = player.id === myId ? "#ffffff" : "rgba(0,0,0,0.45)";
  ctx.lineWidth = player.id === myId ? 4 : 2;
  ctx.stroke();
  ctx.fillStyle = "#07100d";
  ctx.font = `700 ${Math.max(10, sr(15, v))}px system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(player.name.slice(0, 4), x, y);
}

function drawBall(ball, v) {
  const key = `${ball.x}:${ball.y}:${ball.r}`;
  const trailKey = snapshot.balls.indexOf(ball);
  const trail = ballTrails.get(trailKey) || [];
  trail.push({ x: ball.x, y: ball.y });
  while (trail.length > 10) trail.shift();
  ballTrails.set(trailKey, trail);

  trail.forEach((point, index) => {
    const alpha = index / trail.length;
    ctx.globalAlpha = alpha * 0.45;
    ctx.fillStyle = "#62c8ff";
    ctx.beginPath();
    ctx.arc(sx(point.x, v), sy(point.y, v), sr(ball.r * alpha, v), 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;

  ctx.fillStyle = "#f8fbff";
  ctx.beginPath();
  ctx.arc(sx(ball.x, v), sy(ball.y, v), sr(ball.r, v), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#62c8ff";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function consumeEvents(events) {
  events.forEach((event) => {
    if (event.seq <= lastEventSeq) return;
    lastEventSeq = event.seq;
    addEffect(event);
  });
}

function addEffect(event) {
  const color = event.team === 0 ? "#35d887" : "#ffbf42";
  if (event.kind === "score") {
    effects.push({ kind: "flash", x: event.x, y: event.y, color, life: 0.8, maxLife: 0.8, radius: 190 });
  }
  if (event.kind === "addBall") {
    effects.push({ kind: "ring", x: event.x, y: event.y, color: "#62c8ff", life: 0.7, maxLife: 0.7, radius: 160, width: 5 });
  }
  if (event.kind === "hit" || event.kind === "power") {
    const strong = event.kind === "power";
    effects.push({ kind: "ring", x: event.x, y: event.y, color, life: strong ? 0.5 : 0.3, maxLife: strong ? 0.5 : 0.3, radius: strong ? 110 : 62, width: strong ? 5 : 3 });
    const count = strong ? 24 : 12;
    for (let i = 0; i < count; i += 1) {
      const angle = Math.PI * 2 * (i / count) + (Math.random() - 0.5) * 0.35;
      const speed = strong ? 240 : 140;
      effects.push({
        kind: "spark",
        x: event.x,
        y: event.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        color,
        life: strong ? 0.42 : 0.28,
        maxLife: strong ? 0.42 : 0.28,
      });
    }
  }
}

function updateEffects() {
  for (let i = effects.length - 1; i >= 0; i -= 1) {
    effects[i].life -= 1 / 60;
    if (effects[i].life <= 0) effects.splice(i, 1);
  }
}

function drawEffects(v) {
  effects.forEach((effect) => {
    const alpha = Math.max(0, effect.life / effect.maxLife);
    const progress = 1 - alpha;
    ctx.globalAlpha = alpha;
    if (effect.kind === "ring") {
      ctx.strokeStyle = effect.color;
      ctx.lineWidth = effect.width;
      ctx.beginPath();
      ctx.arc(sx(effect.x, v), sy(effect.y, v), sr(effect.radius * (0.35 + progress), v), 0, Math.PI * 2);
      ctx.stroke();
    } else if (effect.kind === "flash") {
      const gradient = ctx.createRadialGradient(sx(effect.x, v), sy(effect.y, v), 0, sx(effect.x, v), sy(effect.y, v), sr(effect.radius, v));
      gradient.addColorStop(0, `${effect.color}88`);
      gradient.addColorStop(1, `${effect.color}00`);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(sx(effect.x, v), sy(effect.y, v), sr(effect.radius, v), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = effect.color;
      ctx.beginPath();
      ctx.arc(sx(effect.x + effect.vx * progress, v), sy(effect.y + effect.vy * progress, v), sr(7 * alpha + 3, v), 0, Math.PI * 2);
      ctx.fill();
    }
  });
  ctx.globalAlpha = 1;
}

function updateKeyboardInput() {
  let x = 0;
  let y = 0;
  if (keys.has("ArrowLeft") || keys.has("KeyA")) x -= 1;
  if (keys.has("ArrowRight") || keys.has("KeyD")) x += 1;
  if (keys.has("ArrowUp") || keys.has("KeyW")) y -= 1;
  if (keys.has("ArrowDown") || keys.has("KeyS")) y += 1;
  if (!touchOrigin) {
    const length = Math.hypot(x, y) || 1;
    targetInput.x = x / length;
    targetInput.y = y / length;
  }
  input.x += (targetInput.x - input.x) * 0.48;
  input.y += (targetInput.y - input.y) * 0.48;
  if (Math.abs(input.x) < 0.015) input.x = 0;
  if (Math.abs(input.y) < 0.015) input.y = 0;
  send({ type: "input", input: inputForServer() });
  input.power = false;
}

function setTouchInput(clientX, clientY) {
  const dx = clientX - touchOrigin.x;
  const dy = clientY - touchOrigin.y;
  const rect = touchPad.getBoundingClientRect();
  const limit = Math.max(74, Math.min(rect.width, rect.height) * 0.38);
  const deadZone = 8;
  const rawLength = Math.hypot(dx, dy);
  const length = Math.min(limit, Math.max(0, rawLength - deadZone));
  const angle = Math.atan2(dy, dx);
  const amount = Math.pow(length / limit, 0.72);
  targetInput.x = Math.cos(angle) * amount;
  targetInput.y = Math.sin(angle) * amount;
  stick.style.transform = `translate(calc(-50% + ${targetInput.x * 58}px), calc(-50% + ${targetInput.y * 58}px))`;
}

function clearTouchInput() {
  touchOrigin = null;
  touchId = null;
  targetInput.x = 0;
  targetInput.y = 0;
  stick.style.transform = "translate(-50%, -50%)";
}

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(roomUrlInput.value);
  copyButton.textContent = "コピー済み";
  setTimeout(() => { copyButton.textContent = "コピー"; }, 1000);
});

function setCpuCount(value) {
  const cpuCount = Math.max(0, Math.min(5, Number(value) || 0));
  cpuCountInput.value = cpuCount;
  send({ type: "setCpu", room: roomId, cpuCount });
}

cpuMinus.addEventListener("click", () => setCpuCount(Number(cpuCountInput.value) - 1));
cpuPlus.addEventListener("click", () => setCpuCount(Number(cpuCountInput.value) + 1));
cpuCountInput.addEventListener("input", () => setCpuCount(cpuCountInput.value));

startButton.addEventListener("click", joinRoom);
leaveButton.addEventListener("click", () => location.href = location.pathname);
powerButton.addEventListener("pointerdown", () => {
  input.power = true;
  send({ type: "input", input: inputForServer() });
});

touchPad.addEventListener("pointerdown", (event) => {
  touchId = event.pointerId;
  touchPad.setPointerCapture(touchId);
  touchOrigin = { x: event.clientX, y: event.clientY };
  setTouchInput(event.clientX, event.clientY);
});

touchPad.addEventListener("pointermove", (event) => {
  if (event.pointerId !== touchId || !touchOrigin) return;
  setTouchInput(event.clientX, event.clientY);
});

touchPad.addEventListener("pointerup", clearTouchInput);
touchPad.addEventListener("pointercancel", clearTouchInput);

window.addEventListener("keydown", (event) => {
  keys.add(event.code);
  if (event.code === "Space") {
    event.preventDefault();
    input.power = true;
  }
});

window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
});

window.addEventListener("resize", resize);

initRoom();
resize();
connect();
setInterval(updateKeyboardInput, 1000 / 60);
requestAnimationFrame(draw);
