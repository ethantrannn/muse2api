#!/usr/bin/env node
// OpenAI-compatible HTTP server in front of the muse.ai agent.
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { MuseGateway } from "./muse-gateway.js";
import { messagesToPrompt, runSideChatTurn } from "./muse-chat.js";

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "..", ".env"));
} catch {}

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const API_KEY = process.env.API_KEY ?? "";
const MODEL_ID = process.env.MUSE_MODEL_ID ?? "muse";
const TIMEOUT_MS = Number(process.env.MUSE_TIMEOUT_MS ?? 10 * 60 * 1000);
const TIMEZONE = process.env.MUSE_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const KEEP_SIDECHATS = process.env.MUSE_KEEP_SIDECHATS === "true";

const gateway = new MuseGateway({ cookies: process.env.MUSE_COOKIES });

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendError(res, status, message, type = "api_error") {
  if (res.headersSent) return res.end();
  sendJson(res, status, { error: { message, type, code: status } });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function chatCompletions(req, res) {
  const body = await readJson(req);
  const prompt = messagesToPrompt(body.messages);
  if (!prompt) return sendError(res, 400, "messages must contain at least one text message", "invalid_request_error");

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model ?? MODEL_ID;
  const abort = new AbortController();
  res.on("close", () => !res.writableFinished && abort.abort());
  const opts = { signal: abort.signal, timeoutMs: TIMEOUT_MS, timezone: TIMEZONE, keepSideChat: KEEP_SIDECHATS };

  if (!body.stream) {
    const { text } = await runSideChatTurn(gateway, prompt, opts);
    return sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  const chunk = (delta, finish_reason = null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(chunk({ role: "assistant", content: "" }));
  try {
    await runSideChatTurn(gateway, prompt, { ...opts, onText: (text) => res.write(chunk({ content: text })) });
    res.write(chunk({}, "stop"));
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: { message: err.message, type: "api_error", code: err.status ?? 502 } })}\n\n`);
  }
  res.end("data: [DONE]\n\n");
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  const url = new URL(req.url, "http://localhost");
  const route = url.pathname.replace(/^\/v1/, "");
  if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) {
    return sendError(res, 401, "Invalid API key", "authentication_error");
  }
  try {
    if (req.method === "GET" && route === "/models") {
      return sendJson(res, 200, { object: "list", data: [{ id: MODEL_ID, object: "model", created: 0, owned_by: "muse.ai" }] });
    }
    if (req.method === "POST" && route === "/chat/completions") return await chatCompletions(req, res);
    if (req.method === "GET" && (route === "/" || route === "/health")) return sendJson(res, 200, { ok: true });
    sendError(res, 404, `Unknown route ${req.method} ${url.pathname}`, "invalid_request_error");
  } catch (err) {
    console.error(`[muse2api] ${req.method} ${url.pathname}:`, err.message);
    sendError(res, err instanceof SyntaxError ? 400 : err.status ?? 502, err.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`muse2api listening on http://${HOST}:${PORT}/v1 (model: ${MODEL_ID})`);
});
