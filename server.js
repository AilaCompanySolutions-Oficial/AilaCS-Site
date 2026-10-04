import "dotenv/config";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3000);
const models = ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-flash-latest", "gemini-3.6-flash"];
const geminiTimeoutMs = 45000;
const maxRequestBytes = 16 * 1024;
const requestWindowMs = 60 * 1000;
const maxRequestsPerWindow = 20;
const requestLog = new Map();
const publicFiles = new Set([
  "index.html",
  "aila-brand-visual.svg",
  "AilaCompanySolutionsLOGO-removebg-preview.png",
  "ChatGPT Image 6 de set. de 2026, 19_24_31.png",
  "photo-1737365505612-7ff3ef8f7970.webp"
]);
const systemPrompt = await readFile(path.join(directory, "aila-system-prompt.md"), "utf8");
const knowledgeBase = await readFile(path.join(directory, "aila-knowledge-base.md"), "utf8");

const send = (response, status, body, type = "application/json; charset=utf-8") => {
  response.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
};

const assistantPrompt = `${systemPrompt}\n\n${knowledgeBase}`;

const handleAssistant = async (request, response) => {
  const clientAddress = request.headers["x-forwarded-for"]?.split(",")[0].trim() || request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recentRequests = (requestLog.get(clientAddress) || []).filter((timestamp) => now - timestamp < requestWindowMs);
  if (recentRequests.length >= maxRequestsPerWindow) {
    send(response, 429, { error: "Limite temporário de perguntas atingido. Tente novamente em um minuto." });
    return;
  }
  recentRequests.push(now);
  requestLog.set(clientAddress, recentRequests);

  if (!process.env.GEMINI_API_KEY) {
    send(response, 503, { error: "Configure GEMINI_API_KEY no arquivo .env antes de usar o assistente." });
    return;
  }

  let rawBody = "";
  for await (const chunk of request) {
    rawBody += chunk;
    if (Buffer.byteLength(rawBody, "utf8") > maxRequestBytes) {
      send(response, 413, { error: "A pergunta excede o limite permitido." });
      request.destroy();
      return;
    }
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    send(response, 400, { error: "O corpo da requisição precisa ser JSON válido." });
    return;
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > 2000) {
    send(response, 400, { error: "Envie uma pergunta com até 2000 caracteres." });
    return;
  }

  try {
    const requestBody = {
      systemInstruction: { parts: [{ text: assistantPrompt }] },
      contents: [{ role: "user", parts: [{ text: message }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 500 }
    };

    let lastError = "A API do Gemini não retornou uma resposta.";
    for (const model of models) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), geminiTimeoutMs);
      let apiResponse;
      try {
        apiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }
      let data = {};
      try {
        const rawText = await apiResponse.text();
        if (rawText) {
          data = JSON.parse(rawText);
        }
      } catch {
        data = {};
      }

      const answer = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (apiResponse.ok && answer) {
        send(response, 200, { answer });
        return;
      }
      lastError = data.error?.message || lastError;
      if (![404, 429, 500, 503].includes(apiResponse.status)) break;
    }
    send(response, 503, { error: "O assistente está temporariamente indisponível. Tente novamente em alguns instantes." });
  } catch (error) {
    const message = error.name === "TimeoutError" || error.name === "AbortError"
      ? "O assistente demorou para responder. Tente novamente."
      : "Não foi possível conectar ao assistente agora. Tente novamente em alguns instantes.";
    send(response, 503, { error: message });
  }
};

const serveSite = async (request, response) => {
  const requestedPath = request.url === "/" ? "/index.html" : request.url;
  const fileName = decodeURIComponent(requestedPath.split("?")[0]).replace(/^\/+/, "");
  if (!publicFiles.has(fileName)) {
    send(response, 404, { error: "Arquivo não encontrado." });
    return;
  }

  try {
    const filePath = path.join(directory, fileName);
    const content = await readFile(filePath);
    const extension = path.extname(filePath);
    const types = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".js": "text/javascript; charset=utf-8" };
    send(response, 200, content, types[extension] || "application/octet-stream");
  } catch {
    send(response, 404, { error: "Arquivo não encontrado." });
  }
};

http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    send(response, 204, "");
    return;
  }
  if (request.method === "POST" && request.url === "/api/assistant") {
    await handleAssistant(request, response);
    return;
  }
  if (request.method === "GET") {
    await serveSite(request, response);
    return;
  }
  send(response, 405, { error: "Método não permitido." });
}).listen(port, host, () => {
  console.log(`Aila Site disponível em http://${host}:${port}`);
  console.log(`Ngrok pode apontar para http://localhost:${port}`);
});
