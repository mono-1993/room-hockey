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
    joinRoom(socket, String(message.room || "main"), String(message.name || "Player").slice(0, 12), Number(message.cpuCount) || 0);
  }
  if (message.type === "setCpu") {
    const roomId = String(message.room || sockets.get(socket)?.room.id || "main");
    const room = getRoom(roomId);
    setCpuCount(room, Number(message.cpuCount) || 0);
    broadcast(room);
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

function joinRoom(socket, roomId, name, cpuCount) {
  removeSocket(socket);
  const id = crypto.randomBytes(4).toString("hex");
  const room = getRoom(roomId);
  setCpuCount(room, cpuCount);
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
  const teamA = room.players.filter((player) => player.team === 0).length;
  const teamB = room.players.filter((player) => player.team === 1).length;
  const team = teamA <= teamB ? 0 : 1;
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
  };
  room.players.push(player);
  setCpuCount(room, Math.min(room.cpuTarget, MAX_PLAYERS - countHumans(room)));
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
  setCpuCount(meta.room, Math.min(meta.room.cpuTarget, MAX_PLAYERS - countHumans(meta.room)));
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
    scores: [0, 0],
    rally: 0,
    nextBallRally: 15,
    maxBalls: 4,
    cpuTarget: 0,
    events: [],
    eventSeq: 0,
  };
  rooms.set(roomId, room);
  return room;
}

function countHumans(room) {
  return room.players.filter((player) => !player.cpu).length;
}

function setCpuCount(room, requested) {
  const humans = countHumans(room);
  const target = clamp(Math.floor(requested), 0, Math.max(0, MAX_PLAYERS - humans));
  room.cpuTarget = target;
  let cpus = room.players.filter((player) => player.cpu);
  while (cpus.length > target) {
    const removed = cpus.pop();
    room.players = room.players.filter((player) => player !== removed);
  }
  while (cpus.length < target && room.players.length < MAX_PLAYERS) {
    const teamA = room.players.filter((player) => player.team === 0).length;
    const teamB = room.players.filter((player) => player.team === 1).length;
    const team = teamA <= teamB ? 0 : 1;
    const cpu = {
      id: `cpu-${crypto.randomBytes(3).toString("hex")}`,
      name: `CPU${cpus.length + 1}`,
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
      aiTimer: 0,
      aiTarget: null,
      aiBias: Math.random() * 180 - 90,
      aiSpeed: CPU_BASE_SPEED + Math.random() * 130,
    };
    room.players.push(cpu);
    cpus.push(cpu);
  }
  placePlayers(room);
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
  };
}

function resetBall(ball, speed) {
  const fresh = makeBall(speed);
  Object.assign(ball, fresh);
}

function placePlayers(room) {
  [0, 1].forEach((team) => {
    const mates = room.players.filter((player) => player.team === team);
    mates.forEach((player, index) => {
      const slot = (index + 1) / (mates.length + 1);
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
  room.players.filter((player) => player.cpu).forEach((player) => updateCpu(room, player, dt));
  room.players.forEach((player) => {
    if (player.input.power && player.cooldown <= 0) {
      player.powerWindow = 0.28;
      player.cooldown = 1.8;
    }
    player.input.power = false;
    player.cooldown = Math.max(0, player.cooldown - dt);
    player.powerWindow = Math.max(0, player.powerWindow - dt);
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
    player.x = clamp(player.x, player.r, 800 - player.r);
    player.y = clamp(player.y, player.team === 0 ? 600 + player.r : player.r, player.team === 0 ? 1200 - player.r : 600 - player.r);
  });

  room.balls.forEach((ball) => {
    ball.lastHitTimer = Math.max(0, ball.lastHitTimer - dt);
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    collideWalls(room, ball);
    room.players.forEach((player) => collidePaddle(room, ball, player));
    capSpeed(ball);
  });
  collideBalls(room);
}

function updateCpu(room, player, dt) {
  player.aiTimer -= dt;
  if (player.aiTimer <= 0 || !player.aiTarget) {
    const ball = nearestBallForTeam(room, player.team);
    const homeY = player.team === 0 ? 980 : 220;
    const pressure = player.team === 0 ? clamp((ball.y - 600) / 600, 0, 1) : clamp((600 - ball.y) / 600, 0, 1);
    player.aiTarget = {
      x: clamp(ball.x + player.aiBias, player.r, 800 - player.r),
      y: clamp(homeY + (ball.y - homeY) * pressure * 0.55, player.team === 0 ? 600 + player.r : player.r, player.team === 0 ? 1200 - player.r : 600 - player.r),
    };
    player.aiTimer = 0.08 + Math.random() * 0.08;
  }
  const dx = player.aiTarget.x - player.x;
  const dy = player.aiTarget.y - player.y;
  const distance = Math.hypot(dx, dy) || 1;
  player.input.x = clamp((dx / distance) * Math.min(1, distance / 80), -1, 1);
  player.input.y = clamp((dy / distance) * Math.min(1, distance / 80), -1, 1);
  const incoming = room.balls.some((ball) => Math.hypot(ball.x - player.x, ball.y - player.y) < 130);
  player.input.power = incoming && player.cooldown <= 0 && Math.random() < 0.12;
}

function nearestBallForTeam(room, team) {
  let best = room.balls[0];
  let bestDistance = Infinity;
  room.balls.forEach((ball) => {
    const distance = team === 0 ? Math.abs(1200 - ball.y) : Math.abs(ball.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = ball;
    }
  });
  return best;
}

function collideWalls(room, ball) {
  if (ball.x - ball.r < 0) {
    ball.x = ball.r;
    ball.vx = Math.abs(ball.vx);
  }
  if (ball.x + ball.r > 800) {
    ball.x = 800 - ball.r;
    ball.vx = -Math.abs(ball.vx);
  }
  const inGoal = Math.abs(ball.x - 400) < 220;
  if (ball.y - ball.r < 0) {
    if (inGoal) return score(room, 1, ball);
    ball.y = ball.r;
    ball.vy = Math.abs(ball.vy);
  }
  if (ball.y + ball.r > 1200) {
    if (inGoal) return score(room, 0, ball);
    ball.y = 1200 - ball.r;
    ball.vy = -Math.abs(ball.vy);
  }
}

function collidePaddle(room, ball, player) {
  const dx = ball.x - player.x;
  const dy = ball.y - player.y;
  const distance = Math.hypot(dx, dy) || 1;
  const min = ball.r + player.r;
  if (distance > min) return;
  const nx = dx / distance;
  const ny = dy / distance;
  ball.x = player.x + nx * min;
  ball.y = player.y + ny * min;
  let speed = Math.max(BALL_MIN_SPEED, Math.hypot(ball.vx, ball.vy) + 24);
  let power = false;
  if (player.powerWindow > 0) {
    speed *= player.powerWindow > 0.16 ? 1.75 : 1.35;
    player.powerWindow = 0;
    power = true;
  }
  ball.vx = nx * speed + player.input.x * 150;
  ball.vy = ny * speed + player.input.y * 150;

  const isNewPlayerHit = ball.lastHitPlayer !== player.id || ball.lastHitTimer <= 0;
  ball.lastHitPlayer = player.id;
  ball.lastHitTimer = 0.16;
  if (isNewPlayerHit) {
    pushEvent(room, { kind: power ? "power" : "hit", x: ball.x, y: ball.y, team: player.team });
    room.rally += 1 / Math.max(1, room.balls.length);
  if (room.rally >= room.nextBallRally && room.balls.length < room.maxBalls) {
    const newBall = makeBall(BALL_START_SPEED + room.balls.length * 40);
    room.balls.push(newBall);
    room.nextBallRally += 15;
    pushEvent(room, { kind: "addBall", x: newBall.x, y: newBall.y, team: player.team });
  }
}
}

function score(room, defendingTeam, ball) {
  const scoringTeam = defendingTeam === 0 ? 1 : 0;
  room.scores[scoringTeam] += 1;
  room.rally = 0;
  room.nextBallRally = 15;
  pushEvent(room, { kind: "score", x: ball.x, y: ball.y, team: scoringTeam });
  resetBall(ball, BALL_START_SPEED);
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
      r: player.r,
      cpu: Boolean(player.cpu),
      cooldown: player.cooldown,
    })),
    balls: room.balls.map((ball) => ({
      x: Math.round(ball.x),
      y: Math.round(ball.y),
      r: ball.r,
    })),
    scores: room.scores,
    rally: Math.floor(room.rally),
    events: room.events,
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
