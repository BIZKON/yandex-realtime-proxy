// ============================================================
// yandex-realtime-proxy.js v6
// 
// ДИАГНОСТИКА: логируем сырые данные от VoxEngine
// чтобы понять формат аудио через sendMediaBetween
// ============================================================

const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 10000;
const YANDEX_API_KEY = process.env.YANDEX_API_KEY || "AQVN3AiYJ5UhCQtDCBHteaoaToa0DAauJ57diLhc";
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID || "b1g9u208dq4eqnt8rn3i";
const YANDEX_MODEL = `gpt://${YANDEX_FOLDER_ID}/speech-realtime-250923`;
const YANDEX_WS_URL = `wss://rest-assistant.api.cloud.yandex.net/v1/realtime/openai?model=${YANDEX_MODEL}`;
const YANDEX_HEADERS = { Authorization: `api-key ${YANDEX_API_KEY}` };

const GET_SLOTS_URL = "https://nxtkthfhulkpaovilqlx.supabase.co/functions/v1/voice-agent-get-slots";
const CREATE_BOOKING_URL = "https://nxtkthfhulkpaovilqlx.supabase.co/functions/v1/voice-agent-create-booking";
const SEND_INFO_URL = "https://nxtkthfhulkpaovilqlx.supabase.co/functions/v1/voice-agent-send-info";

const VOICE = process.env.YANDEX_VOICE || "kirill";
const SILENCE_FRAME = Buffer.alloc(320);

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", version: "6.0" }));
});

const wss = new WebSocketServer({ server });

wss.on("connection", async (voxWs, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const callerPhone = url.searchParams.get("caller") || "unknown";
  const mode = url.searchParams.get("mode") || "inbound";
  const clientName = url.searchParams.get("name") || "";

  console.log(`[PROXY] New connection: caller=${callerPhone} mode=${mode}`);

  let yandexWs = null;
  let yandexConnected = false;
  let silenceInterval = null;
  let gotFirstAudio = false;
  let msgCount = 0;

  // Тишина
  silenceInterval = setInterval(() => {
    if (voxWs.readyState === WebSocket.OPEN && !gotFirstAudio) voxWs.send(SILENCE_FRAME);
    else if (gotFirstAudio) { clearInterval(silenceInterval); silenceInterval = null; }
  }, 20);
  const silenceTimeout = setTimeout(() => {
    if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
  }, 15000);

  // Яндекс
  try {
    yandexWs = new WebSocket(YANDEX_WS_URL, { headers: YANDEX_HEADERS });
  } catch (err) {
    console.error("[PROXY] Yandex failed:", err.message);
    cleanup(); voxWs.close(1011); return;
  }

  yandexWs.on("open", () => {
    console.log("[PROXY] Connected to Yandex");
    yandexConnected = true;

    const today = new Date();
    const days = ["воскресенье","понедельник","вторник","среда","четверг","пятница","суббота"];
    const dateStr = today.toISOString().split("T")[0];
    let ctx = [`Сегодня ${dateStr} (${days[today.getDay()]}).`];
    if (callerPhone !== "unknown") ctx.push(`Номер: ${callerPhone}.`);
    ctx.push(mode === "inbound" ? "Входящий звонок." : "Исходящий звонок.");

    yandexWs.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: (
          "Ты — Аврора, администратор студии массажа «Бохо Ритуал» в Санкт-Петербурге. " +
          "Отвечай кратко и дружелюбно. " +
          "Первая фраза: «Студия Бохо, добрый день! Слушаю вас.» " +
          "Если клиент хочет записаться — get_available_slots, затем book_appointment. " +
          "Отправить информацию — send_info. Переключить на администратора — forward_to_manager. " +
          ctx.join(" ")
        ),
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 8000, channels: 1 },
            turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 400 },
          },
          output: {
            format: { type: "audio/pcm", rate: 8000 },
            voice: VOICE,
          },
        },
        tools: [
          { type: "function", name: "get_available_slots", description: "Получить слоты.", parameters: { type: "object", properties: { service: { type: "string" }, date: { type: "string" } }, required: ["service", "date"], additionalProperties: false } },
          { type: "function", name: "book_appointment", description: "Записать клиента.", parameters: { type: "object", properties: { service: { type: "string" }, date: { type: "string" }, time: { type: "string" }, client_name: { type: "string" } }, required: ["service", "date", "time", "client_name"], additionalProperties: false } },
          { type: "function", name: "send_info", description: "Отправить информацию.", parameters: { type: "object", properties: { channel: { type: "string" }, content_type: { type: "string" }, phone: { type: "string" } }, required: ["channel", "content_type"], additionalProperties: false } },
          { type: "function", name: "forward_to_manager", description: "Переключить на администратора.", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false } },
        ],
      },
    }));
    console.log("[PROXY] session.update sent (rate=8000)");
  });

  // ===== КЛЮЧЕВОЕ: логируем ВСЁ от VoxEngine без фильтрации =====
  voxWs.on("message", (data, isBinary) => {
    msgCount++;
    const raw = Buffer.from(data);

    // Логируем первые 10 сообщений полностью
    if (msgCount <= 10) {
      const hex = raw.slice(0, Math.min(50, raw.length)).toString("hex");
      let textPreview = "";
      try { textPreview = raw.toString("utf8").substring(0, 100); } catch(e) {}
      console.log(`[VOX MSG #${msgCount}] len=${raw.length} binary=${isBinary} hex=${hex}`);
      console.log(`[VOX MSG #${msgCount}] text="${textPreview}"`);
    }

    if (msgCount === 100) console.log(`[VOX] 100 messages total`);
    if (msgCount % 500 === 0) console.log(`[VOX] ${msgCount} messages`);

    // Пересылаем ВСЁ как аудио в Яндекс (без фильтрации)
    if (yandexConnected && yandexWs && yandexWs.readyState === WebSocket.OPEN) {
      const b64 = raw.toString("base64");
      yandexWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
    }
  });

  // Яндекс → Voximplant
  yandexWs.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const t = msg.type;

      if (t === "response.output_audio.delta") {
        if (msg.delta && voxWs.readyState === WebSocket.OPEN) {
          if (!gotFirstAudio) {
            gotFirstAudio = true;
            console.log("[PROXY] First Yandex audio → Vox");
            if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
          }
          voxWs.send(Buffer.from(msg.delta, "base64"));
        }
        return;
      }

      if (t === "conversation.item.input_audio_transcription.completed") {
        console.log(`[USER] ${msg.transcript || ""}`);
        safeSend(voxWs, { type: "user_transcript", text: msg.transcript || "" });
        return;
      }
      if (t === "input_audio_buffer.speech_started") { console.log("[PROXY] Speech started"); return; }
      if (t === "session.created") { console.log(`[PROXY] Session: ${(msg.session||{}).id}`); return; }
      if (t === "session.updated") { console.log(`[PROXY] Updated, tools=${((msg.session||{}).tools||[]).length}`); safeSend(voxWs, { type: "session_ready", tools: ((msg.session||{}).tools||[]).length }); return; }

      if (t === "response.output_item.done") {
        const item = msg.item || {};
        if (item.type === "function_call") await handleFunc(item, yandexWs, voxWs, callerPhone);
        return;
      }

      if (t === "response.done") {
        console.log("[PROXY] Response done");
        gotFirstAudio = false;
        if (!silenceInterval) {
          silenceInterval = setInterval(() => {
            if (voxWs.readyState === WebSocket.OPEN && !gotFirstAudio) voxWs.send(SILENCE_FRAME);
            else { clearInterval(silenceInterval); silenceInterval = null; }
          }, 20);
          setTimeout(() => { if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; } }, 10000);
        }
        return;
      }

      if (t === "error") { console.error("[YA ERR]", JSON.stringify(msg)); return; }

      // Логируем неизвестные события
      if (!["response.created","response.output_item.added","response.content_part.added",
           "response.content_part.done","input_audio_buffer.committed","input_audio_buffer.commit",
           "conversation.item.created","response.output_text.delta"].includes(t)) {
        console.log(`[YA] ${t}`);
      }
    } catch (e) { console.error("[PROXY] parse:", e.message); }
  });

  async function handleFunc(item, yWs, vWs, phone) {
    const cid = item.call_id, fn = item.name || "?", at = item.arguments || "{}";
    let args = {}; try { args = JSON.parse(at); } catch(e) {}
    console.log(`[TOOL] ${fn}(${JSON.stringify(args)})`);

    if (fn === "forward_to_manager") {
      safeSend(vWs, { type: "forward_to_manager", reason: args.reason || "", call_id: cid });
      funcResult(yWs, cid, '{"status":"transferring"}');
      return;
    }

    let u = "", b = {};
    if (fn === "get_available_slots") { u = GET_SLOTS_URL; b = { service: args.service, date: args.date }; }
    else if (fn === "book_appointment") { u = CREATE_BOOKING_URL; b = { service: args.service, date: args.date, time: args.time, client_name: args.client_name, client_phone: phone }; }
    else if (fn === "send_info") { u = SEND_INFO_URL; b = { channel: args.channel, content_type: args.content_type, phone: args.phone || phone }; }
    else { funcResult(yWs, cid, '{"error":"unknown"}'); return; }

    try {
      const r = await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
      const res = await r.text();
      console.log(`[TOOL] ${fn} → ${r.status}: ${res.substring(0, 200)}`);
      funcResult(yWs, cid, res);
    } catch (e) { funcResult(yWs, cid, `{"error":"${e.message}"}`); }
  }

  function funcResult(yWs, cid, out) {
    if (yWs && yWs.readyState === WebSocket.OPEN) {
      yWs.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: cid, output: out } }));
      yWs.send(JSON.stringify({ type: "response.create" }));
    }
  }
  function safeSend(ws, o) { if (ws && ws.readyState === WebSocket.OPEN) try { ws.send(JSON.stringify(o)); } catch(e) {} }
  function cleanup() { if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; } clearTimeout(silenceTimeout); }

  voxWs.on("close", (c) => { console.log(`[PROXY] Vox dc: ${c}, msgs=${msgCount}`); cleanup(); if (yandexWs && yandexWs.readyState === WebSocket.OPEN) yandexWs.close(); });
  yandexWs.on("close", (c, r) => { console.log(`[PROXY] Ya dc: ${c} ${r||""}`); cleanup(); if (voxWs.readyState === WebSocket.OPEN) voxWs.close(c); });
  voxWs.on("error", () => { cleanup(); if (yandexWs && yandexWs.readyState === WebSocket.OPEN) yandexWs.close(); });
  yandexWs.on("error", () => { cleanup(); if (voxWs.readyState === WebSocket.OPEN) voxWs.close(1011); });
});

server.listen(PORT, () => { console.log(`[PROXY] v6 diag port=${PORT}`); });
