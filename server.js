import "dotenv/config";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { pool } from "./db.js";

const PORT = process.env.PORT || 3000;
const app = express();

app.use(cors({
  origin: "*", // まずは緩め。後でフロントURLに絞る
}));
app.use(express.json());

app.get("/healthz", (_req, res) => res.json({ ok: true }));

const norm = (s) => String(s || "").trim().toUpperCase();

// --- REST: stations/register
app.post("/v1/stations/register", async (req, res) => {
  try {
    const callsign = norm(req.body?.callsign);
    if (!callsign) return res.status(400).json({ ok: false, error: "callsign_required" });

    // channelはフロント側で持ってるので、ここではDBに最終接続を残すだけでもOK
    await pool.query(
      `insert into stations(callsign, channel, last_seen)
       values($1, $2, now())
       on conflict (callsign) do update set last_seen=now()`,
      [callsign, ""] // channelはWS接続時に更新する想定
    );

    res.json({ ok: true, station: { callsign } });
  } catch (e) {
    res.status(500).json({ ok: false, error: "register_failed" });
  }
});

// --- REST: stations/online
app.get("/v1/stations/online", async (req, res) => {
  try {
    const channel = String(req.query?.channel || "");
    // 直近2分をオンライン扱い（適当に調整）
    const { rows } = await pool.query(
      `select callsign, channel, last_seen
       from stations
       where ($1 = '' or channel = $1)
         and last_seen > now() - interval '2 minutes'
       order by last_seen desc
       limit 200`,
      [channel]
    );
    res.json({ ok: true, stations: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: "online_failed" });
  }
});

// --- REST: messages (send)
app.post("/v1/messages", async (req, res) => {
  try {
    const fromCallsign = norm(req.body?.fromCallsign);
    const toCallsign = req.body?.toCallsign ? norm(req.body?.toCallsign) : null;
    const channel = String(req.body?.channel || "");
    const type = String(req.body?.type || "CW_MORSE");
    const payload = req.body?.payload || {};

    if (!fromCallsign || !channel) {
      return res.status(400).json({ ok: false, error: "bad_request" });
    }

    const { rows } = await pool.query(
      `insert into messages(channel, from_callsign, to_callsign, type, payload)
       values($1,$2,$3,$4,$5)
       returning id, created_at`,
      [channel, fromCallsign, toCallsign, type, payload]
    );

    // WSへブロードキャスト
    broadcastToChannel(channel, {
      kind: "message",
      message: {
        id: rows[0].id,
        channel,
        callsign: fromCallsign,
        toCallsign,
        type,
        payload,
        created_at: rows[0].created_at
      }
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "send_failed" });
  }
});

// --- REST: messages/recent
app.get("/v1/messages/recent", async (req, res) => {
  try {
    const channel = String(req.query?.channel || "");
    const limit = Math.min(500, Math.max(1, Number(req.query?.limit || 100)));

    const { rows } = await pool.query(
      `select id, channel, from_callsign as callsign, to_callsign as "toCallsign", type, payload, created_at
       from messages
       where channel = $1
       order by id desc
       limit $2`,
      [channel, limit]
    );

    res.json({ ok: true, messages: rows.reverse() });
  } catch (e) {
    res.status(500).json({ ok: false, error: "recent_failed" });
  }
});

// --- REST: contacts/list
app.get("/v1/contacts/list", async (req, res) => {
  try {
    const myCallsign = norm(req.query?.myCallsign);
    if (!myCallsign) return res.status(400).json({ ok: false, error: "my_callsign_required" });

    const { rows } = await pool.query(
      `select callsign, name, location, notes, updated_at
       from contacts
       where my_callsign=$1
       order by updated_at desc
       limit 500`,
      [myCallsign]
    );
    res.json({ ok: true, contacts: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: "contacts_failed" });
  }
});

// --- REST: contacts/update
app.patch("/v1/contacts/update", async (req, res) => {
  try {
    const myCallsign = norm(req.body?.myCallsign);
    const callsign = norm(req.body?.callsign);
    const { name = null, location = null, notes = null } = req.body || {};
    if (!myCallsign || !callsign) return res.status(400).json({ ok: false, error: "bad_request" });

    await pool.query(
      `insert into contacts(my_callsign, callsign, name, location, notes, updated_at)
       values($1,$2,$3,$4,$5, now())
       on conflict(my_callsign, callsign)
       do update set name=$3, location=$4, notes=$5, updated_at=now()`,
      [myCallsign, callsign, name, location, notes]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "contact_update_failed" });
  }
});

const server = app.listen(PORT, () => {
  console.log(`WorldMorse API listening on :${PORT}`);
});

// -------- WebSocket --------
const wss = new WebSocketServer({ noServer: true });
const channelClients = new Map(); // channel -> Set(ws)

function broadcastToChannel(channel, obj) {
  const set = channelClients.get(channel);
  if (!set) return;
  const data = JSON.stringify(obj);
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(data);
  }
}

server.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/ws")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", async (ws, req) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const callsign = norm(url.searchParams.get("callsign"));
    const channel = String(url.searchParams.get("channel") || "");
    if (!callsign || !channel) {
      ws.close();
      return;
    }

    // join
    if (!channelClients.has(channel)) channelClients.set(channel, new Set());
    channelClients.get(channel).add(ws);
    ws._channel = channel;
    ws._callsign = callsign;

    // station heartbeat更新
    await pool.query(
      `insert into stations(callsign, channel, last_seen)
       values($1,$2, now())
       on conflict(callsign) do update set channel=$2, last_seen=now()`,
      [callsign, channel]
    );

    ws.send(JSON.stringify({ kind: "hello", ok: true, callsign, channel }));

    const iv = setInterval(async () => {
      try {
        await pool.query(`update stations set last_seen=now(), channel=$2 where callsign=$1`, [callsign, channel]);
      } catch {}
    }, 30_000);

    ws.on("close", () => {
      clearInterval(iv);
      channelClients.get(channel)?.delete(ws);
    });

    ws.on("message", () => {
      // 将来：クライアント→サーバーWS送信を使いたくなったらここで処理
    });
  } catch {
    ws.close();
  }
});
