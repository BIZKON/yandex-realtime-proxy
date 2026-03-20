// ============================================================
// yandex-realtime-proxy.js
// 
// WebSocket-прокси: Voximplant ↔ Yandex AI Studio Realtime API
//
// Voximplant шлёт binary PCM 16kHz → прокси → base64 JSON → Яндекс
// Яндекс шлёт response.output_audio.delta (base64) → прокси → binary PCM → Voximplant
//
// Function calls: прокси перехватывает, вызывает Edge Functions,
// возвращает результат в Яндекс.
// forward_to_manager: прокси отправляет JSON-событие в Voximplant,
// VoxEngine делает PSTN-перевод.
// ============================================================

const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

// ==== Конфигурация ====
const PORT = process.env.PORT || 3100;

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
const AUDIO_RATE = 24000; // Яндекс работает на 24kHz

// ==== HTTP-сервер ====
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    service: "yandex-realtime-proxy",
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
  const audioBuffer = [];

  // ── Подключение к Яндексу ──
  try {
    yandexWs = new WebSocket(YANDEX_WS_URL, { headers: YANDEX_HEADERS });
  } catch (err) {
    console.error("[PROXY] Failed to create Yandex WS:", err.message);
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
      // Binary PCM from Voximplant → base64 JSON to Yandex
      if (yandexConnected) {
        sendAudioToYandex(Buffer.from(data));
      } else {
        audioBuffer.push(Buffer.from(data));
      }
    } else {
      // Text message from VoxEngine (JSON commands)
      try {
        const cmd = JSON.parse(data.toString());
        console.log("[PROXY] VoxEngine cmd:", cmd.type || cmd.action);
        // Could handle contextualUpdate or other commands here
      } catch (e) {
        // Ignore non-JSON text
      }
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
          // Отправляем в VoxEngine для логирования
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

      // Начало речи пользователя → очистить аудио-буфер
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

      // Ошибка
      if (msgType === "error") {
        console.error("[YANDEX ERROR]", JSON.stringify(msg, null, 2));
        return;
      }

      // Другие события — логируем
      if (!["response.created", "response.done", "response.output_item.added",
           "response.content_part.added", "response.content_part.done",
           "input_audio_buffer.committed", "input_audio_buffer.commit",
           "conversation.item.created"].includes(msgType)) {
        console.log(`[YANDEX] ${msgType}`);
      }

    } catch (e) {
      console.error("[PROXY] Parse error:", e.message);
    }
  });

  // ── Обработка Function Calls ──
  async function handleFunctionCall(item, yWs, vWs, phone) {
    const callId = item.call_id;
    const funcName = item.name || (item.function || {}).name || "unknown";
    const argsText = item.arguments || "{}";

    let args = {};
    try { args = JSON.parse(argsText); } catch (e) { args = {}; }

    console.log(`[TOOL] ${funcName}(${JSON.stringify(args)})`);

    // forward_to_manager — отправляем в VoxEngine
    if (funcName === "forward_to_manager") {
      console.log("[TOOL] Forward to manager — sending to VoxEngine");
      safeSendJson(vWs, {
        type: "forward_to_manager",
        reason: args.reason || "Клиент попросил администратора",
        call_id: callId,
      });
      // Возвращаем результат в Яндекс
      sendFunctionResult(yWs, callId, JSON.stringify({ status: "transferring", message: "Переключаю на администратора" }));
      return;
    }

    // Остальные функции — HTTP к Edge Functions
    let url = "";
    let body = {};

    if (funcName === "get_available_slots") {
      url = GET_SLOTS_URL;
      body = { service: args.service, date: args.date };
    } else if (funcName === "book_appointment") {
      url = CREATE_BOOKING_URL;
      body = {
        service: args.service,
        date: args.date,
        time: args.time,
        client_name: args.client_name,
        client_phone: phone,
      };
    } else if (funcName === "send_info") {
      url = SEND_INFO_URL;
      body = {
        channel: args.channel,
        content_type: args.content_type,
        phone: args.phone || phone,
      };
    } else {
      console.log(`[TOOL] Unknown function: ${funcName}`);
      sendFunctionResult(yWs, callId, JSON.stringify({ error: "Unknown function" }));
      return;
    }

    // Вызов Edge Function
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
      // 1. Отправляем результат
      yWs.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: output,
        },
      }));
      // 2. Запрашиваем продолжение ответа
      yWs.send(JSON.stringify({ type: "response.create" }));
      console.log(`[TOOL] Result sent, requested response.create`);
    }
  }

  function safeSendJson(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  // ── Закрытие соединений ──
  voxWs.on("close", (code, reason) => {
    console.log(`[PROXY] Voximplant disconnected: ${code}`);
    if (yandexWs && yandexWs.readyState === WebSocket.OPEN) yandexWs.close();
  });

  yandexWs.on("close", (code, reason) => {
    console.log(`[PROXY] Yandex disconnected: ${code} ${reason || ""}`);
    if (voxWs.readyState === WebSocket.OPEN) voxWs.close(code);
  });

  voxWs.on("error", (err) => {
    console.error("[PROXY] Voximplant WS error:", err.message);
    if (yandexWs && yandexWs.readyState === WebSocket.OPEN) yandexWs.close();
  });

  yandexWs.on("error", (err) => {
    console.error("[PROXY] Yandex WS error:", err.message);
    if (voxWs.readyState === WebSocket.OPEN) voxWs.close(1011, "Yandex error");
  });
});

// ==== Запуск ====
server.listen(PORT, () => {
  console.log(`[PROXY] Yandex Realtime proxy running on port ${PORT}`);
  console.log(`[PROXY] Model: ${YANDEX_MODEL}`);
  console.log(`[PROXY] Voice: ${VOICE}`);
});
