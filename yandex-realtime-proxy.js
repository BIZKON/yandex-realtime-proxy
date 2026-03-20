// ============================================================
// yandex-realtime-proxy.js v2
// 
// WebSocket-прокси: Voximplant ↔ Yandex AI Studio Realtime API
//
// v2: silence frames чтобы медиа-мост Voximplant не рвался
// ============================================================

const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

// ==== Конфигурация ====
const PORT = process.env.PORT || 10000;

const YANDEX_API_KEY = process.env.YANDEX_API_KEY || "AQVN3AiYJ5UhCQtDCBHteaoaToa0DAauJ57diLhc";
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID || "b1g9u208dq4eqnt8rn3i";
const YANDEX_MODEL = `gpt://${YANDEX_FOLDER_ID}/speech-realtime-250923`;
const YANDEX_WS_URL = `wss://rest-assistant.api.cloud.yandex.net/v1/realtime/openai?model=${YANDEX_MODEL}`;
const YANDEX_HEADERS = { Authorization: `api-key ${YANDEX_API_KEY}` };

// Edge Functions URLs
const GET_SLOTS_URL = "https://nxtkthfhulkpaovilqlx.supabase.co/functions/v1/voice-agent-get-slots";
const CREATE_BOOKING_URL = "https://nxtkthfhulkpaovilqlx.supabase.co/functions/v1/voice-agent-create-booking";
const SEND_INFO_URL = "https://nxtkthfhulkpaovilqlx.supabase.co/functions/v1/voice-agent-send-info";

// Голос и аудио
const VOICE = process.env.YANDEX_VOICE || "kirill";
const AUDIO_RATE = 24000;

// Silence frame: 20ms тишины при 24kHz mono PCM16 = 480 samples * 2 bytes = 960 bytes
const SILENCE_FRAME = Buffer.alloc(960);

// ==== HTTP-сервер ====
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    service: "yandex-realtime-proxy",
    version: "2.0",
    yandex_model: YANDEX_MODEL,
    voice: VOICE,
  }));
});

// ==== WebSocket-сервер ====
const wss = new WebSocketServer({ server });

wss.on("connection", async (voxWs, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const callerPhone = url.searchParams.get("caller") || "unknown";
  const mode = url.searchParams.get("mode") || "inbound";
  const clientName = url.searchParams.get("name") || "";
  const prompt = url.searchParams.get("prompt") || "";

  console.log(`[PROXY] New connection: caller=${callerPhone} mode=${mode}`);

  let yandexWs = null;
  let yandexConnected = false;
  let silenceInterval = null;
  let gotFirstAudio = false;
  const audioBuffer = [];

  // ── Сразу начинаем слать тишину в Voximplant ──
  // Критично: без аудио-фреймов VoxEngine закрывает медиа-мост
  silenceInterval = setInterval(() => {
    if (voxWs.readyState === WebSocket.OPEN && !gotFirstAudio) {
      voxWs.send(SILENCE_FRAME);
    } else if (gotFirstAudio) {
      clearInterval(silenceInterval);
      silenceInterval = null;
    }
  }, 20);

  // Таймаут: остановить тишину через 10 секунд в любом случае
  const silenceTimeout = setTimeout(() => {
    if (silenceInterval) {
      clearInterval(silenceInterval);
      silenceInterval = null;
    }
  }, 10000);

  // ── Подключение к Яндексу ──
  try {
    yandexWs = new WebSocket(YANDEX_WS_URL, { headers: YANDEX_HEADERS });
  } catch (err) {
    console.error("[PROXY] Failed to create Yandex WS:", err.message);
    cleanup();
    voxWs.close(1011, "Yandex connection failed");
    return;
  }

  yandexWs.on("open", () => {
    console.log("[PROXY] Connected to Yandex Realtime API");
    yandexConnected = true;

    // Формируем контекст
    const today = new Date();
    const days = ["воскресенье","понедельник","вторник","среда","четверг","пятница","суббота"];
    const dateStr = today.toISOString().split("T")[0];
    const dayName = days[today.getDay()];

    let contextParts = [`Сегодня ${dateStr} (${dayName}).`];
    if (callerPhone !== "unknown") contextParts.push(`Номер клиента: ${callerPhone}.`);
    if (clientName) contextParts.push(`Клиента зовут ${clientName}.`);
    if (mode === "inbound") contextParts.push("Входящий звонок.");
    if (mode === "outbound") contextParts.push("Исходящий звонок.");

    const systemPrompt = prompt || (
      "Ты — Аврора, администратор студии массажа «Бохо Ритуал» в Санкт-Петербурге. " +
      "Твоя задача: записать клиента на приём, ответить на вопросы об услугах и ценах. " +
      "Отвечай кратко и дружелюбно. Говори естественно, как живой человек. " +
      "Первая фраза: «Студия Бохо, добрый день! Слушаю вас.» " +
      "Если клиент хочет записаться — используй функцию get_available_slots для проверки свободного времени, " +
      "затем book_appointment для создания записи. " +
      "Если клиент просит отправить информацию — используй send_info. " +
      "Если клиент хочет поговорить с администратором — используй forward_to_manager. " +
      contextParts.join(" ")
    );

    // session.update
    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions: systemPrompt,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: AUDIO_RATE, channels: 1 },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              silence_duration_ms: 400,
            },
          },
          output: {
            format: { type: "audio/pcm", rate: AUDIO_RATE },
            voice: VOICE,
          },
        },
        tools: [
          {
            type: "function",
            name: "get_available_slots",
            description: "Получить доступные слоты для записи на услугу массажа. Вызывай когда клиент хочет записаться.",
            parameters: {
              type: "object",
              properties: {
                service: { type: "string", description: "Название услуги" },
                date: { type: "string", description: "Дата в формате YYYY-MM-DD" },
              },
              required: ["service", "date"],
              additionalProperties: false,
            },
          },
          {
            type: "function",
            name: "book_appointment",
            description: "Создать запись клиента на услугу. Вызывай после подтверждения времени клиентом.",
            parameters: {
              type: "object",
              properties: {
                service: { type: "string" },
                date: { type: "string" },
                time: { type: "string" },
                client_name: { type: "string" },
              },
              required: ["service", "date", "time", "client_name"],
              additionalProperties: false,
            },
          },
          {
            type: "function",
            name: "send_info",
            description: "Отправить клиенту информацию по SMS или Telegram.",
            parameters: {
              type: "object",
              properties: {
                channel: { type: "string", enum: ["sms", "telegram"] },
                content_type: { type: "string", enum: ["price_list", "address", "booking_link"] },
                phone: { type: "string" },
              },
              required: ["channel", "content_type"],
              additionalProperties: false,
            },
          },
          {
            type: "function",
            name: "forward_to_manager",
            description: "Переключить звонок на живого администратора студии.",
            parameters: {
              type: "object",
              properties: {
                reason: { type: "string", description: "Причина перевода" },
              },
              required: ["reason"],
              additionalProperties: false,
            },
          },
        ],
      },
    };

    yandexWs.send(JSON.stringify(sessionUpdate));
    console.log("[PROXY] Sent session.update to Yandex");

    // Flush buffered audio
    while (audioBuffer.length > 0) {
      const pcm = audioBuffer.shift();
      sendAudioToYandex(pcm);
    }
  });

  // ── Voximplant → Яндекс (аудио) ──
  function sendAudioToYandex(pcmData) {
    if (yandexConnected && yandexWs && yandexWs.readyState === WebSocket.OPEN) {
      const b64 = pcmData.toString("base64");
      yandexWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
    }
  }

  voxWs.on("message", (data, isBinary) => {
    if (isBinary) {
      if (yandexConnected) {
        sendAudioToYandex(Buffer.from(data));
      } else {
        audioBuffer.push(Buffer.from(data));
      }
    } else {
      try {
        const cmd = JSON.parse(data.toString());
        console.log("[PROXY] VoxEngine cmd:", cmd.type || cmd.action || "unknown");
      } catch (e) {}
    }
  });

  // ── Яндекс → Voximplant ──
  yandexWs.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const msgType = msg.type;

      // Аудио от агента → binary PCM в Voximplant
      if (msgType === "response.output_audio.delta") {
        if (msg.delta && voxWs.readyState === WebSocket.OPEN) {
          if (!gotFirstAudio) {
            gotFirstAudio = true;
            if (silenceInterval) {
              clearInterval(silenceInterval);
              silenceInterval = null;
            }
          }
          const pcmBuf = Buffer.from(msg.delta, "base64");
          voxWs.send(pcmBuf);
        }
        return;
      }

      // Распознанный текст пользователя
      if (msgType === "conversation.item.input_audio_transcription.completed") {
        const transcript = msg.transcript || "";
        if (transcript) {
          console.log(`[USER] ${transcript}`);
          safeSendJson(voxWs, { type: "user_transcript", text: transcript });
        }
        return;
      }

      // Текст ответа агента
      if (msgType === "response.output_text.delta") {
        const delta = msg.delta || "";
        if (delta) console.log(`[AGENT] ${delta}`);
        return;
      }

      // Начало речи пользователя → прерывание
      if (msgType === "input_audio_buffer.speech_started") {
        console.log("[PROXY] Speech started — interruption");
        safeSendJson(voxWs, { type: "interruption" });
        return;
      }

      // Сессия создана
      if (msgType === "session.created") {
        const sid = (msg.session || {}).id;
        console.log(`[PROXY] Session created: ${sid}`);
        return;
      }

      // Сессия обновлена
      if (msgType === "session.updated") {
        const tools = (msg.session || {}).tools || [];
        console.log(`[PROXY] Session updated, tools: ${tools.length}`);
        safeSendJson(voxWs, { type: "session_ready", tools: tools.length });
        return;
      }

      // Function call завершён
      if (msgType === "response.output_item.done") {
        const item = msg.item || {};
        if (item.type === "function_call") {
          await handleFunctionCall(item, yandexWs, voxWs, callerPhone);
        }
        return;
      }

      // Ответ завершён — возобновляем тишину на паузу
      if (msgType === "response.done") {
        gotFirstAudio = false;
        if (!silenceInterval) {
          silenceInterval = setInterval(() => {
            if (voxWs.readyState === WebSocket.OPEN && !gotFirstAudio) {
              voxWs.send(SILENCE_FRAME);
            } else {
              clearInterval(silenceInterval);
              silenceInterval = null;
            }
          }, 20);
          setTimeout(() => {
            if (silenceInterval) {
              clearInterval(silenceInterval);
              silenceInterval = null;
            }
          }, 10000);
        }
        return;
      }

      // Ошибка
      if (msgType === "error") {
        console.error("[YANDEX ERROR]", JSON.stringify(msg, null, 2));
        return;
      }

      // Другие события
      if (!["response.created", "response.output_item.added",
           "response.content_part.added", "response.content_part.done",
           "input_audio_buffer.committed", "input_audio_buffer.commit",
           "conversation.item.created"].includes(msgType)) {
        console.log(`[YANDEX] ${msgType}`);
      }

    } catch (e) {
      console.error("[PROXY] Parse error:", e.message);
    }
  });

  // ── Function Calls ──
  async function handleFunctionCall(item, yWs, vWs, phone) {
    const callId = item.call_id;
    const funcName = item.name || "unknown";
    const argsText = item.arguments || "{}";

    let args = {};
    try { args = JSON.parse(argsText); } catch (e) { args = {}; }

    console.log(`[TOOL] ${funcName}(${JSON.stringify(args)})`);

    if (funcName === "forward_to_manager") {
      console.log("[TOOL] Forward to manager — sending to VoxEngine");
      safeSendJson(vWs, {
        type: "forward_to_manager",
        reason: args.reason || "Клиент попросил администратора",
        call_id: callId,
      });
      sendFunctionResult(yWs, callId, JSON.stringify({ status: "transferring", message: "Переключаю на администратора" }));
      return;
    }

    let url = "";
    let body = {};

    if (funcName === "get_available_slots") {
      url = GET_SLOTS_URL;
      body = { service: args.service, date: args.date };
    } else if (funcName === "book_appointment") {
      url = CREATE_BOOKING_URL;
      body = { service: args.service, date: args.date, time: args.time, client_name: args.client_name, client_phone: phone };
    } else if (funcName === "send_info") {
      url = SEND_INFO_URL;
      body = { channel: args.channel, content_type: args.content_type, phone: args.phone || phone };
    } else {
      console.log(`[TOOL] Unknown function: ${funcName}`);
      sendFunctionResult(yWs, callId, JSON.stringify({ error: "Unknown function" }));
      return;
    }

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await resp.text();
      console.log(`[TOOL] ${funcName} → ${resp.status}: ${result.substring(0, 200)}`);
      sendFunctionResult(yWs, callId, result);
    } catch (err) {
      console.error(`[TOOL] ${funcName} error:`, err.message);
      sendFunctionResult(yWs, callId, JSON.stringify({ error: err.message }));
    }
  }

  function sendFunctionResult(yWs, callId, output) {
    if (yWs && yWs.readyState === WebSocket.OPEN) {
      yWs.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: output },
      }));
      yWs.send(JSON.stringify({ type: "response.create" }));
      console.log(`[TOOL] Result sent, requested response.create`);
    }
  }

  function safeSendJson(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  function cleanup() {
    if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
    clearTimeout(silenceTimeout);
  }

  // ── Закрытие соединений ──
  voxWs.on("close", (code) => {
    console.log(`[PROXY] Voximplant disconnected: ${code}`);
    cleanup();
    if (yandexWs && yandexWs.readyState === WebSocket.OPEN) yandexWs.close();
  });

  yandexWs.on("close", (code, reason) => {
    console.log(`[PROXY] Yandex disconnected: ${code} ${reason || ""}`);
    cleanup();
    if (voxWs.readyState === WebSocket.OPEN) voxWs.close(code);
  });

  voxWs.on("error", (err) => {
    console.error("[PROXY] Voximplant WS error:", err.message);
    cleanup();
    if (yandexWs && yandexWs.readyState === WebSocket.OPEN) yandexWs.close();
  });

  yandexWs.on("error", (err) => {
    console.error("[PROXY] Yandex WS error:", err.message);
    cleanup();
    if (voxWs.readyState === WebSocket.OPEN) voxWs.close(1011, "Yandex error");
  });
});

// ==== Запуск ====
server.listen(PORT, () => {
  console.log(`[PROXY] Yandex Realtime proxy v2 running on port ${PORT}`);
  console.log(`[PROXY] Model: ${YANDEX_MODEL}`);
  console.log(`[PROXY] Voice: ${VOICE}`);
});
