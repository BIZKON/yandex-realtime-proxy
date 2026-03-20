// ============================================================
// yandex-realtime-proxy.js v11
// 
// v11: нарезаем аудио от Яндекса на фреймы 320 байт (20ms @ 8kHz)
//      VoxEngine ожидает маленькие фреймы, не большие блоки
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

// Размер фрейма: 20ms при 8kHz PCM16 mono = 160 samples * 2 bytes = 320 bytes
const FRAME_SIZE = 320;
const SILENCE_B64 = Buffer.alloc(FRAME_SIZE).toString("base64");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", version: "11.0" }));
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
  let startSent = false;
  let voxChunkCount = 0;
  let outChunkCount = 0;
  let voxSampleRate = 8000;
  const audioBuffer = [];
  let pcmRemainder = Buffer.alloc(0); // остаток от нарезки

  // Отправка start event в VoxEngine
  function sendStartToVox() {
    if (startSent) return;
    startSent = true;
    voxWs.send(JSON.stringify({
      event: "start",
      sequenceNumber: 0,
      start: { mediaFormat: { encoding: "PCM16", sampleRate: voxSampleRate, channels: 1 } }
    }));
    console.log(`[PROXY] Sent start to VoxEngine (rate=${voxSampleRate})`);
  }

  // Отправка одного фрейма (320 bytes PCM → base64 → JSON media)
  function sendFrameToVox(pcmFrame) {
    if (voxWs.readyState !== WebSocket.OPEN) return;
    if (!startSent) sendStartToVox();
    outChunkCount++;
    voxWs.send(JSON.stringify({
      event: "media",
      sequenceNumber: outChunkCount,
      media: { chunk: outChunkCount, payload: pcmFrame.toString("base64") }
    }));
  }

  // Нарезка большого PCM-блока на фреймы по 320 байт и отправка
  function sendChunkedAudioToVox(pcmBuffer) {
    // Склеиваем с остатком от прошлого раза
    let data = Buffer.concat([pcmRemainder, pcmBuffer]);
    let offset = 0;

    while (offset + FRAME_SIZE <= data.length) {
      sendFrameToVox(data.slice(offset, offset + FRAME_SIZE));
      offset += FRAME_SIZE;
    }

    // Сохраняем остаток
    pcmRemainder = data.slice(offset);
  }

  // Тишина
  silenceInterval = setInterval(() => {
    if (voxWs.readyState === WebSocket.OPEN && !gotFirstAudio) {
      if (!startSent) sendStartToVox();
      outChunkCount++;
      voxWs.send(JSON.stringify({
        event: "media",
        sequenceNumber: outChunkCount,
        media: { chunk: outChunkCount, payload: SILENCE_B64 }
      }));
    } else if (gotFirstAudio) {
      clearInterval(silenceInterval); silenceInterval = null;
    }
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
    sendStartToVox();

    const today = new Date();
    const days = ["воскресенье","понедельник","вторник","среда","четверг","пятница","суббота"];
    const dateStr = today.toISOString().split("T")[0];
    let ctx = [`Сегодня ${dateStr} (${days[today.getDay()]}).`];
    if (callerPhone !== "unknown") ctx.push(`Номер: ${callerPhone}.`);
    ctx.push(mode === "inbound" ? "Входящий звонок." : "Исходящий звонок.");
    if (clientName) ctx.push(`Клиент: ${clientName}.`);

    yandexWs.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: (
          "Ты — Аврора, администратор студии массажа «Бохо Ритуал» в Санкт-Петербурге. " +
          "Отвечай кратко и дружелюбно. Говори естественно. " +
          "Первая фраза: «Студия Бохо, добрый день! Слушаю вас.» " +
          "Если клиент хочет записаться — get_available_slots, затем book_appointment. " +
          "Отправить информацию — send_info. Переключить на администратора — forward_to_manager. " +
          ctx.join(" ")
        ),
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: voxSampleRate, channels: 1 },
            turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 400 },
          },
          output: {
            format: { type: "audio/pcm", rate: voxSampleRate },
            voice: VOICE,
          },
        },
        tools: [
          { type: "function", name: "get_available_slots", description: "Получить доступные слоты.", parameters: { type: "object", properties: { service: { type: "string" }, date: { type: "string" } }, required: ["service", "date"], additionalProperties: false } },
          { type: "function", name: "book_appointment", description: "Записать клиента.", parameters: { type: "object", properties: { service: { type: "string" }, date: { type: "string" }, time: { type: "string" }, client_name: { type: "string" } }, required: ["service", "date", "time", "client_name"], additionalProperties: false } },
          { type: "function", name: "send_info", description: "Отправить информацию.", parameters: { type: "object", properties: { channel: { type: "string" }, content_type: { type: "string" }, phone: { type: "string" } }, required: ["channel", "content_type"], additionalProperties: false } },
          { type: "function", name: "forward_to_manager", description: "Переключить на администратора.", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false } },
        ],
      },
    }));
    console.log(`[PROXY] session.update (rate=${voxSampleRate})`);

    while (audioBuffer.length > 0) {
      yandexWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: audioBuffer.shift() }));
    }
  });

  // VoxEngine → Яндекс
  voxWs.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }

    if (msg.event === "start") {
      const fmt = (msg.start || {}).mediaFormat || {};
      voxSampleRate = fmt.sampleRate || 8000;
      console.log(`[VOX] Start: encoding=${fmt.encoding} rate=${voxSampleRate}`);
      return;
    }

    if (msg.event === "media") {
      const payload = (msg.media || {}).payload;
      if (!payload) return;
      voxChunkCount++;
      if (voxChunkCount <= 3) console.log(`[VOX] Media #${voxChunkCount}: ${payload.length} chars`);
      if (voxChunkCount % 500 === 0) console.log(`[VOX] ${voxChunkCount} chunks`);

      if (yandexConnected && yandexWs && yandexWs.readyState === WebSocket.OPEN) {
        yandexWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload }));
      } else {
        audioBuffer.push(payload);
      }
      return;
    }

    if (msg.event === "stop") { console.log("[VOX] Stop"); return; }
  });

  // Яндекс → VoxEngine (нарезаем на фреймы!)
  yandexWs.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const t = msg.type;

      if (t === "response.output_audio.delta") {
        if (msg.delta && voxWs.readyState === WebSocket.OPEN) {
          if (!gotFirstAudio) {
            gotFirstAudio = true;
            if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
          }
          // Декодируем base64 → PCM → нарезаем на фреймы 320 байт → отправляем
          const pcm = Buffer.from(msg.delta, "base64");
          sendChunkedAudioToVox(pcm);
        }
        return;
      }

      if (t === "conversation.item.input_audio_transcription.completed") {
        if (msg.transcript) console.log(`[USER] ${msg.transcript}`);
        return;
      }
      if (t === "input_audio_buffer.speech_started") { console.log("[PROXY] Speech started"); return; }
      if (t === "session.created") { console.log(`[PROXY] Session: ${(msg.session||{}).id}`); return; }
      if (t === "session.updated") { console.log(`[PROXY] Updated, tools=${((msg.session||{}).tools||[]).length}`); return; }
      if (t === "response.output_text.delta") { if (msg.delta) console.log(`[AGENT] ${msg.delta}`); return; }

      if (t === "response.output_item.done") {
        const item = msg.item || {};
        if (item.type === "function_call") await handleFunc(item, yandexWs, voxWs, callerPhone);
        return;
      }

      if (t === "response.done") {
        // Flush остаток PCM если есть
        if (pcmRemainder.length > 0) {
          const padded = Buffer.concat([pcmRemainder, Buffer.alloc(FRAME_SIZE - pcmRemainder.length)]);
          sendFrameToVox(padded);
          pcmRemainder = Buffer.alloc(0);
        }
        console.log(`[PROXY] Response done (out=${outChunkCount})`);
        gotFirstAudio = false;
        if (!silenceInterval) {
          silenceInterval = setInterval(() => {
            if (voxWs.readyState === WebSocket.OPEN && !gotFirstAudio) {
              outChunkCount++;
              voxWs.send(JSON.stringify({
                event: "media", sequenceNumber: outChunkCount,
                media: { chunk: outChunkCount, payload: SILENCE_B64 }
              }));
            } else { clearInterval(silenceInterval); silenceInterval = null; }
          }, 20);
          setTimeout(() => { if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; } }, 10000);
        }
        return;
      }

      if (t === "error") { console.error("[YA ERR]", JSON.stringify(msg)); return; }

      if (!["response.created","response.output_item.added","response.content_part.added",
           "response.content_part.done","input_audio_buffer.committed","input_audio_buffer.commit",
           "conversation.item.created","response.output_audio.done","response.output_text.done",
           "response.output_audio_transcript.done","input_audio_buffer.speech_stopped"].includes(t)) {
        console.log(`[YA] ${t}`);
      }
    } catch (e) { console.error("[PROXY] parse:", e.message); }
  });

  async function handleFunc(item, yWs, vWs, phone) {
    const cid = item.call_id, fn = item.name || "?", at = item.arguments || "{}";
    let args = {}; try { args = JSON.parse(at); } catch(e) {}
    console.log(`[TOOL] ${fn}(${JSON.stringify(args)})`);

    if (fn === "forward_to_manager") {
      voxWs.send(JSON.stringify({ event: "command", command: "forward_to_manager", reason: args.reason || "" }));
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
      console.log(`[TOOL] Result sent`);
    }
  }

  function cleanup() {
    if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
    clearTimeout(silenceTimeout);
  }

  voxWs.on("close", (c) => { console.log(`[PROXY] Vox dc: ${c}, in=${voxChunkCount} out=${outChunkCount}`); cleanup(); if (yandexWs && yandexWs.readyState === WebSocket.OPEN) yandexWs.close(); });
  yandexWs.on("close", (c, r) => { console.log(`[PROXY] Ya dc: ${c} ${r||""}`); cleanup(); if (voxWs.readyState === WebSocket.OPEN) voxWs.close(c); });
  voxWs.on("error", () => { cleanup(); if (yandexWs && yandexWs.readyState === WebSocket.OPEN) yandexWs.close(); });
  yandexWs.on("error", () => { cleanup(); if (voxWs.readyState === WebSocket.OPEN) voxWs.close(1011); });
});

server.listen(PORT, () => { console.log(`[PROXY] v11 port=${PORT} voice=${VOICE}`); });
