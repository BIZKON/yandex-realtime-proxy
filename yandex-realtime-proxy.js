// ============================================================
// yandex-realtime-proxy.js v12.6
//
// FIX vs v12.5:
// - book_appointment: correct params (date, time, service) matching Edge Function
// - Caller phone auto-injected from URL param — agent never asks for phone
// - Prompt includes caller number + "НЕ СПРАШИВАЙ телефон"
// ============================================================

const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

// ── Config ──────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
const YANDEX_API_KEY = process.env.YANDEX_API_KEY || "AQVN3AiYJ5UhCQtDCBHteaoaToa0DAauJ57diLhc";
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID || "b1g9u208dq4eqnt8rn3i";
const YANDEX_MODEL = `gpt://${YANDEX_FOLDER_ID}/speech-realtime-250923`;
const YANDEX_WS_URL = `wss://rest-assistant.api.cloud.yandex.net/v1/realtime/openai?model=${YANDEX_MODEL}`;
const YANDEX_HEADERS = { Authorization: `api-key ${YANDEX_API_KEY}` };
const VOICE = process.env.YANDEX_VOICE || "masha";
const VOICE_ROLE = process.env.YANDEX_VOICE_ROLE || "friendly";  // амплуа: friendly, neutral, strict, good
const VOICE_SPEED = parseFloat(process.env.YANDEX_VOICE_SPEED || "0.9"); // 0.25–1.5

// ── Edge Function URLs (Бохо Ритуал) ───────────────────────
const GET_SLOTS_URL = "https://nxtkthfhulkpaovilqlx.supabase.co/functions/v1/voice-agent-get-slots";
const CREATE_BOOKING_URL = "https://nxtkthfhulkpaovilqlx.supabase.co/functions/v1/voice-agent-create-booking";
const SEND_INFO_URL = "https://nxtkthfhulkpaovilqlx.supabase.co/functions/v1/voice-agent-send-info";

// ── VAD tuning (FIX #1) ────────────────────────────────────
const VAD_THRESHOLD = 0.6;            // was 0.5 — less sensitive to noise
const VAD_SILENCE_MS = 800;           // was 400 — wait longer before committing turn
const VAD_PREFIX_PADDING_MS = 300;    // keep beginning of speech

// ── Audio frame constants ───────────────────────────────────
// 20ms @ 8kHz PCM16 mono = 160 samples × 2 bytes = 320 bytes
const FRAME_SIZE = 320;
const SILENCE_B64 = Buffer.alloc(FRAME_SIZE).toString("base64");

// ── System prompt (Аврора — минимальный, KB дополнит) ───────
function buildSystemPrompt(callerNumber) {
  const today = new Date().toLocaleDateString("ru-RU", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const phone = callerNumber ? `+7${callerNumber}` : "неизвестен";
  return `Ты — Аврора, администратор студии массажа «Бохо Ритуал» в Санкт-Петербурге.

Твои задачи:
- Записать клиента на массаж
- Рассказать об услугах и ценах
- Ответить на вопросы о студии

Правила:
- Говори дружелюбно, тепло, кратко
- Не придумывай цены и услуги — если не знаешь, скажи что уточнишь
- Используй инструмент get_available_slots для проверки свободного времени
- Используй инструмент book_appointment для записи (передавай дату, время и название услуги)
- Используй инструмент send_info для отправки информации клиенту в Telegram
- Когда клиент прощается или говорит что вопросов нет — попрощайся и вызови end_call
- НЕ СПРАШИВАЙ номер телефона — он уже известен: ${phone}
- НЕ СПРАШИВАЙ имя, если клиент не называет — используй "Клиент"

Сегодня: ${today}.
Номер студии: +7 901 132 03 07.
Адрес: Санкт-Петербург (уточни у менеджера точный адрес).

Стиль речи: говори дружелюбно и тепло. Не торопись. Делай небольшие паузы между мыслями. Отвечай кратко — 1-2 предложения, не больше.`;
}

// ── Tools definition ────────────────────────────────────────
const TOOLS = [
  {
    type: "function",
    name: "get_available_slots",
    description: "Получить свободные слоты для записи на массаж. Вызывай когда клиент хочет записаться или узнать свободное время.",
    parameters: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Дата в формате YYYY-MM-DD"
        },
        service_id: {
          type: "string",
          description: "ID услуги (если известен)"
        }
      },
      required: ["date"]
    }
  },
  {
    type: "function",
    name: "book_appointment",
    description: "Записать клиента на массаж. Вызывай только после подтверждения клиентом даты, времени и вида массажа. Не спрашивай телефон — он уже известен.",
    parameters: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Дата записи в формате YYYY-MM-DD"
        },
        time: {
          type: "string",
          description: "Время записи в формате HH:MM"
        },
        service: {
          type: "string",
          description: "Название услуги, например: Расслабляющий массаж, Классический массаж, Антицеллюлитный массаж"
        },
        client_name: {
          type: "string",
          description: "Имя клиента (если назвал)"
        }
      },
      required: ["date", "time", "service"]
    }
  },
  {
    type: "function",
    name: "send_info",
    description: "Отправить информацию клиенту в Telegram (адрес, подтверждение записи, и т.д.)",
    parameters: {
      type: "object",
      properties: {
        phone: {
          type: "string",
          description: "Телефон клиента"
        },
        message: {
          type: "string",
          description: "Текст сообщения"
        }
      },
      required: ["phone", "message"]
    }
  },
  {
    type: "function",
    name: "forward_to_manager",
    description: "Перевести звонок на менеджера. Вызывай когда клиент настаивает на разговоре с человеком.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Причина перевода"
        }
      },
      required: ["reason"]
    }
  },
  {
    type: "function",
    name: "end_call",
    description: "Завершить звонок. Вызывай ТОЛЬКО после того как попрощался с клиентом и клиент подтвердил что вопросов нет.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Причина завершения: goodbye, no_response, error"
        }
      },
      required: ["reason"]
    }
  }
];

// ── Logging helper ──────────────────────────────────────────
function log(tag, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}][${tag}] ${msg}`);
}

// ── HTTP server (health check + keep-alive) ─────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", version: "12.6", voice: VOICE, role: VOICE_ROLE, speed: VOICE_SPEED }));
});

// ── WebSocket server ────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on("connection", async (voxWs, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const caller = url.searchParams.get("caller") || "unknown";
  const mode = url.searchParams.get("mode") || "inbound";

  log("PROXY", `New connection: caller=${caller} mode=${mode}`);

  let yaWs = null;
  let voxRate = 8000;
  let chunkCounter = 0;
  let outputChunks = 0;
  let inputChunks = 0;
  let sentStartToVox = false;
  let agentSpeaking = false;      // FIX #2: track if agent is currently speaking
  let muteOutput = false;         // FIX #2: mute audio output after barge-in
  let endingCall = false;         // FIX: prevent end_call loop
  let lastAudioSentAt = 0;       // FIX: track when last audio frame was sent to VoxEngine
  
  // VoxEngine has a playback buffer — agent may still be audible
  // for up to 3 seconds after we stop sending frames
  const PLAYBACK_BUFFER_MS = 3000;
  function isAgentAudible() {
    return agentSpeaking || (Date.now() - lastAudioSentAt < PLAYBACK_BUFFER_MS);
  }

  // ── Connect to Yandex ───────────────────────────────────
  function connectYandex() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(YANDEX_WS_URL, { headers: YANDEX_HEADERS });
      ws.on("open", () => {
        log("PROXY", "Connected to Yandex");
        resolve(ws);
      });
      ws.on("error", (err) => {
        log("PROXY", `Yandex WS error: ${err.message}`);
        reject(err);
      });
    });
  }

  // ── Send start event to VoxEngine ─────────────────────────
  function sendStartToVox() {
    if (sentStartToVox) return;
    sentStartToVox = true;
    const startMsg = {
      event: "start",
      start: {
        mediaFormat: {
          encoding: "PCM16",
          sampleRate: voxRate,
          channels: 1
        }
      }
    };
    if (voxWs.readyState === WebSocket.OPEN) {
      voxWs.send(JSON.stringify(startMsg));
      log("PROXY", `Sent start to VoxEngine (rate=${voxRate})`);
    }
  }

  // ── Send audio frame to VoxEngine ─────────────────────────
  function sendMediaToVox(base64Payload) {
    if (voxWs.readyState !== WebSocket.OPEN) return;
    chunkCounter++;
    const msg = {
      event: "media",
      media: {
        chunk: chunkCounter,
        payload: base64Payload
      }
    };
    voxWs.send(JSON.stringify(msg));
  }

  // ── Slice large audio buffer into 320-byte frames ─────────
  function sliceAndSendAudio(base64Audio) {
    const buf = Buffer.from(base64Audio, "base64");
    for (let offset = 0; offset < buf.length; offset += FRAME_SIZE) {
      const frame = buf.slice(offset, Math.min(offset + FRAME_SIZE, buf.length));
      // Pad last frame if needed
      let frameToSend;
      if (frame.length < FRAME_SIZE) {
        frameToSend = Buffer.alloc(FRAME_SIZE);
        frame.copy(frameToSend);
      } else {
        frameToSend = frame;
      }
      sendMediaToVox(frameToSend.toString("base64"));
    }
    lastAudioSentAt = Date.now();  // track for barge-in timing
    outputChunks++;
  }

  // ── Execute tool call (Edge Functions) ────────────────────
  async function executeTool(name, args, callId) {
    // Block all tool calls if we're already ending
    if (endingCall && name !== "end_call") {
      log("TOOL", `Skipping ${name} — call is ending`);
      return;
    }
    log("TOOL", `Calling ${name} with ${JSON.stringify(args)}`);
    let result = { success: false, error: "Unknown tool" };

    try {
      if (name === "get_available_slots") {
        const resp = await fetch(GET_SLOTS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: args.date, service_id: args.service_id })
        });
        result = await resp.json();

      } else if (name === "book_appointment") {
        const resp = await fetch(CREATE_BOOKING_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date: args.date,
            time: args.time,
            service: args.service,
            client_name: args.client_name || "Клиент",
            client_phone: caller ? `+7${caller}` : undefined
          })
        });
        result = await resp.json();

      } else if (name === "send_info") {
        const resp = await fetch(SEND_INFO_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: args.phone, message: args.message })
        });
        result = await resp.json();

      } else if (name === "forward_to_manager") {
        // Send command to VoxEngine via special message
        if (voxWs.readyState === WebSocket.OPEN) {
          voxWs.send(JSON.stringify({
            event: "command",
            command: { type: "forward_to_manager", reason: args.reason }
          }));
        }
        result = { success: true, message: "Перевожу на менеджера" };

      } else if (name === "end_call") {
        // FIX: guard against infinite loop
        if (endingCall) {
          log("PROXY", "end_call already in progress, skipping");
          return;  // don't send result back to Yandex
        }
        endingCall = true;
        log("PROXY", `end_call requested: ${args.reason}`);
        
        // Give Yandex 2 seconds to finish speaking last phrase, then close
        setTimeout(() => {
          if (voxWs.readyState === WebSocket.OPEN) {
            voxWs.send(JSON.stringify({
              event: "command",
              command: { type: "end_call", reason: args.reason }
            }));
          }
          setTimeout(() => {
            cleanup("end_call");
          }, 1500);
        }, 2000);
        
        // DON'T send result back to Yandex — this prevents the loop
        return;
      }
    } catch (err) {
      log("TOOL", `Error: ${err.message}`);
      result = { success: false, error: err.message };
    }

    log("TOOL", `Result: ${JSON.stringify(result).slice(0, 200)}`);

    // Send result back to Yandex
    if (yaWs && yaWs.readyState === WebSocket.OPEN) {
      yaWs.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(result)
        }
      }));
      yaWs.send(JSON.stringify({ type: "response.create" }));
    }
  }

  // ── Cleanup ───────────────────────────────────────────────
  let cleanedUp = false;
  function cleanup(reason) {
    if (cleanedUp) return;
    cleanedUp = true;
    log("PROXY", `Cleanup: ${reason}`);
    stopSilenceTimer();
    if (yaWs && yaWs.readyState === WebSocket.OPEN) {
      yaWs.close(1000, reason);
    }
    if (voxWs.readyState === WebSocket.OPEN) {
      voxWs.send(JSON.stringify({ event: "stop" }));
      voxWs.close(1000, reason);
    }
  }

  // ── Silence keepalive timer ───────────────────────────────
  let silenceTimer = null;
  function startSilenceTimer() {
    if (silenceTimer) return;
    silenceTimer = setInterval(() => {
      if (voxWs.readyState === WebSocket.OPEN && sentStartToVox && !agentSpeaking) {
        sendMediaToVox(SILENCE_B64);
      }
    }, 200); // every 200ms
  }
  function stopSilenceTimer() {
    if (silenceTimer) {
      clearInterval(silenceTimer);
      silenceTimer = null;
    }
  }

  // ── Handle VoxEngine messages ─────────────────────────────
  voxWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.event === "start") {
      // VoxEngine media streaming handshake
      const fmt = msg.start?.mediaFormat;
      if (fmt?.sampleRate) voxRate = fmt.sampleRate;
      log("VOX", `Start: encoding=${fmt?.encoding} rate=${voxRate}`);
      sendStartToVox();
      startSilenceTimer();

    } else if (msg.event === "media") {
      // Audio from phone → Yandex
      inputChunks++;
      if (inputChunks <= 3) {
        log("VOX", `Media #${inputChunks}: ${msg.media?.payload?.length || 0} chars`);
      }
      
      // ── HALF-DUPLEX FIX ────────────────────────────────────
      // Don't forward client audio while agent is still audible
      // (VoxEngine plays buffered audio 1-3 sec after generation ends)
      // This prevents: client speaks over agent → Yandex does barge-in
      // → generates new response → client hasn't heard the old one → chaos
      if (isAgentAudible()) {
        if (inputChunks % 200 === 0) { // log every ~4 sec, not every frame
          log("PROXY", `Input muted (agent audible, last audio ${Date.now() - lastAudioSentAt}ms ago)`);
        }
        return; // drop this frame — agent is still speaking
      }
      
      if (yaWs && yaWs.readyState === WebSocket.OPEN && msg.media?.payload) {
        yaWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload
        }));
      }

    } else if (msg.event === "stop") {
      log("VOX", "Stop");
      cleanup("vox_stop");
    }
  });

  voxWs.on("close", (code) => {
    log("PROXY", `Vox dc: ${code}, in=${inputChunks} out=${outputChunks}`);
    stopSilenceTimer();
    if (yaWs && yaWs.readyState === WebSocket.OPEN) {
      yaWs.close(1000, "vox_closed");
    }
  });

  voxWs.on("error", (err) => {
    log("PROXY", `Vox error: ${err.message}`);
  });

  // ── Connect to Yandex and set up handlers ─────────────────
  try {
    yaWs = await connectYandex();
  } catch (err) {
    log("PROXY", `Failed to connect Yandex: ${err.message}`);
    voxWs.close(1011, "yandex_connect_failed");
    return;
  }

  // ── Send session.update to Yandex ─────────────────────────
  const sessionUpdate = {
    type: "session.update",
    session: {
      instructions: buildSystemPrompt(caller),
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: voxRate, channels: 1 },
          turn_detection: {
            type: "server_vad",
            threshold: VAD_THRESHOLD,
            silence_duration_ms: VAD_SILENCE_MS,
            prefix_padding_ms: VAD_PREFIX_PADDING_MS
          }
        },
        output: {
          format: { type: "audio/pcm", rate: voxRate },
          voice: VOICE,
          speed: VOICE_SPEED,   // OpenAI-compatible: 0.25–1.5
          role: VOICE_ROLE      // Yandex-specific: friendly, neutral, strict, good
        }
      },
      tools: TOOLS
    }
  };

  yaWs.send(JSON.stringify(sessionUpdate));
  log("PROXY", `session.update (rate=${voxRate})`);

  // ── Handle Yandex messages ────────────────────────────────
  yaWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const t = msg.type;

    // Session created/updated
    if (t === "session.created") {
      const sid = msg.session?.id?.slice(0, 12) || "?";
      log("PROXY", `Session: ${sid}`);

    } else if (t === "session.updated") {
      const toolCount = msg.session?.tools?.length || 0;
      log("PROXY", `Updated, tools=${toolCount}`);

    // ── Barge-in handler ──────────────────────────────────
    // With half-duplex, this rarely fires (input muted while agent speaks)
    // But keep as safety net for edge cases
    } else if (t === "input_audio_buffer.speech_started") {
      if (agentSpeaking) {
        log("PROXY", ">>> BARGE-IN (rare in half-duplex mode)");
        muteOutput = true;
      } else {
        log("PROXY", "Speech started");
      }
      agentSpeaking = false;

    } else if (t === "input_audio_buffer.speech_stopped") {
      log("PROXY", "Speech stopped");

    // Transcription of user speech
    } else if (t === "conversation.item.input_audio_transcription.completed") {
      const text = msg.transcript || "";
      if (text.trim()) log("USER", text.trim());

    // Agent text output (transcript of what agent is saying)
    } else if (t === "response.output_audio_transcript.delta") {
      process.stdout.write(msg.delta || "");

    } else if (t === "response.output_audio_transcript.done") {
      const text = msg.transcript || "";
      if (text.trim()) {
        console.log(""); // newline after deltas
        log("AGENT", text.trim());
      }

    // ── Agent audio output ──────────────────────────────────
    } else if (t === "response.output_audio.delta") {
      agentSpeaking = true;
      // Only forward audio if not muted (barge-in)
      if (!muteOutput && msg.delta) {
        sliceAndSendAudio(msg.delta);
      }

    // ── Response lifecycle ───────────────────────────────────
    } else if (t === "response.created") {
      agentSpeaking = true;
      muteOutput = false;  // new response = unmute

    } else if (t === "response.done") {
      agentSpeaking = false;
      muteOutput = false;  // reset mute
      log("PROXY", `Response done (out=${outputChunks})`);

    } else if (t === "response.cancelled") {
      agentSpeaking = false;
      muteOutput = false;
      log("PROXY", "Response CANCELLED (barge-in)");

    // ── Function calling ────────────────────────────────────
    } else if (t === "response.output_item.done") {
      const item = msg.item;
      if (item?.type === "function_call" && item.name && item.call_id) {
        let args = {};
        try {
          args = JSON.parse(item.arguments || "{}");
        } catch {}
        executeTool(item.name, args, item.call_id);
      }

    // ── Errors ──────────────────────────────────────────────
    } else if (t === "error") {
      log("PROXY", `Yandex error: ${JSON.stringify(msg.error)}`);

    // ── Rate limit ──────────────────────────────────────────
    } else if (t === "rate_limits.updated") {
      // ignore silently
    }
  });

  yaWs.on("close", (code) => {
    log("PROXY", `Ya dc: ${code}`);
    agentSpeaking = false;
    stopSilenceTimer();
    if (voxWs.readyState === WebSocket.OPEN) {
      voxWs.send(JSON.stringify({ event: "stop" }));
      voxWs.close(1000, "yandex_closed");
    }
  });

  yaWs.on("error", (err) => {
    log("PROXY", `Ya error: ${err.message}`);
  });
});

// ── Start server ────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[yandex-realtime-proxy v12.6] listening on :${PORT}`);
  console.log(`[config] voice=${VOICE} role=${VOICE_ROLE} speed=${VOICE_SPEED} vad_silence=${VAD_SILENCE_MS}ms vad_threshold=${VAD_THRESHOLD}`);
});
