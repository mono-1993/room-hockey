"use strict";

const lobby = document.getElementById("lobby");
const game = document.getElementById("game");
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const nameInput = document.getElementById("nameInput");
const roomUrlInput = document.getElementById("roomUrl");
const copyButton = document.getElementById("copyButton");
const winScoreInput = document.getElementById("winScoreInput");
const teamAButton = document.getElementById("teamAButton");
const teamBButton = document.getElementById("teamBButton");
const cpuAInput = document.getElementById("cpuAInput");
const cpuBInput = document.getElementById("cpuBInput");
const cpuAMinus = document.getElementById("cpuAMinus");
const cpuAPlus = document.getElementById("cpuAPlus");
const cpuBMinus = document.getElementById("cpuBMinus");
const cpuBPlus = document.getElementById("cpuBPlus");
const joinButton = document.getElementById("joinButton");
const startButton = document.getElementById("startButton");
const leaveButton = document.getElementById("leaveButton");
const statusBox = document.getElementById("status");
const playersBox = document.getElementById("players");
const hud = document.getElementById("hud");
const touchPad = document.getElementById("touchPad");
const stick = document.getElementById("stick");
const boostButton = document.getElementById("boostButton");
const replayButton = document.getElementById("replayButton");
const rulesButton = document.getElementById("rulesButton");

const ARENA = { width: 800, height: 1200 };
const MAX_PLAYERS = 6;
const joystickDeadZone = 4;
const joystickMaxDistance = 54;
const keys = new Set();
const input = { x: 0, y: 0, boost: false };
const targetInput = { x: 0, y: 0 };

let ws = null;
let roomId = "";
let myId = "";
let snapshot = null;
let connected = false;
let joined = false;
let selectedTeam = 0;
let touchOrigin = null;
let touchId = null;
let lastEventSeq = 0;
const effects = [];
const ballTrails = new Map();
const configInputs = new Set([winScoreInput, cpuAInput, cpuBInput]);
const DEFAULT_WIN_SCORE = 10;
const MAX_NAME_LENGTH = 2;

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
  nameInput.value = (localStorage.getItem("roomHockeyName") || `P${Math.floor(Math.random() * 9 + 1)}`).slice(0, MAX_NAME_LENGTH);
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  statusBox.textContent = "接続中...";

  ws.addEventListener("open", () => {
    connected = true;
    statusBox.textContent = "接続しました。チームを選んで参加してください。";
    sendConfig();
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "joined") {
      myId = message.id;
      joined = true;
      statusBox.textContent = "参加中。全員がそろったらゲーム開始を押してください。";
    }
    if (message.type === "full") {
      statusBox.textContent = "このルームは満員です。CPUを減らすか別のURLで作成してください。";
    }
    if (message.type === "started") {
      statusBox.textContent = "この試合は開始済みです。別のルームを作成してください。";
    }
    if (message.type === "state") {
      snapshot = message.state;
      consumeEvents(snapshot.events || []);
      syncConfigFromState();
      renderLobbyPlayers();
      updateHud();
      updateScreenMode();
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

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function readWinScore() {
  const value = Number(winScoreInput.value);
  if (Number.isFinite(value) && value > 0) return clampNumber(Math.floor(value), 1, 99);
  return snapshot?.winScore || DEFAULT_WIN_SCORE;
}

function commitWinScore() {
  winScoreInput.value = readWinScore();
  sendConfig();
}

function sendConfig() {
  send({
    type: "setConfig",
    room: roomId,
    winScore: readWinScore(),
    cpuA: Number(cpuAInput.value) || 0,
    cpuB: Number(cpuBInput.value) || 0,
  });
}

function joinRoom() {
  if (!connected || joined) return;
  const name = (nameInput.value.trim() || "P1").slice(0, MAX_NAME_LENGTH);
  nameInput.value = name;
  localStorage.setItem("roomHockeyName", name);
  sendConfig();
  send({ type: "join", room: roomId, name, team: selectedTeam });
}

function startGame() {
  sendConfig();
  send({ type: "start", room: roomId });
}

function openRuleSettings() {
  send({ type: "configure", room: roomId });
}

function bindActionButton(button, action) {
  let handledAt = 0;
  const run = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (now - handledAt < 250) return;
    handledAt = now;
    action();
  };
  button.addEventListener("click", run);
  button.addEventListener("pointerup", run);
  button.addEventListener("touchend", run, { passive: false });
}

function updateScreenMode() {
  const playing = Boolean(snapshot?.started);
  lobby.classList.toggle("hidden", playing);
  game.classList.toggle("hidden", !playing);
  joinButton.disabled = joined || playing;
  startButton.disabled = !joined || !snapshot?.canStart;
  replayButton.classList.toggle("hidden", !snapshot?.gameOver);
  rulesButton.classList.toggle("hidden", !snapshot?.gameOver);
  if (!playing && joined && snapshot) {
    const total = snapshot.players.length;
    statusBox.textContent = total >= 2 ? "参加中。ゲーム開始できます。" : "参加中。2人以上で開始できます。";
  }
}

function syncConfigFromState() {
  if (!snapshot || snapshot.started) return;
  if (configInputs.has(document.activeElement)) return;
  winScoreInput.value = snapshot.winScore || DEFAULT_WIN_SCORE;
  cpuAInput.value = snapshot.cpuTargets?.[0] || 0;
  cpuBInput.value = snapshot.cpuTargets?.[1] || 0;
}

function updateTeamButtons() {
  teamAButton.classList.toggle("active", selectedTeam === 0);
  teamBButton.classList.toggle("active", selectedTeam === 1);
}

function updateHud() {
  if (!snapshot) return;
  const me = snapshot.players.find((player) => player.id === myId);
  const team = me?.team === 0 ? "A" : "B";
  const goalTimer = me ? Math.ceil(snapshot.goalTimers?.[me.team] || 0) : 0;
  hud.innerHTML = `
    <div class="scoreboard">
      <div class="score-team score-a">
        <span>TEAM A</span>
        <strong>${snapshot.scores[0]}</strong>
      </div>
      <div class="score-limit">${snapshot.winScore || DEFAULT_WIN_SCORE}</div>
      <div class="score-team score-b">
        <span>TEAM B</span>
        <strong>${snapshot.scores[1]}</strong>
      </div>
    </div>
    <div class="hud-row">
      <div class="chip">You ${team}</div>
      ${goalTimer > 0 ? `<div class="chip">Goal ${goalTimer}</div>` : ""}
      <div class="chip">${snapshot.players.length}/${MAX_PLAYERS}</div>
    </div>
    ${snapshot.gameOver ? `<div class="chip">GAME SET Team ${snapshot.winner === 0 ? "A" : "B"}</div>` : ""}
  `;
  const mePlayer = me || null;
  boostButton.classList.toggle("active", Boolean(mePlayer?.boost));
  boostButton.textContent = input.boost ? "加速中" : "加速";
  if (snapshot.gameOver) {
    const ready = snapshot.replayReady || 0;
    const total = snapshot.replayTotal || 0;
    replayButton.textContent = mePlayer?.replayReady ? `準備OK ${ready}/${total}` : `もう一度遊ぶ ${ready}/${total}`;
  } else {
    replayButton.textContent = "もう一度遊ぶ";
  }
}

function renderLobbyPlayers() {
  if (!snapshot) return;
  const teams = [0, 1].map((team) => {
    const players = snapshot.players.filter((player) => player.team === team);
    return `
      <div class="team-list ${team === 0 ? "team-a-border" : "team-b-border"}">
        <strong>Team ${team === 0 ? "A" : "B"} ${players.length}人</strong>
        ${players.map((player) => `
          <div class="player-row ${player.cpu ? "cpu" : ""}">
            <span>${escapeHtml(player.name)}${player.cpu ? " CPU" : ""}</span>
            <span>${player.id === myId ? "YOU" : player.cpu ? "CPU" : "JOINED"}</span>
          </div>
        `).join("") || "<span class=\"empty-team\">未参加</span>"}
      </div>
    `;
  });
  playersBox.innerHTML = teams.join("");
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
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
    boost: input.boost,
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
    (snapshot.items || []).forEach((item) => drawItem(item, v));
    snapshot.balls.forEach((ball, index) => drawBall(ball, index, v));
  }
  drawEffects(v);
  if (snapshot) snapshot.players.forEach((player) => drawPlayer(player, v));
  drawGameSet(v);

  requestAnimationFrame(draw);
}

function drawGoal(v, team) {
  const color = team === 0 ? "#35d887" : "#ffbf42";
  const worldY = team === 0 ? ARENA.height : 0;
  const y = sy(worldY, v);
  const halfWorld = snapshot?.goalHalfWidths?.[team] || 220;
  const half = (halfWorld / ARENA.width) * v.w;
  const protectedGoal = (snapshot?.goalTimers?.[team] || 0) > 0;
  const goalStacks = snapshot?.goalStacks?.[team] || 0;
  if (protectedGoal) {
    const pulse = 0.82 + Math.sin(performance.now() / 120) * 0.18;
    const gradient = ctx.createLinearGradient(v.x + v.w / 2 - half * 1.7, y, v.x + v.w / 2 + half * 1.7, y);
    gradient.addColorStop(0, `${color}00`);
    gradient.addColorStop(0.5, `${color}cc`);
    gradient.addColorStop(1, `${color}00`);
    ctx.strokeStyle = gradient;
    ctx.lineWidth = (30 + goalStacks * 8) * pulse;
    ctx.beginPath();
    ctx.moveTo(v.x + v.w / 2 - half * 1.5, y);
    ctx.lineTo(v.x + v.w / 2 + half * 1.5, y);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 3 + goalStacks;
    const guard = Math.max(18, v.w * 0.035);
    ctx.beginPath();
    ctx.moveTo(v.x + v.w / 2 - half - guard, y);
    ctx.lineTo(v.x + v.w / 2 - half - guard * 0.2, y + (team === 0 ? -guard : guard));
    ctx.moveTo(v.x + v.w / 2 + half + guard, y);
    ctx.lineTo(v.x + v.w / 2 + half + guard * 0.2, y + (team === 0 ? -guard : guard));
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = protectedGoal ? 16 + goalStacks * 3 : 10;
  ctx.beginPath();
  ctx.moveTo(v.x + v.w / 2 - half, y);
  ctx.lineTo(v.x + v.w / 2 + half, y);
  ctx.stroke();
}

function drawPlayer(player, v) {
  const x = sx(player.x, v);
  const y = sy(player.y, v);
  const color = player.team === 0 ? "#35d887" : "#ffbf42";
  const wideStacks = player.wideStacks || (player.wideTimer > 0 ? 1 : 0);
  const strongStacks = player.strongStacks || (player.strongTimer > 0 ? 1 : 0);
  if (player.boost) {
    ctx.globalAlpha = 0.45 + Math.sin(performance.now() / 80) * 0.12;
    ctx.strokeStyle = "#62c8ff";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(x, y, sr(player.r + 14, v), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (player.wideTimer > 0) {
    ctx.globalAlpha = Math.min(0.48, 0.22 + wideStacks * 0.08);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(x, y, sr(player.r * (1.15 + wideStacks * 0.22), v), sr(player.r * 0.72, v), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, sr(player.r, v), 0, Math.PI * 2);
  ctx.fill();
  if (player.strongTimer > 0) {
    ctx.strokeStyle = "#ff4d6d";
    ctx.lineWidth = 4 + strongStacks * 2;
    ctx.beginPath();
    ctx.arc(x, y, sr(player.r + 8 + strongStacks * 4, v), 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 2;
    const sparks = 8 + strongStacks * 4;
    for (let i = 0; i < sparks; i += 1) {
      const angle = (Math.PI * 2 * i) / sparks + performance.now() / 180;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(angle) * sr(player.r + 14, v), y + Math.sin(angle) * sr(player.r + 14, v));
      ctx.lineTo(x + Math.cos(angle) * sr(player.r + 25 + strongStacks * 3, v), y + Math.sin(angle) * sr(player.r + 25 + strongStacks * 3, v));
      ctx.stroke();
    }
  }
  ctx.strokeStyle = player.id === myId ? "#ffffff" : "rgba(0,0,0,0.45)";
  ctx.lineWidth = player.id === myId ? 4 : 2;
  ctx.stroke();
  ctx.fillStyle = "#07100d";
  ctx.font = `700 ${Math.max(10, sr(15, v))}px system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(player.name.slice(0, MAX_NAME_LENGTH), x, y);
}

function drawBall(ball, index, v) {
  const trail = ballTrails.get(index) || [];
  trail.push({ x: ball.x, y: ball.y });
  while (trail.length > 10) trail.shift();
  ballTrails.set(index, trail);
  const color = ball.strong ? "#ff4d6d" : "#62c8ff";

  trail.forEach((point, trailIndex) => {
    const alpha = trailIndex / trail.length;
    ctx.globalAlpha = alpha * (ball.strong ? 0.75 : 0.45);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(sx(point.x, v), sy(point.y, v), sr(ball.r * alpha, v), 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;

  ctx.fillStyle = ball.strong ? "#fff1f4" : "#f8fbff";
  ctx.beginPath();
  ctx.arc(sx(ball.x, v), sy(ball.y, v), sr(ball.r, v), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = ball.strong ? 4 + Math.max(1, ball.strongWallsLeft || 1) : 2;
  ctx.stroke();
}

function drawItem(item, v) {
  const x = sx(item.x, v);
  const y = sy(item.y, v);
  const r = sr(item.r, v);
  const itemColor = item.type === "wide" ? "rgba(53, 216, 135, 0.9)" : item.type === "strong" ? "rgba(255, 77, 109, 0.9)" : "rgba(98, 200, 255, 0.92)";
  const itemLabel = item.type === "wide" ? "W" : item.type === "strong" ? "S" : "G";
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = itemColor;
  ctx.strokeStyle = "#f8fbff";
  ctx.lineWidth = 2;
  ctx.fillRect(-r, -r, r * 2, r * 2);
  ctx.strokeRect(-r, -r, r * 2, r * 2);
  ctx.restore();
  ctx.fillStyle = "#07100d";
  ctx.font = `900 ${Math.max(12, r * 0.95)}px system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(itemLabel, x, y);
}

function drawGameSet(v) {
  if (!snapshot?.gameOver) return;
  const color = snapshot.winner === 0 ? "#35d887" : "#ffbf42";
  const team = snapshot.winner === 0 ? "A" : "B";
  const ready = snapshot.replayReady || 0;
  const total = snapshot.replayTotal || 0;
  ctx.fillStyle = "rgba(4, 8, 12, 0.66)";
  ctx.fillRect(v.x, v.y, v.w, v.h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.strokeRect(v.x + v.w * 0.11, v.y + v.h * 0.37, v.w * 0.78, v.h * 0.2);
  ctx.fillStyle = color;
  ctx.font = `800 ${Math.max(24, v.w * 0.12)}px system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("GAME SET", v.x + v.w / 2, v.y + v.h * 0.45);
  ctx.fillStyle = "#f8fbff";
  ctx.font = `700 ${Math.max(16, v.w * 0.055)}px system-ui`;
  ctx.fillText(`Team ${team} Win`, v.x + v.w / 2, v.y + v.h * 0.52);

  ctx.font = `700 ${Math.max(13, v.w * 0.04)}px system-ui`;
  ctx.fillStyle = "rgba(248,251,255,0.9)";
  ctx.fillText(`Replay Ready ${ready}/${total}`, v.x + v.w / 2, v.y + v.h * 0.59);
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
  if (event.kind === "score") effects.push({ kind: "flash", x: event.x, y: event.y, color, life: 0.8, maxLife: 0.8, radius: 190 });
  if (event.kind === "addBall") effects.push({ kind: "ring", x: event.x, y: event.y, color: "#62c8ff", life: 0.7, maxLife: 0.7, radius: 160, width: 5 });
  if (event.kind === "item") effects.push({ kind: "ring", x: event.x, y: event.y, color: itemEffectColor(event.itemType), life: 0.7, maxLife: 0.7, radius: 120, width: 4 });
  if (event.kind === "itemGet") {
    const itemColor = itemEffectColor(event.itemType);
    effects.push({ kind: event.itemType === "wide" ? "widePulse" : event.itemType === "goal" ? "goalShield" : "strongBurst", x: event.x, y: event.y, color: itemColor, team: event.team, life: 0.75, maxLife: 0.75, radius: event.itemType === "goal" ? 190 : 140, width: 5 });
    effects.push({ kind: "flash", x: event.x, y: event.y, color: itemColor, life: 0.45, maxLife: 0.45, radius: 120 });
  }
  if (event.kind === "hit" || event.kind === "power" || event.kind === "blast") {
    const strong = event.kind !== "hit";
    effects.push({ kind: "ring", x: event.x, y: event.y, color, life: strong ? 0.5 : 0.3, maxLife: strong ? 0.5 : 0.3, radius: strong ? 120 : 62, width: strong ? 5 : 3 });
    const count = strong ? 24 : 12;
    for (let i = 0; i < count; i += 1) {
      const angle = Math.PI * 2 * (i / count) + (Math.random() - 0.5) * 0.35;
      const speed = strong ? 260 : 140;
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

function itemEffectColor(type) {
  if (type === "wide") return "#35d887";
  if (type === "strong") return "#ff4d6d";
  return "#62c8ff";
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
    } else if (effect.kind === "widePulse") {
      ctx.strokeStyle = effect.color;
      ctx.lineWidth = effect.width;
      ctx.beginPath();
      ctx.ellipse(sx(effect.x, v), sy(effect.y, v), sr(effect.radius * (0.7 + progress), v), sr(effect.radius * (0.28 + progress * 0.25), v), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (effect.kind === "strongBurst") {
      ctx.strokeStyle = effect.color;
      ctx.lineWidth = effect.width;
      for (let i = 0; i < 12; i += 1) {
        const angle = (Math.PI * 2 * i) / 12;
        ctx.beginPath();
        ctx.moveTo(sx(effect.x, v), sy(effect.y, v));
        ctx.lineTo(sx(effect.x + Math.cos(angle) * effect.radius * (0.45 + progress), v), sy(effect.y + Math.sin(angle) * effect.radius * (0.45 + progress), v));
        ctx.stroke();
      }
    } else if (effect.kind === "goalShield") {
      const goalY = effect.team === 0 ? ARENA.height : 0;
      const y = sy(goalY, v);
      const half = v.w * (0.18 + progress * 0.08);
      ctx.strokeStyle = effect.color;
      ctx.lineWidth = effect.width + 6 * (1 - progress);
      ctx.beginPath();
      ctx.moveTo(v.x + v.w / 2 - half, y);
      ctx.lineTo(v.x + v.w / 2 + half, y);
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
  const blend = touchOrigin ? 0.96 : 0.8;
  input.x += (targetInput.x - input.x) * blend;
  input.y += (targetInput.y - input.y) * blend;
  if (Math.abs(input.x) < 0.015) input.x = 0;
  if (Math.abs(input.y) < 0.015) input.y = 0;
  input.boost = keys.has("Space") || input.boost;
  if (joined && snapshot?.started) send({ type: "input", input: inputForServer() });
}

function setTouchInput(clientX, clientY) {
  let dx = clientX - touchOrigin.x;
  let dy = clientY - touchOrigin.y;
  const rawLength = Math.hypot(dx, dy);
  if (rawLength > joystickMaxDistance) {
    const excess = rawLength - joystickMaxDistance;
    const nx = dx / rawLength;
    const ny = dy / rawLength;
    touchOrigin.x += nx * excess;
    touchOrigin.y += ny * excess;
    touchPad.style.left = `${touchOrigin.x}px`;
    touchPad.style.top = `${touchOrigin.y}px`;
    dx = clientX - touchOrigin.x;
    dy = clientY - touchOrigin.y;
  }
  const adjustedLength = Math.hypot(dx, dy);
  const length = Math.min(joystickMaxDistance, Math.max(0, adjustedLength - joystickDeadZone));
  const angle = Math.atan2(dy, dx);
  const amount = Math.pow(length / joystickMaxDistance, 0.62);
  targetInput.x = Math.cos(angle) * amount;
  targetInput.y = Math.sin(angle) * amount;
  const stickDistance = Math.min(joystickMaxDistance, adjustedLength);
  const stickX = Math.cos(angle) * stickDistance;
  const stickY = Math.sin(angle) * stickDistance;
  stick.style.transform = `translate(calc(-50% + ${stickX}px), calc(-50% + ${stickY}px))`;
}

function clearTouchInput() {
  touchOrigin = null;
  touchId = null;
  targetInput.x = 0;
  targetInput.y = 0;
  input.x *= 0.25;
  input.y *= 0.25;
  touchPad.classList.remove("active");
  stick.style.transform = "translate(-50%, -50%)";
}

function setCpu(team, value) {
  const totalHumans = snapshot ? snapshot.players.filter((player) => !player.cpu).length : 0;
  const maxCpu = Math.max(0, MAX_PLAYERS - totalHumans);
  const inputEl = team === 0 ? cpuAInput : cpuBInput;
  const otherEl = team === 0 ? cpuBInput : cpuAInput;
  const next = Math.max(0, Math.min(6, Number(value) || 0));
  inputEl.value = next;
  if (Number(inputEl.value) + Number(otherEl.value) > maxCpu) {
    otherEl.value = Math.max(0, maxCpu - Number(inputEl.value));
  }
  sendConfig();
}

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(roomUrlInput.value);
  copyButton.textContent = "コピー済み";
  setTimeout(() => { copyButton.textContent = "コピー"; }, 1000);
});

teamAButton.addEventListener("click", () => {
  selectedTeam = 0;
  updateTeamButtons();
});
teamBButton.addEventListener("click", () => {
  selectedTeam = 1;
  updateTeamButtons();
});
nameInput.addEventListener("input", () => {
  if (nameInput.value.length > MAX_NAME_LENGTH) nameInput.value = nameInput.value.slice(0, MAX_NAME_LENGTH);
});
winScoreInput.addEventListener("change", commitWinScore);
winScoreInput.addEventListener("input", sendConfig);
winScoreInput.addEventListener("blur", commitWinScore);
cpuAMinus.addEventListener("click", () => setCpu(0, Number(cpuAInput.value) - 1));
cpuAPlus.addEventListener("click", () => setCpu(0, Number(cpuAInput.value) + 1));
cpuBMinus.addEventListener("click", () => setCpu(1, Number(cpuBInput.value) - 1));
cpuBPlus.addEventListener("click", () => setCpu(1, Number(cpuBInput.value) + 1));
cpuAInput.addEventListener("input", () => setCpu(0, cpuAInput.value));
cpuBInput.addEventListener("input", () => setCpu(1, cpuBInput.value));
joinButton.addEventListener("click", joinRoom);
startButton.addEventListener("click", startGame);
bindActionButton(replayButton, startGame);
bindActionButton(rulesButton, openRuleSettings);
leaveButton.addEventListener("click", () => location.href = location.pathname);

function setBoost(active) {
  input.boost = active;
  boostButton.classList.toggle("active", active);
  boostButton.textContent = active ? "加速中" : "加速";
  send({ type: "input", input: inputForServer() });
}

boostButton.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  try {
    boostButton.setPointerCapture(event.pointerId);
  } catch {
    // Some mobile browsers refuse capture on form controls; window listeners cover release.
  }
  setBoost(true);
});
boostButton.addEventListener("pointerup", (event) => {
  event.preventDefault();
  event.stopPropagation();
  setBoost(false);
});
boostButton.addEventListener("pointercancel", () => setBoost(false));
boostButton.addEventListener("touchend", (event) => {
  event.preventDefault();
  event.stopPropagation();
  setBoost(false);
}, { passive: false });
boostButton.addEventListener("touchcancel", () => setBoost(false));
window.addEventListener("pointerup", () => {
  if (input.boost && !keys.has("Space")) setBoost(false);
});
window.addEventListener("touchend", () => {
  if (input.boost && !keys.has("Space")) setBoost(false);
});
window.addEventListener("blur", () => {
  keys.delete("Space");
  setBoost(false);
});

function beginJoystick(clientX, clientY, id = "touch") {
  touchId = id;
  touchOrigin = { x: clientX, y: clientY };
  touchPad.style.left = `${clientX}px`;
  touchPad.style.top = `${clientY}px`;
  touchPad.classList.add("active");
  setTouchInput(clientX, clientY);
}

function startJoystick(event) {
  if (!joined || !snapshot?.started || event.target.closest("button")) return;
  event.preventDefault();
  beginJoystick(event.clientX, event.clientY, event.pointerId);
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // Window listeners keep input alive when capture is refused by a mobile browser.
  }
}

function moveJoystick(event) {
  if (event.pointerId !== touchId || !touchOrigin) return;
  event.preventDefault();
  setTouchInput(event.clientX, event.clientY);
}

function startTouchJoystick(event) {
  if (!joined || !snapshot?.started || event.target.closest("button") || event.touches.length === 0) return;
  event.preventDefault();
  const touch = event.changedTouches[0];
  beginJoystick(touch.clientX, touch.clientY, touch.identifier);
}

function moveTouchJoystick(event) {
  if (!touchOrigin) return;
  const touch = [...event.changedTouches].find((item) => item.identifier === touchId);
  if (!touch) return;
  event.preventDefault();
  setTouchInput(touch.clientX, touch.clientY);
}

function endTouchJoystick(event) {
  const touch = [...event.changedTouches].find((item) => item.identifier === touchId);
  if (touch) clearTouchInput();
}

game.addEventListener("pointerdown", startJoystick);
window.addEventListener("pointermove", moveJoystick, { passive: false });
window.addEventListener("pointerup", clearTouchInput);
window.addEventListener("pointercancel", clearTouchInput);
game.addEventListener("touchstart", startTouchJoystick, { passive: false });
window.addEventListener("touchmove", moveTouchJoystick, { passive: false });
window.addEventListener("touchend", endTouchJoystick);
window.addEventListener("touchcancel", endTouchJoystick);

window.addEventListener("keydown", (event) => {
  keys.add(event.code);
  if (event.code === "Space") {
    event.preventDefault();
    setBoost(true);
  }
});

window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
  if (event.code === "Space") setBoost(false);
});

window.addEventListener("resize", resize);

initRoom();
updateTeamButtons();
resize();
connect();
setInterval(updateKeyboardInput, 1000 / 60);
requestAnimationFrame(draw);
