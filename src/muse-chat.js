// One chat turn on the muse.ai agent, always in a fresh side chat so the
// main chat's long context is never reused.
import crypto from "node:crypto";
import { MuseApiError } from "./muse-gateway.js";

const CAPABILITIES = ["delta_stream", "chat_cancel"];
const USAGE_LINE = /\n*\[usage\][^\n]*$/;

function deleteSideChat(gateway, sessionId) {
  return gateway
    .request("/session/delete", { method: "/api/session/delete", session_id: sessionId })
    .catch((err) => console.error(`[muse2api] failed to delete side chat ${sessionId}: ${err.message}`));
}

/**
 * Send `message` in a new side chat and stream the reply.
 * `onText(delta)` receives assistant text; resolves with the full text.
 * The side chat is deleted afterwards unless `keepSideChat` is set.
 */
export async function runSideChatTurn(gateway, message, { keepSideChat = false, ...opts } = {}) {
  let sessionId = null;
  try {
    return await streamSideChatTurn(gateway, message, (id) => (sessionId = id), opts);
  } finally {
    // Not awaited: the reply is already complete, so cleanup shouldn't delay the response.
    if (sessionId && !keepSideChat) void deleteSideChat(gateway, sessionId);
  }
}

async function streamSideChatTurn(gateway, message, onSession, { onText = () => {}, signal, timeoutMs, timezone } = {}) {
  const sessionId = crypto.randomUUID();
  onSession(sessionId);
  await new Promise((resolve, reject) => {
    gateway
      .subscribe(
        "/chat/stream",
        { message, session_id: sessionId, capabilities: CAPABILITIES, ...(timezone && { timezone }) },
        { onRecord: resolve, onError: reject, onEnd: resolve }
      )
      .catch(reject);
  });

  let text = "";
  let lastMessageId = null;
  return new Promise((resolve, reject) => {
    let cancelSub = () => {};
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      cancelSub();
      err ? reject(err) : resolve({ text: text.replace(USAGE_LINE, ""), sessionId });
    };
    const onAbort = () => {
      // Stop the agent before the side chat gets deleted.
      gateway
        .request("/chat/cancel", { session_id: sessionId })
        .catch(() => {})
        .then(() => finish(new MuseApiError("Request cancelled by client", 499)));
    };
    const timer = setTimeout(() => finish(new MuseApiError("Muse reply timed out", 504)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    const emit = (delta) => {
      if (!delta) return;
      text += delta;
      onText(delta);
    };

    gateway
      .subscribe(
        "/chat/subscribe",
        { session_id: sessionId, capabilities: CAPABILITIES, after_stream_seq: 0, after_chat_event_seq: 0 },
        {
          onRecord: (record) => {
            const p = record.payload ?? {};
            if (record.type !== "event" || (p.session_id && p.session_id !== sessionId)) return;
            if (record.event === "delta.text_append") {
              // Separate consecutive assistant messages of the same turn.
              if (lastMessageId && p.message_id !== lastMessageId && text) emit("\n\n");
              lastMessageId = p.message_id;
              emit(String(p.text ?? "").replace(USAGE_LINE, ""));
            } else if (record.event === "task.status" && p.status && p.status !== "running") {
              if (p.status === "completed") finish();
              else finish(new MuseApiError(`Muse task ${p.status}`, 502));
            }
          },
          onEnd: () => finish(new MuseApiError("Muse subscription ended before the reply completed", 502)),
          onError: (err) => finish(err),
        }
      )
      .then((cancel) => (settled ? cancel() : (cancelSub = cancel)), finish);
  });
}

/** Flatten an OpenAI `messages` array into one prompt for a fresh side chat. */
export function messagesToPrompt(messages) {
  const contentText = (content) =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).filter(Boolean).join("\n")
        : "";
  const turns = (messages ?? [])
    .map((m) => ({ role: m.role === "developer" ? "system" : m.role, text: contentText(m.content).trim() }))
    .filter((m) => m.text);
  if (turns.length === 1 && turns[0].role === "user") return turns[0].text;
  const label = { system: "System", user: "User", assistant: "Assistant", tool: "Tool" };
  return turns.map((m) => `[${label[m.role] ?? m.role}]\n${m.text}`).join("\n\n");
}
