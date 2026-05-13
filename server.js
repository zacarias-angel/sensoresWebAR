const path = require("path");
const http = require("http");
const os = require("os");
const express = require("express");
const { WebSocketServer } = require("ws");
const QRCode = require("qrcode");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/xr-standalone", express.static(path.join(__dirname, "xr-standalone")));

const rooms = new Map();

// Each room holds one PC display and up to 4 phone controllers
// phones is a fixed-length array of 4 slots; null = empty
function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < 6; i += 1) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.get("host") || "";
  const normalizedHost = host.toLowerCase();

  if (
    normalizedHost.startsWith("localhost") ||
    normalizedHost.startsWith("127.0.0.1") ||
    normalizedHost.startsWith("[::1]")
  ) {
    const network = Object.values(os.networkInterfaces())
      .flat()
      .find((iface) => iface && iface.family === "IPv4" && !iface.internal);

    if (network?.address) {
      return `${proto}://${network.address}:${PORT}`;
    }
  }

  return `${proto}://${host}`;
}

app.get("/phone", (req, res) => {
  const room = req.query.room ? `?room=${encodeURIComponent(req.query.room)}` : "";
  res.redirect(`/phone.html${room}`);
});

app.get("/api/create-session", async (req, res) => {
  let roomId = generateRoomId();
  while (rooms.has(roomId)) {
    roomId = generateRoomId();
  }

  rooms.set(roomId, {
    pc: null,
    phones: [null, null, null, null],
    createdAt: Date.now(),
  });

  const phoneUrl = `${getBaseUrl(req)}/phone.html?room=${roomId}`;
  const qrDataUrl = await QRCode.toDataURL(phoneUrl, {
    width: 260,
    margin: 1,
  });

  res.json({ roomId, phoneUrl, qrDataUrl });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function getRoomPlayers(room) {
  return room.phones.map((ws, slot) => ({
    slot,
    connected: ws !== null && ws.readyState === 1, // OPEN
  }));
}

function notifyRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const payload = {
    type: "room-status",
    roomId,
    pcConnected: Boolean(room.pc),
    players: getRoomPlayers(room),
  };

  safeSend(room.pc, payload);
  for (const ws of room.phones) safeSend(ws, payload);
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const hasClients = room.pc || room.phones.some(Boolean);
  if (!hasClients) rooms.delete(roomId);
}

wss.on("connection", (ws) => {
  ws.role = null;
  ws.roomId = null;
  ws.playerSlot = -1;

  ws.on("message", (rawMessage) => {
    let data;
    try {
      data = JSON.parse(rawMessage.toString());
    } catch (_err) {
      safeSend(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    if (data.type === "join") {
      const roomId = String(data.roomId || "").toUpperCase();
      const role = data.role;

      if (!roomId || !rooms.has(roomId)) {
        safeSend(ws, { type: "error", message: "Room not found" });
        return;
      }

      if (role !== "pc" && role !== "phone") {
        safeSend(ws, { type: "error", message: "Invalid role" });
        return;
      }

      const room = rooms.get(roomId);

      if (role === "pc") {
        if (room.pc && room.pc !== ws) room.pc.close();
        room.pc = ws;
        ws.role = "pc";
        ws.roomId = roomId;
        safeSend(ws, { type: "joined", roomId, role: "pc" });
        notifyRoom(roomId);
        return;
      }

      if (role === "phone") {
        const freeSlot = room.phones.findIndex((p) => p === null);
        if (freeSlot === -1) {
          safeSend(ws, { type: "error", message: "Sala llena (max 4 jugadores)" });
          return;
        }
        room.phones[freeSlot] = ws;
        ws.role = "phone";
        ws.roomId = roomId;
        ws.playerSlot = freeSlot;
        safeSend(ws, { type: "joined", roomId, role: "phone", playerSlot: freeSlot });
        notifyRoom(roomId);
        return;
      }
    }

    if (data.type === "input") {
      const roomId = ws.roomId;
      if (!roomId || ws.role !== "phone") return;
      const room = rooms.get(roomId);
      if (!room || !room.pc) return;

      // Compatibility: old phone builds used btn1/btn2.
      const btnA = Boolean(data.btnA ?? data.btn1);
      const btnB = Boolean(data.btnB ?? data.btn2);

      safeSend(room.pc, {
        type: "input",
        playerSlot: ws.playerSlot,
        dx: Number(data.dx) || 0,
        dy: Number(data.dy) || 0,
        btnA,
        btnB,
        btnC: Boolean(data.btnC),
        btnD: Boolean(data.btnD),
        ts: Date.now(),
      });
      return;
    }
  });

  ws.on("close", () => {
    if (!ws.roomId || !rooms.has(ws.roomId)) return;

    const room = rooms.get(ws.roomId);
    if (!room) return;

    if (room.pc === ws) room.pc = null;

    if (ws.role === "phone" && ws.playerSlot >= 0) {
      room.phones[ws.playerSlot] = null;
    }

    notifyRoom(ws.roomId);
    cleanupRoom(ws.roomId);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    const roomAge = now - room.createdAt;
    const hasClients = room.pc || room.phones.some(Boolean);
    if (!hasClients && roomAge > 1000 * 60 * 10) {
      rooms.delete(roomId);
    }
  }
}, 1000 * 60);

server.listen(PORT, () => {
  console.log(`Scalextric Web running on http://localhost:${PORT}`);
});
