"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = __dirname;
const port = Number(process.env.PORT || 8080);
const MAX_PLAYERS = 6;
const playerMaxSpeed = 640;
const playerAcceleration = 5600;
const playerFriction = 0.68;
const CPU_BASE_SPEED = 660;
const BALL_START_SPEED = 360;
const BALL_MIN_SPEED = 360;
const BALL_MAX_SPEED = 980;
const DEFAULT_WIN_SCORE = 20;
const ITEM_SPEED = 260;
const ITEM_RADIUS = 20;
const BALL_REWARD_INTERVAL = 72;
const ITEM_REWARD_INTERVAL = 9;
const GOAL_HALF_WIDTH = 220;
const NARROW_GOAL_HALF_WIDTH = 130;
const GOAL_SHIELD_DURATION = 10;
const SPAWN_ZONE = { minX: 180, maxX: 620, y: 600 };
const rooms = new Map();
const sockets = new Map();
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://localhost:${port}`);
  const safePath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(root, safePath));

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": types[path.extname(filePath)] || "application/octet-stream" });
    response.end(data);
  });
});

server.on("upgrade", (request, socket) => {
  if (request.url !== "/ws") {
    socket.destroy();
    return;
  }
  const key = request.headers["sec-websocket-key"];
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));
  socket.on("data", (buffer) => handleSocketData(socket, buffer));
  socket.on("close", () => removeSocket(socket));
  socket.on("error", () => removeSocket(socket));
});

function send(socket, data) {
  if (socket.destroyed) return;
  const payload = Buffer.from(JSON.stringify(data));
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function handleSocketData(socket, buffer) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f;
    let length = buffer[offset + 1] & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    }
    if (length === 127) return;
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    const mask = masked ? buffer.slice(cursor, cursor + 4) : null;
    cursor += masked ? 4 : 0;
    if (cursor + length > buffer.length) return;
    const payload = buffer.slice(cursor, cursor + length);
    offset = cursor + length;
    if (opcode === 8) {
      removeSocket(socket);
      socket.end();
      return;
    }
    if (opcode !== 1) continue;
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    try {
      handleMessage(socket, JSON.parse(payload.toString("utf8")));
    } catch {
      send(socket, { type: "error", message: "Bad message" });
    }
  }
}

function handleMessage(socket, message) {
  if (message.type === "join") {
    joinRoom(
      socket,
      String(message.room || "main"),
      String(message.name || "Player").slice(0, 12),
      Number(message.team) === 1 ? 1 : 0,
    );
  }
  if (message.type === "setConfig" || message.type === "setCpu") {
    const roomId = String(message.room || sockets.get(socket)?.room.id || "main");
    const room = getRoom(roomId);
    if (!room.started) {
      room.winScore = clamp(Math.floor(Number(message.winScore) || room.winScore), 1, 99);
      const cpuA = message.cpuA ?? message.cpuCountA ?? message.cpuCount ?? room.cpuTargets[0];
      const cpuB = message.cpuB ?? message.cpuCountB ?? room.cpuTargets[1];
      setCpuCounts(room, Number(cpuA) || 0, Number(cpuB) || 0);
    }
    broadcast(room);
  }
  if (message.type === "start") {
    const meta = sockets.get(socket);
    const room = meta?.room || getRoom(String(message.room || "main"));
    if (room.gameOver && meta?.id) {
      room.replayReady.add(meta.id);
      if (allHumansReady(room)) startGame(room);
    } else if (!room.started && room.players.length >= 2) {
      startGame(room);
    }
    broadcast(room);
  }
  if (message.type === "configure") {
    const meta = sockets.get(socket);
    if (!meta) return;
    returnToConfig(meta.room);
    broadcast(meta.room);
  }
  if (message.type === "input") {
    const meta = sockets.get(socket);
    if (!meta) return;
    const player = meta.room.players.find((item) => item.id === meta.id);
    if (!player) return;
    player.input.x = clamp(Number(message.input?.x) || 0, -1, 1);
    player.input.y = clamp(Number(message.input?.y) || 0, -1, 1);
    player.input.power = Boolean(message.input?.power);
  }
}

function joinRoom(socket, roomId, name, team) {
  removeSocket(socket);
  const id = crypto.randomBytes(4).toString("hex");
  const room = getRoom(roomId);
  if (room.started) {
    send(socket, { type: "started" });
    return;
  }
  if (room.players.length >= MAX_PLAYERS) {
    const cpu = room.players.find((player) => player.cpu);
    if (cpu) {
      room.players = room.players.filter((player) => player !== cpu);
    }
  }
  if (room.players.length >= MAX_PLAYERS) {
    send(socket, { type: "full" });
    return;
  }
  const player = {
    id,
    name,
    team,
    x: 400,
    y: team === 0 ? 960 : 240,
    r: 34,
    cpu: false,
    cooldown: 0,
    powerWindow: 0,
    vx: 0,
    vy: 0,
    input: { x: 0, y: 0, power: false },
    wideTimer: 0,
    strongTimer: 0,
    wideStacks: [],
    strongStacks: [],
  };
  room.players.push(player);
  trimCpuToLimit(room);
  sockets.set(socket, { room, id });
  placePlayers(room);
  send(socket, { type: "joined", id, room: room.id });
  broadcast(room);
}

function removeSocket(socket) {
  const meta = sockets.get(socket);
  if (!meta) return;
  sockets.delete(socket);
  meta.room.players = meta.room.players.filter((player) => player.id !== meta.id);
  meta.room.replayReady.delete(meta.id);
  trimCpuToLimit(meta.room);
  placePlayers(meta.room);
  broadcast(meta.room);
}

function getRoom(id) {
  const roomId = id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "main";
  if (rooms.has(roomId)) return rooms.get(roomId);
  const room = {
    id: roomId,
    players: [],
    balls: [makeBall(BALL_START_SPEED)],
    items: [],
    scores: [0, 0],
    goalTimers: [0, 0],
    goalStacks: [[], []],
    rally: 0,
    ballRewardTimer: 0,
    itemRewardTimer: 0,
    maxBalls: 4,
    cpuTargets: [0, 0],
    winScore: DEFAULT_WIN_SCORE,
    started: false,
    events: [],
    eventSeq: 0,
    gameOver: false,
    winner: null,
    replayReady: new Set(),
  };
  rooms.set(roomId, room);
  return room;
}

function countHumans(room) {
  return room.players.filter((player) => !player.cpu).length;
}

function setCpuCounts(room, requestedA, requestedB) {
  const humans = countHumans(room);
  let available = Math.max(0, MAX_PLAYERS - humans);
  const next = [Math.max(0, Math.floor(requestedA)), Math.max(0, Math.floor(requestedB))];
  if (next[0] + next[1] > available) {
    const overflow = next[0] + next[1] - available;
    next[1] = Math.max(0, next[1] - overflow);
    if (next[0] + next[1] > available) next[0] = available;
  }
  room.cpuTargets = next;

  [0, 1].forEach((team) => {
    let cpus = room.players.filter((player) => player.cpu && player.team === team);
    while (cpus.length > room.cpuTargets[team]) {
      const removed = cpus.pop();
      room.players = room.players.filter((player) => player !== removed);
    }
    while (cpus.length < room.cpuTargets[team] && room.players.length < MAX_PLAYERS) {
      const cpu = makeCpu(team, cpus.length + 1);
      room.players.push(cpu);
      cpus.push(cpu);
    }
  });
  placePlayers(room);
}

function trimCpuToLimit(room) {
  const allowed = Math.max(0, MAX_PLAYERS - countHumans(room));
  while (room.players.filter((player) => player.cpu).length > allowed) {
    const cpu = room.players.findLast?.((player) => player.cpu) || [...room.players].reverse().find((player) => player.cpu);
    if (!cpu) break;
    room.players = room.players.filter((player) => player !== cpu);
    room.cpuTargets[cpu.team] = Math.max(0, room.cpuTargets[cpu.team] - 1);
  }
}

function makeCpu(team, index) {
  return {
    id: `cpu-${crypto.randomBytes(3).toString("hex")}`,
    name: `CPU${team === 0 ? "A" : "B"}${index}`,
    team,
    x: 400,
    y: team === 0 ? 960 : 240,
    r: 34,
    cpu: true,
    cooldown: 0,
    powerWindow: 0,
    vx: 0,
    vy: 0,
    input: { x: 0, y: 0, power: false },
    wideTimer: 0,
    strongTimer: 0,
    wideStacks: [],
    strongStacks: [],
    aiTimer: 0,
    aiTarget: null,
    aiBias: Math.random() * 120 - 60,
    aiLane: Math.random(),
    aiPhase: Math.random() * Math.PI * 2,
    aiBallOffset: Math.floor(Math.random() * 3),
    aiItemInterest: 0.55 + Math.random() * 0.3,
    aiItemCooldown: 0,
    aiDepthBias: Math.random() * 140 - 70,
    aiSpeed: CPU_BASE_SPEED + Math.random() * 180,
  };
}

function makeBall(speed) {
  const launchSpeed = speed || BALL_START_SPEED;
  const angle = Math.random() * Math.PI * 2;
  const spawnX = SPAWN_ZONE.minX + Math.random() * (SPAWN_ZONE.maxX - SPAWN_ZONE.minX);
  return {
    x: spawnX,
    y: SPAWN_ZONE.y,
    vx: Math.cos(angle) * launchSpeed,
    vy: Math.sin(angle) * launchSpeed,
    r: 18,
    lastHitPlayer: "",
    lastHitTimer: 0,
    strongTimer: 0,
    strongWallsLeft: 0,
    strongOwner: "",
    strongTeam: null,
  };
}

function resetBall(ball, speed) {
  const fresh = makeBall(speed);
  Object.assign(ball, fresh);
}

function startGame(room) {
  room.started = true;
  room.gameOver = false;
  room.winner = null;
  room.replayReady.clear();
  room.scores = [0, 0];
  room.goalTimers = [0, 0];
  room.goalStacks = [[], []];
  room.rally = 0;
  room.ballRewardTimer = 0;
  room.itemRewardTimer = 0;
  room.balls = [makeBall(BALL_START_SPEED)];
  room.items = [];
  room.events = [];
  room.eventSeq = 0;
  room.players.forEach((player) => {
    player.cooldown = 0;
    player.powerWindow = 0;
    player.wideTimer = 0;
    player.strongTimer = 0;
    player.wideStacks = [];
    player.strongStacks = [];
    player.vx = 0;
    player.vy = 0;
    player.input = { x: 0, y: 0, power: false };
    player.hasPlaced = false;
  });
  placePlayers(room);
}

function returnToConfig(room) {
  room.started = false;
  room.gameOver = false;
  room.winner = null;
  room.replayReady.clear();
  room.scores = [0, 0];
  room.goalTimers = [0, 0];
  room.goalStacks = [[], []];
  room.rally = 0;
  room.ballRewardTimer = 0;
  room.itemRewardTimer = 0;
  room.balls = [makeBall(BALL_START_SPEED)];
  room.items = [];
  room.events = [];
  room.eventSeq = 0;
  room.players.forEach((player) => {
    player.cooldown = 0;
    player.powerWindow = 0;
    player.wideTimer = 0;
    player.strongTimer = 0;
    player.wideStacks = [];
    player.strongStacks = [];
    player.vx = 0;
    player.vy = 0;
    player.input = { x: 0, y: 0, power: false };
    player.hasPlaced = false;
  });
  placePlayers(room);
}

function allHumansReady(room) {
  const humans = room.players.filter((player) => !player.cpu);
  return humans.length > 0 && humans.every((player) => room.replayReady.has(player.id));
}

function placePlayers(room) {
  [0, 1].forEach((team) => {
    const mates = room.players.filter((player) => player.team === team);
    mates.forEach((player, index) => {
      const slot = (index + 1) / (mates.length + 1);
      if (player.cpu) player.aiLane = slot;
      player.x = clamp(player.x || 400, 40, 760);
      player.y = clamp(player.y || (team === 0 ? 960 : 240), team === 0 ? 640 : 40, team === 0 ? 1160 : 560);
      if (!player.hasPlaced) {
        player.x = 800 * slot;
        player.y = team === 0 ? 980 : 220;
        player.hasPlaced = true;
      }
    });
  });
}

function tickRoom(room, dt) {
  if (!room.started || room.gameOver) return;
  room.goalStacks[0] = tickStack(room.goalStacks[0], dt);
  room.goalStacks[1] = tickStack(room.goalStacks[1], dt);
  room.goalTimers[0] = maxStackTime(room.goalStacks[0]);
  room.goalTimers[1] = maxStackTime(room.goalStacks[1]);
  room.ballRewardTimer += dt;
  room.itemRewardTimer += dt;
  if (room.itemRewardTimer >= ITEM_REWARD_INTERVAL) {
    room.itemRewardTimer -= ITEM_REWARD_INTERVAL;
    triggerTimedItem(room);
  }
  if (room.ballRewardTimer >= BALL_REWARD_INTERVAL) {
    room.ballRewardTimer -= BALL_REWARD_INTERVAL;
    triggerTimedBall(room);
  }
  room.players.filter((player) => player.cpu).forEach((player) => updateCpu(room, player, dt));
  room.players.forEach((player) => {
    if (player.input.power && player.cooldown <= 0) {
      player.powerWindow = 0.28;
      player.cooldown = 1.8;
    }
    player.input.power = false;
    player.cooldown = Math.max(0, player.cooldown - dt);
    player.powerWindow = Math.max(0, player.powerWindow - dt);
    player.wideStacks = tickStack(player.wideStacks, dt);
    player.strongStacks = tickStack(player.strongStacks, dt);
    player.wideTimer = maxStackTime(player.wideStacks);
    player.strongTimer = maxStackTime(player.strongStacks);
    const maxSpeed = player.cpu ? player.aiSpeed : playerMaxSpeed;
    const desiredVx = player.input.x * maxSpeed;
    const desiredVy = player.input.y * maxSpeed;
    const inputAmount = Math.hypot(player.input.x, player.input.y);
    if (inputAmount > 0.02) {
      player.vx = approach(player.vx || 0, desiredVx, playerAcceleration * dt);
      player.vy = approach(player.vy || 0, desiredVy, playerAcceleration * dt);
    } else {
      const friction = Math.pow(playerFriction, dt * 60);
      player.vx = (player.vx || 0) * friction;
      player.vy = (player.vy || 0) * friction;
      if (Math.abs(player.vx) < 2) player.vx = 0;
      if (Math.abs(player.vy) < 2) player.vy = 0;
    }
    player.x += player.vx * dt;
    player.y += player.vy * dt;
    const radius = playerRadius(player);
    player.x = clamp(player.x, radius, 800 - radius);
    player.y = clamp(player.y, player.team === 0 ? 600 + radius : radius, player.team === 0 ? 1200 - radius : 600 - radius);
  });

  room.balls.forEach((ball) => {
    ball.lastHitTimer = Math.max(0, ball.lastHitTimer - dt);
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    collideWalls(room, ball);
    room.players.forEach((player) => collidePaddle(room, ball, player));
    capSpeed(ball);
  });
  room.items.forEach((item) => {
    item.x += item.vx * dt;
    item.y += item.vy * dt;
    collideItemWalls(item);
    room.players.forEach((player) => collectItem(room, item, player));
  });
  room.items = room.items.filter((item) => !item.collected);
  collideBalls(room);
}

function updateCpu(room, player, dt) {
  player.aiTimer -= dt;
  player.aiItemCooldown = Math.max(0, (player.aiItemCooldown || 0) - dt);
  if (player.aiTimer <= 0 || !player.aiTarget) {
    const item = nearestItemForPlayer(room, player);
    if (item) {
      player.aiTarget = {
        x: clamp(item.x + player.aiBias * 0.35, player.r, 800 - player.r),
        y: player.team === 0 ? 600 + player.r + 18 : 600 - player.r - 18,
      };
      player.aiTimer = 0.36 + Math.random() * 0.2;
    } else {
      const ball = nearestBallForTeam(room, player.team, player.aiBallOffset || 0);
      const homeY = player.team === 0 ? 980 : 220;
      const pressure = player.team === 0 ? clamp((ball.y - 600) / 600, 0, 1) : clamp((600 - ball.y) / 600, 0, 1);
      const laneX = 120 + (player.aiLane || 0.5) * 560;
      const weave = Math.sin(Date.now() / 520 + player.aiPhase) * 34;
      const verticalWeave = Math.sin(Date.now() / 760 + player.aiPhase * 1.7) * 55;
      const chaseWeight = 0.42 + pressure * 0.45;
      const guardDepth = (player.aiDepthBias || 0) + verticalWeave * (0.35 + pressure * 0.65);
      player.aiTarget = {
        x: clamp(laneX * (1 - chaseWeight) + (ball.x + player.aiBias + weave) * chaseWeight, player.r, 800 - player.r),
        y: clamp(homeY + (ball.y - homeY) * pressure * 0.7 + guardDepth, player.team === 0 ? 600 + player.r : player.r, player.team === 0 ? 1200 - player.r : 600 - player.r),
      };
      player.aiTimer = 0.05 + Math.random() * 0.06;
    }
  }
  const dx = player.aiTarget.x - player.x;
  const dy = player.aiTarget.y - player.y;
  const distance = Math.hypot(dx, dy) || 1;
  player.input.x = clamp((dx / distance) * Math.min(1, distance / 80), -1, 1);
  player.input.y = clamp((dy / distance) * Math.min(1, distance / 80), -1, 1);
  const incoming = room.balls.some((ball) => Math.hypot(ball.x - player.x, ball.y - player.y) < 150);
  player.input.power = incoming && player.cooldown <= 0 && Math.random() < 0.18;
}

function nearestItemForPlayer(room, player) {
  if (room.items.length === 0) return null;
  if ((player.aiItemCooldown || 0) > 0) return null;
  let best = null;
  let bestDistance = Infinity;
  room.items.forEach((item) => {
    const targetY = player.team === 0 ? 600 + player.r : 600 - player.r;
    const distance = Math.hypot(item.x - player.x, targetY - player.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = item;
    }
  });
  if (bestDistance > 560) return null;
  const closeBonus = bestDistance < 260 ? 0.22 : 0;
  if (Math.random() > Math.min(0.92, (player.aiItemInterest || 0.55) + closeBonus)) return null;
  return best;
}

function nearestBallForTeam(room, team, offset) {
  const sorted = [...room.balls].sort((a, b) => {
    const da = team === 0 ? Math.abs(1200 - a.y) : Math.abs(a.y);
    const db = team === 0 ? Math.abs(1200 - b.y) : Math.abs(b.y);
    return da - db;
  });
  return sorted[offset % Math.max(1, sorted.length)] || room.balls[0];
}

function nearestBallDistance(room, team) {
  let bestDistance = Infinity;
  room.balls.forEach((ball) => {
    const distance = team === 0 ? Math.abs(1200 - ball.y) : Math.abs(ball.y);
    if (distance < bestDistance) {
      bestDistance = distance;
    }
  });
  return bestDistance;
}

function collideWalls(room, ball) {
  if (ball.x - ball.r < 0) {
    ball.x = ball.r;
    ball.vx = Math.abs(ball.vx);
    countStrongWallHit(ball);
  }
  if (ball.x + ball.r > 800) {
    ball.x = 800 - ball.r;
    ball.vx = -Math.abs(ball.vx);
    countStrongWallHit(ball);
  }
  if (ball.y - ball.r < 0) {
    if (isInGoal(room, 1, ball.x)) return score(room, 1, ball);
    ball.y = ball.r;
    ball.vy = Math.abs(ball.vy);
    countStrongWallHit(ball);
  }
  if (ball.y + ball.r > 1200) {
    if (isInGoal(room, 0, ball.x)) return score(room, 0, ball);
    ball.y = 1200 - ball.r;
    ball.vy = -Math.abs(ball.vy);
    countStrongWallHit(ball);
  }
}

function isInGoal(room, defendingTeam, x) {
  return Math.abs(x - 400) < goalHalfWidth(room, defendingTeam);
}

function goalHalfWidth(room, team) {
  const stacks = stackCount(room.goalStacks?.[team]);
  if (stacks <= 0) return GOAL_HALF_WIDTH;
  return Math.max(70, NARROW_GOAL_HALF_WIDTH - (stacks - 1) * 30);
}

function collidePaddle(room, ball, player) {
  const dx = ball.x - player.x;
  const dy = ball.y - player.y;
  const distance = Math.hypot(dx, dy) || 1;
  const radius = playerRadius(player);
  const min = ball.r + radius;
  if (distance > min) return;
  const nx = dx / distance;
  const ny = dy / distance;
  ball.x = player.x + nx * min;
  ball.y = player.y + ny * min;
  if (ball.strongTimer > 0 && ball.strongOwner !== player.id && ball.lastHitPlayer !== player.id) {
    const push = 1850;
    const lift = player.team === 0 ? 260 : -260;
    player.vx += nx * push;
    player.vy += ny * push + lift;
    player.x = clamp(player.x + nx * 96, radius, 800 - radius);
    player.y = clamp(player.y + ny * 96, player.team === 0 ? 600 + radius : radius, player.team === 0 ? 1200 - radius : 600 - radius);
    ball.lastHitPlayer = player.id;
    ball.lastHitTimer = 0.18;
    pushEvent(room, { kind: "blast", x: player.x, y: player.y, team: ball.strongTeam ?? player.team });
    return;
  }
  let speed = Math.max(BALL_MIN_SPEED, Math.hypot(ball.vx, ball.vy) + 24);
  let power = false;
  if (player.powerWindow > 0) {
    speed *= player.powerWindow > 0.16 ? 1.75 : 1.35;
    player.powerWindow = 0;
    power = true;
  }
  if (player.strongTimer > 0) {
    const stacks = stackCount(player.strongStacks);
    speed *= 1.35 + Math.min(2, Math.max(0, stacks - 1)) * 0.18;
    ball.strongTimer = 1;
    ball.strongWallsLeft = 2 + Math.min(2, Math.max(0, stacks - 1));
    ball.strongOwner = player.id;
    ball.strongTeam = player.team;
    ball.vx = nx * speed;
    ball.vy = ny * speed;
    power = true;
  } else {
    clearStrongBall(ball);
    ball.vx = nx * speed + player.input.x * 150;
    ball.vy = ny * speed + player.input.y * 150;
  }

  const isNewPlayerHit = ball.lastHitPlayer !== player.id || ball.lastHitTimer <= 0;
  ball.lastHitPlayer = player.id;
  ball.lastHitTimer = 0.16;
  if (isNewPlayerHit) {
    pushEvent(room, { kind: power ? "power" : "hit", x: ball.x, y: ball.y, team: player.team });
}
}

function score(room, defendingTeam, ball) {
  if (room.gameOver) return;
  const scoringTeam = defendingTeam === 0 ? 1 : 0;
  room.scores[scoringTeam] += 1;
  pushEvent(room, { kind: "score", x: ball.x, y: ball.y, team: scoringTeam });
  if (room.scores[scoringTeam] >= room.winScore) {
    room.gameOver = true;
    room.winner = scoringTeam;
    room.balls.forEach((item) => {
      item.vx = 0;
      item.vy = 0;
    });
    room.players.forEach((player) => {
      player.input.x = 0;
      player.input.y = 0;
      player.input.power = false;
      player.vx = 0;
      player.vy = 0;
    });
    pushEvent(room, { kind: "gameSet", x: 400, y: 600, team: scoringTeam });
    return;
  }
  resetBall(ball, BALL_START_SPEED);
}

function triggerTimedBall(room) {
  const team = Math.random() < 0.5 ? 0 : 1;
  if (room.balls.length >= room.maxBalls) return;
  const newBall = makeBall(BALL_START_SPEED + room.balls.length * 40);
  room.balls.push(newBall);
  pushEvent(room, { kind: "addBall", x: newBall.x, y: newBall.y, team });
}

function triggerTimedItem(room) {
  const team = Math.random() < 0.5 ? 0 : 1;
  if (room.items.length >= 6) return;
  const types = ["wide", "strong", "goal"];
  const type = types[Math.floor(Math.random() * types.length)];
  const item = makeItem(type);
  room.items.push(item);
  pushEvent(room, { kind: "item", itemType: type, x: item.x, y: item.y, team });
}

function makeItem(type) {
  const spawnX = SPAWN_ZONE.minX + Math.random() * (SPAWN_ZONE.maxX - SPAWN_ZONE.minX);
  const direction = Math.random() < 0.5 ? -1 : 1;
  return {
    id: crypto.randomBytes(3).toString("hex"),
    type,
    x: spawnX,
    y: SPAWN_ZONE.y,
    vx: direction * ITEM_SPEED,
    vy: 0,
    r: ITEM_RADIUS,
  };
}

function collideItemWalls(item) {
  if (item.x - item.r < 0) {
    item.x = item.r;
    item.vx = Math.abs(item.vx);
  }
  if (item.x + item.r > 800) {
    item.x = 800 - item.r;
    item.vx = -Math.abs(item.vx);
  }
  item.y = SPAWN_ZONE.y;
  item.vy = 0;
}

function collectItem(room, item, player) {
  if (item.collected) return;
  const distance = Math.hypot(item.x - player.x, item.y - player.y);
  if (distance > item.r + playerRadius(player)) return;
  item.collected = true;
  const mates = room.players.filter((mate) => mate.team === player.team);
  if (item.type === "wide") mates.forEach((mate) => mate.wideStacks.push(8));
  if (item.type === "strong") mates.forEach((mate) => mate.strongStacks.push(8));
  if (item.type === "goal") room.goalStacks[player.team].push(GOAL_SHIELD_DURATION);
  room.players.filter((mate) => mate.cpu && mate.team === player.team).forEach((mate) => {
    mate.aiItemCooldown = 1.2 + Math.random() * 0.8;
  });
  pushEvent(room, { kind: "itemGet", itemType: item.type, x: player.x, y: player.y, team: player.team });
}

function playerRadius(player) {
  const stacks = stackCount(player.wideStacks);
  return player.r * (1 + Math.min(3, stacks) * 0.45);
}

function tickStack(stack, dt) {
  return (stack || []).map((time) => time - dt).filter((time) => time > 0);
}

function maxStackTime(stack) {
  return Math.max(0, ...(stack || []));
}

function stackCount(stack) {
  return (stack || []).filter((time) => time > 0).length;
}

function clearStrongBall(ball) {
  ball.strongTimer = 0;
  ball.strongWallsLeft = 0;
  ball.strongOwner = "";
  ball.strongTeam = null;
}

function countStrongWallHit(ball) {
  if (ball.strongTimer <= 0) return;
  ball.strongWallsLeft = Math.max(0, (ball.strongWallsLeft || 0) - 1);
  if (ball.strongWallsLeft <= 0) clearStrongBall(ball);
}

function collideBalls(room) {
  for (let i = 0; i < room.balls.length; i += 1) {
    for (let j = i + 1; j < room.balls.length; j += 1) {
      const a = room.balls[i];
      const b = room.balls[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;
      const min = a.r + b.r;
      if (distance >= min) continue;
      const avx = a.vx;
      const avy = a.vy;
      a.vx = b.vx;
      a.vy = b.vy;
      b.vx = avx;
      b.vy = avy;
    }
  }
}

function capSpeed(ball) {
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed > BALL_MAX_SPEED) {
    ball.vx = (ball.vx / speed) * BALL_MAX_SPEED;
    ball.vy = (ball.vy / speed) * BALL_MAX_SPEED;
  }
}

function pushEvent(room, event) {
  room.eventSeq += 1;
  room.events.push({ ...event, seq: room.eventSeq });
  if (room.events.length > 24) room.events.shift();
}

function broadcast(room) {
  const state = {
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      team: player.team,
      x: Math.round(player.x),
      y: Math.round(player.y),
      r: Math.round(playerRadius(player)),
      cpu: Boolean(player.cpu),
      cooldown: player.cooldown,
      wideTimer: player.wideTimer || 0,
      strongTimer: player.strongTimer || 0,
      wideStacks: stackCount(player.wideStacks),
      strongStacks: stackCount(player.strongStacks),
      replayReady: room.replayReady.has(player.id),
    })),
    balls: room.balls.map((ball) => ({
      x: Math.round(ball.x),
      y: Math.round(ball.y),
      r: ball.r,
      strong: ball.strongTimer > 0,
      strongTeam: ball.strongTeam,
      strongWallsLeft: ball.strongWallsLeft || 0,
    })),
    items: room.items.map((item) => ({
      id: item.id,
      type: item.type,
      x: Math.round(item.x),
      y: Math.round(item.y),
      r: item.r,
    })),
    scores: room.scores,
    goalTimers: room.goalTimers,
    goalStacks: [stackCount(room.goalStacks[0]), stackCount(room.goalStacks[1])],
    goalHalfWidths: [goalHalfWidth(room, 0), goalHalfWidth(room, 1)],
    rally: Math.floor(room.rally),
    events: room.events,
    gameOver: room.gameOver,
    winner: room.winner,
    winScore: room.winScore,
    cpuTargets: room.cpuTargets,
    started: room.started,
    canStart: room.players.length >= 2 && !room.started,
    replayReady: room.replayReady.size,
    replayTotal: room.players.filter((player) => !player.cpu).length,
  };
  sockets.forEach((meta, socket) => {
    if (meta.room === room) send(socket, { type: "state", state });
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function approach(value, target, amount) {
  if (value < target) return Math.min(value + amount, target);
  if (value > target) return Math.max(value - amount, target);
  return target;
}

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.033, (now - last) / 1000);
  last = now;
  rooms.forEach((room) => {
    if (room.players.length > 0) {
      tickRoom(room, dt);
      broadcast(room);
    }
  });
}, 1000 / 60);

server.listen(port, () => {
  console.log(`Room Hockey running on http://localhost:${port}`);
});
