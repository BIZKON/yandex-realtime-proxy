// ============================================================
// yandex-realtime-proxy.js v12.1
//
// FIXES vs v12:
// - Removed response.cancel on barge-in (Yandex error: illegal in USER_SPEAKING state)
// - Yandex handles barge-in internally; proxy just mutes audio forwarding
// FIXES vs v11:
// 1. VAD: silence_duration_ms 400→800, threshold 0.5→0.6
// 2. Barge-in: muteOutput flag stops audio forwarding on speech_started
// 3. end_call tool: agent can terminate the call
// 4. Configurable voice via env (YANDEX_VOICE)
// 5. Better logging with timestamps
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
const SYSTEM_PROMPT = `Ты — Аврора, администратор студии массажа «Бохо Ритуал» в Санкт-Петербурге.

Твои задачи:
- Записать клиента на массаж
- Рассказать об услугах и ценах
- Ответить на вопросы о студии

Правила:
- Говори дружелюбно, тепло, кратко
- Не придумывай цены и услуги — если не знаешь, скажи что уточнишь
- Используй инструмент get_available_slots для проверки свободного времени
- Используй инструмент book_appointment для записи
- Используй инструмент send_info для отправки информации клиенту в Telegram
- Когда клиент прощается или говорит что вопросов нет — попрощайся и вызови end_call

Сегодня: ${new Date().toLocaleDateString("ru-RU", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.
Номер студии: +7 901 132 03 07.
Адрес: Санкт-Петербург (уточни у менеджера точный адрес).`;

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
    description: "Записать клиента на массаж. Вызывай только после подтверждения клиентом даты, времени и услуги.",
    parameters: {
      type: "object",
      properties: {
        datetime: {
          type: "string",
          description: "Дата и время записи в формате YYYY-MM-DDTHH:MM"
        },
        service_id: {
          type: "string",
          description: "ID услуги"
        },
        client_name: {
          type: "string",
          description: "Имя клиента"
        },
        client_phone: {
          type: "string",
          description: "Телефон клиента"
        }
      },
      required: ["datetime", "service_id"]
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
  res.end(JSON.stringify({ status: "ok", version: "12.1", voice: VOICE }));
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
  let pendingAudioQueue = [];     // FIX #2: queue for outgoing audio frames

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
    outputChunks++;
  }

  // ── Execute tool call (Edge Functions) ────────────────────
  async function executeTool(name, args, callId) {
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
            datetime: args.datetime,
            service_id: args.service_id,
            client_name: args.client_name,
            client_phone: args.client_phone
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
        // FIX #3: Agent explicitly ends the call
        log("PROXY", `end_call requested: ${args.reason}`);
        // Give Yandex 1 second to finish speaking, then close
        setTimeout(() => {
          if (voxWs.readyState === WebSocket.OPEN) {
            voxWs.send(JSON.stringify({
              event: "command",
              command: { type: "end_call", reason: args.reason }
            }));
          }
          // Close connections after a brief delay for final audio
          setTimeout(() => {
            cleanup("end_call");
          }, 2000);
        }, 1500);
        result = { success: true, message: "Звонок завершается" };
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
  function cleanup(reason) {
    log("PROXY", `Cleanup: ${reason}`);
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
      instructions: SYSTEM_PROMPT,
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
          voice: VOICE
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

    // ── FIX #2: Barge-in ──────────────────────────────────
    // Yandex handles barge-in internally (unlike OpenAI which needs response.cancel)
    // We just stop forwarding agent audio to VoxEngine so user hears silence
    } else if (t === "input_audio_buffer.speech_started") {
      if (agentSpeaking) {
        log("PROXY", ">>> BARGE-IN: muting agent audio");
        muteOutput = true;  // stop forwarding remaining audio from current response
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
  console.log(`[yandex-realtime-proxy v12.1] listening on :${PORT}`);
  console.log(`[config] voice=${VOICE} vad_silence=${VAD_SILENCE_MS}ms vad_threshold=${VAD_THRESHOLD}`);
});
