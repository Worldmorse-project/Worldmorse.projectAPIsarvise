import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer } from "ws";
import { migrate } from "./migrate.js";
import { q } from "./db.js";

const PORT = process.env.PORT || 3000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: FRONTEND_ORIGIN === "*" ? true : FRONTEND_ORIGIN }));

app.get("/healthz", (_, res) => res.json({ ok: true }));

// callsign 登録
app.post("/v1/stations/register", async (req, res) => {
  try {
    const callsign = String(req.body?.callsign || "").trim().toUpperCase();
    const channel = String(req.body?.channel || req.query?.channel || "7.050");
    if (!callsign) return res.status(400).json({ ok: false, error: "callsign_required" });

    await q(
      `insert into stations(callsign, channel, last_seen)
       values($1,$2, now())
       on conflict (callsign) do update set channel=excluded.channel, last_seen=now()`,
      [callsign, channel]
    );

    return res.json({ ok: true, station: { callsign, channel } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "register_failed" });
  }
});

// オンライン局一覧（last_seen が一定以内）
app.get("/v1/stations/online", async (req, res) => {
  try {
    const channel = String(req.query?.channel || "7.050");
    const ttlSec = Number(process.env.STATION_TTL_SEC || 60);

    const r = await q(
      `select callsign, channel, mode, frequency, last_seen
       from stations
       where channel=$1 and last_seen > now() - ($2 || ' seconds')::interval
       order by last_seen desc
       limit 200`,
      [channel, ttlSec]
    );

    res.json({ ok: true, stations: r.rows });
  } catch {
    res.status(500).json({ ok: false, error: "online_failed" });
  }
});

// メッセージ送信（保存してWSにも流す）
app.post("/v1/messages", async (req, res) => {
  try {
    const { fromCallsign, toCallsign = null, channel, type, payload } = req.body || {};
    const from = String(fromCallsign || "").trim().toUpperCase();
    const to = toCallsign ? String(toCallsign).trim().toUpperCase() : null;
    const ch = String(channel || "7.050");
    const t = String(type || "CW_MORSE");
    const p = payload ?? {};

    if (!from) return res.status(400).json({ ok: false, error: "from_required" });

    const r = await q(
      `insert into messages(channel, from_callsign, to_callsign, type, payload)
       values($1,$2,$3,$4,$5)
       returning id, created_at`,
      [ch, from, to, t, JSON.stringify(p)]
    );

    // station last_seen 更新
    await q(
      `insert into stations(callsign, channel, last_seen)
       values($1,$2, now())
       on conflict (callsign) do update set channel=excluded.channel, last_seen=now()`,
      [from, ch]
    );

    const msg = {
      id: r.rows[0].id,
      channel: ch,
      callsign: from,
      to_callsign: to,
      type: t,
      payload: p,
      created_at: r.rows[0].created_at
    };

    broadcastToChannel(ch, { kind: "message", data: msg });

    res.json({ ok: true, message: msg });
  } catch (e) {
    res.status(500).json({ ok: false, error: "send_failed" });
  }
});

// 直近メッセージ
app.get("/v1/messages/recent", async (req, res) => {
  try {
    const channel = String(req.query?.channel || "7.050");
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit || 100)));

    const r = await q(
      `select id, channel, from_callsign as callsign, to_callsign, type, payload, created_at
       from messages
       where channel=$1
       order by id desc
       limit $2`,
      [channel, limit]
    );

    res.json({ ok: true, messages: r.rows.reverse().map(x => ({ ...x, payload: x.payload })) });
  } catch {
    res.status(500).json({ ok: false, error: "recent_failed" });
  }
});

// Contacts
app.get("/v1/contacts/list", async (req, res) => {
  try {
    const my = String(req.query?.myCallsign || "").trim().toUpperCase();
    if (!my) return res.status(400).json({ ok: false, error: "my_callsign_required" });

    const r = await q(
      `select callsign, name, location, notes, last_contact_date, qso_count
       from contacts
       where my_callsign=$1
       order by last_contact_date desc nulls last
       limit 500`,
      [my]
    );
    res.json({ ok: true, contacts: r.rows });
  } catch {
    res.status(500).json({ ok: false, error: "contacts_failed" });
  }
});

app.patch("/v1/contacts/update", async (req, res) => {
  try {
    const my = String(req.body?.myCallsign || "").trim().toUpperCase();
    const cs = String(req.body?.callsign || "").trim().toUpperCase();
    if (!my || !cs) return res.status(400).json({ ok: false, error: "callsign_required" });

    const { name = null, location = null, notes = null } = req.body || {};
    await q(
      `insert into contacts(my_callsign, callsign, name, location, notes)
       values($1,$2,$3,$4,$5)
       on conflict(my_callsign, callsign)
       do update set name=excluded.name, location=excluded.location, notes=excluded.notes`,
      [my, cs, name, location, notes]
    );

    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "contact_update_failed" });
  }
});

// --- WebSocket ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// channel => Set(ws)
const channelRooms = new Map();

function joinRoom(channel, ws) {
  if (!channelRooms.has(channel)) channelRooms.set(channel, new Set());
  channelRooms.get(channel).add(ws);
}

function leaveRoom(channel, ws) {
  const s = channelRooms.get(channel);
  if (!s) return;
  s.delete(ws);
  if (s.size === 0) channelRooms.delete(channel);
}

function broadcastToChannel(channel, obj) {
  const s = channelRooms.get(channel);
  if (!s) return;
  const data = JSON.stringify(obj);
  for (const ws of s) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const callsign = String(url.searchParams.get("callsign") || "").trim().toUpperCase();
  const channel = String(url.searchParams.get("channel") || "7.050");

  ws._channel = channel;
  ws._callsign = callsign;

  joinRoom(channel, ws);

  // last_seen更新（ついで）
  if (callsign) {
    await q(
      `insert into stations(callsign, channel, last_seen)
       values($1,$2, now())
       on conflict (callsign) do update set channel=excluded.channel, last_seen=now()`,
      [callsign, channel]
    );
    broadcastToChannel(channel, { kind: "presence", data: { callsign, channel } });
  }

  ws.on("message", async (raw) => {
    // 心拍 or 将来のWebRTCシグナリング（offer/answer/candidate）を流す用途
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }

    if (msg?.kind === "ping") {
      if (callsign) {
        await q(`update stations set last_seen=now() where callsign=$1`, [callsign]);
      }
      ws.send(JSON.stringify({ kind: "pong" }));
      return;
    }

    // そのまま同一channelに中継（シグナリング用）
    broadcastToChannel(channel, msg);
  });

  ws.on("close", () => {
    leaveRoom(channel, ws);
  });
});

await migrate();
server.listen(PORT, () => {
  console.log(`WorldMorse API listening on :${PORT}`);
});
