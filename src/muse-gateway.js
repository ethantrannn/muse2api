// Client for a muse.ai agent VM: cookie-authenticated web API + Noise-encrypted WebSocket gateway.
import crypto from "node:crypto";
import WebSocket from "ws";
import { NoiseXXInitiator } from "./noise.js";
import { Writer, decode, first } from "./protobuf.js";

const MUSE_ORIGIN = "https://muse.ai";
const NOISE_WS_URL = "wss://hatch.metaaivm.com/v1/noise";
const APP_ID = "hatch-web";
const MAX_CHUNK_PAYLOAD = 65489;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SERVICE_DAEMON = 0;
const RESET_CANCELLED = 1;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

const textDecoder = new TextDecoder();

export class MuseApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// --- framing / envelopes -------------------------------------------------------

function encodeTransportFrames(data) {
  const chunkId = crypto.randomBytes(6).readUIntBE(0, 6);
  const total = Math.max(1, Math.ceil(data.length / MAX_CHUNK_PAYLOAD));
  const frames = [];
  for (let i = 0; i < total; i++) {
    const payload = data.subarray(i * MAX_CHUNK_PAYLOAD, (i + 1) * MAX_CHUNK_PAYLOAD);
    frames.push(new Writer().uint(1, chunkId).uint(2, i).uint(3, total).bytes(4, payload).finish());
  }
  return frames;
}

class FrameAssembler {
  #pending = new Map();

  push(frameBytes) {
    const f = decode(frameBytes);
    const id = first(f, 1) ?? 0n;
    const index = Number(first(f, 2) ?? 0n);
    const total = Number(first(f, 3) ?? 1n);
    const payload = first(f, 4) ?? Buffer.alloc(0);
    if (total === 1) return Buffer.from(payload);
    const parts = this.#pending.get(id) ?? new Map();
    parts.set(index, Buffer.from(payload));
    this.#pending.set(id, parts);
    if (parts.size < total) return null;
    this.#pending.delete(id);
    return Buffer.concat([...Array(total).keys()].map((i) => parts.get(i)));
  }
}

function encodeServiceFrame(streamId, kindField, kindBytes) {
  const frame = new Writer().uint(1, streamId).bytes(kindField, kindBytes).finish();
  return new Writer().uint(1, SERVICE_DAEMON).bytes(2, frame).finish();
}

function encodeRequest({ verb, path, headers, body }) {
  const w = new Writer().string(1, verb).string(2, path);
  for (const [key, value] of headers) w.bytes(3, new Writer().string(1, key).string(2, value).finish());
  return w.bytes(4, body).bool(5, true).finish();
}

function decodeServiceResponse(bytes) {
  const frame = decode(first(decode(bytes), 1));
  const streamId = first(frame, 1) ?? 0n;
  if (frame[3]) {
    const r = decode(frame[3][0]);
    const headers = (r[2] ?? []).map((h) => {
      const hf = decode(h);
      return [String(first(hf, 1) ?? ""), String(first(hf, 2) ?? "")];
    });
    return {
      kind: "response",
      streamId,
      status: Number(first(r, 1) ?? 0n),
      headers,
      body: first(r, 3) ?? Buffer.alloc(0),
      endBody: first(r, 4) === 1n,
    };
  }
  if (frame[4]) {
    const c = decode(frame[4][0]);
    return { kind: "bodyChunk", streamId, body: first(c, 1) ?? Buffer.alloc(0), endBody: first(c, 2) === 1n };
  }
  if (frame[5]) {
    const r = decode(frame[5][0]);
    return { kind: "reset", streamId, code: Number(first(r, 1) ?? 0n), reason: String(first(r, 2) ?? "") };
  }
  return { kind: "unknown", streamId };
}

/** Gateway JSON bodies are either raw results or `{ ok, result | error }` envelopes. */
function unwrap(value, status) {
  if (value && typeof value === "object" && "ok" in value) {
    if (value.ok === false) {
      const err = value.error;
      throw new MuseApiError(typeof err === "string" ? err : err?.message ?? JSON.stringify(err), status);
    }
    if ("result" in value) return value.result;
  }
  return value;
}

// --- connection ----------------------------------------------------------------

class NoiseConnection {
  #ws;
  #send;
  #recv;
  #assembler = new FrameAssembler();
  #nextStreamId = 1n;
  #streams = new Map();
  closed = false;

  constructor(ws, send, recv) {
    this.#ws = ws;
    this.#send = send;
    this.#recv = recv;
    ws.on("message", (data) => this.#onMessage(data));
    ws.on("close", () => this.#fail(new Error("Muse gateway connection closed")));
    ws.on("error", (err) => this.#fail(err));
  }

  static async open(url) {
    const ws = new WebSocket(url, { headers: { Origin: MUSE_ORIGIN, "User-Agent": USER_AGENT } });
    const queue = [];
    let waiter = null;
    const onMessage = (data) => (waiter ? (waiter(Buffer.from(data)), (waiter = null)) : queue.push(Buffer.from(data)));
    const nextMessage = () =>
      new Promise((resolve, reject) => {
        if (queue.length) return resolve(queue.shift());
        const timer = setTimeout(() => reject(new Error("Noise handshake timeout")), HANDSHAKE_TIMEOUT_MS);
        waiter = (m) => (clearTimeout(timer), resolve(m));
      });

    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) =>
        reject(new MuseApiError(`Muse gateway rejected WebSocket: HTTP ${res.statusCode}`, 502))
      );
    });
    ws.on("message", onMessage);

    const noise = new NoiseXXInitiator();
    const clientNonce = crypto.randomBytes(32);
    ws.send(noise.writeMessage1(new Writer().bytes(1, clientNonce).finish()));
    const msg2Payload = noise.readMessage2(await nextMessage());
    if (isRvChallenge(msg2Payload)) {
      ws.close();
      throw new MuseApiError("Confidential (CVM) agents need a recovery-key proof, which muse2api does not support", 501);
    }
    ws.send(noise.writeMessage3());
    const [send, recv] = noise.split();
    ws.off("message", onMessage);
    return new NoiseConnection(ws, send, recv);
  }

  #fail(err) {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.#streams.values()) s.onError(err);
    this.#streams.clear();
    try {
      this.#ws.close();
    } catch {}
  }

  close() {
    this.#fail(new Error("Muse gateway connection closed by client"));
  }

  #onMessage(data) {
    let frame;
    try {
      const plain = this.#assembler.push(this.#recv.decrypt(Buffer.alloc(0), Buffer.from(data)));
      if (!plain) return;
      frame = decodeServiceResponse(plain);
    } catch (err) {
      return this.#fail(err);
    }
    this.#streams.get(frame.streamId)?.onFrame(frame);
  }

  #write(serviceBytes) {
    for (const f of encodeTransportFrames(serviceBytes)) this.#ws.send(this.#send.encrypt(Buffer.alloc(0), f));
  }

  /**
   * Send one HTTP-over-Noise request. `handlers.onResponse(status, headers)`,
   * `handlers.onBody(chunk, endBody)` and `handlers.onError(err)` receive the stream.
   * Returns a cancel function that resets the stream.
   */
  open({ verb = "POST", path, json }, handlers) {
    if (this.closed) throw new Error("Muse gateway connection is closed");
    const streamId = this.#nextStreamId++;
    const body = json === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(json));
    const headers = [
      ...(json === undefined ? [] : [["Content-Type", "application/json"]]),
      ["x-request-id", crypto.randomUUID()],
      ["x-app-id", APP_ID],
      ["Accept-Language", "en-US"],
      ["Accept-Encoding", "identity"],
    ];
    const done = () => this.#streams.delete(streamId);
    this.#streams.set(streamId, {
      onError: (err) => (done(), handlers.onError(err)),
      onFrame: (frame) => {
        if (frame.kind === "response" || frame.kind === "bodyChunk") {
          if (frame.endBody) done();
          if (frame.kind === "response") handlers.onResponse?.(frame.status, frame.headers);
          handlers.onBody(frame.body, frame.endBody);
        } else if (frame.kind === "reset") {
          done();
          handlers.onError(new MuseApiError(`Muse gateway reset stream: ${frame.reason || frame.code}`, 502));
        }
      },
    });
    this.#write(encodeServiceFrame(streamId, 2, encodeRequest({ verb, path, headers, body })));
    return () => {
      if (!this.#streams.has(streamId) || this.closed) return;
      done();
      const reset = new Writer().uint(1, RESET_CANCELLED).string(2, "client cancelled").finish();
      this.#write(encodeServiceFrame(streamId, 5, reset));
    };
  }

  /** Unary JSON request. */
  request(path, json, { verb = "POST", timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      const parts = [];
      let status = 0;
      const timer = setTimeout(() => (cancel(), reject(new MuseApiError(`Muse request timed out: ${path}`, 504))), timeoutMs);
      const cancel = this.open(
        { verb, path, json },
        {
          onResponse: (s) => (status = s),
          onError: (err) => (clearTimeout(timer), reject(err)),
          onBody: (chunk, end) => {
            parts.push(chunk);
            if (!end) return;
            clearTimeout(timer);
            const text = textDecoder.decode(Buffer.concat(parts));
            let value;
            try {
              value = text ? JSON.parse(text) : null;
            } catch {
              value = text;
            }
            try {
              if (status >= 400) throw new MuseApiError(`Muse ${path} failed (${status}): ${text.slice(0, 300)}`, status);
              resolve(unwrap(value, status));
            } catch (err) {
              reject(err);
            }
          },
        }
      );
    });
  }

  /**
   * Subscription-style request: the body is NDJSON. Calls onRecord for each
   * parsed line until the stream ends or the returned cancel() is called.
   */
  subscribe(path, json, { onRecord, onEnd, onError }) {
    let pending = "";
    let status = 0;
    return this.open(
      { path, json },
      {
        onResponse: (s) => (status = s),
        onError,
        onBody: (chunk, end) => {
          pending += textDecoder.decode(chunk, { stream: !end });
          const lines = pending.split("\n");
          pending = end ? "" : lines.pop();
          if (status >= 400) {
            if (end) onError(new MuseApiError(`Muse ${path} failed (${status}): ${lines.join("\n").slice(0, 300)}`, status));
            return;
          }
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              onRecord(JSON.parse(line));
            } catch (err) {
              return onError(err);
            }
          }
          if (end) onEnd?.();
        },
      }
    );
  }
}

/** Message 2 of a confidential VM carries an RV challenge (fields 2 = state, 3 = vm nonce). */
function isRvChallenge(payload) {
  try {
    const f = decode(payload);
    return f[2] != null && f[3]?.[0]?.length === 32;
  } catch {
    return false;
  }
}

// --- public client -----------------------------------------------------------------

export class MuseGateway {
  #cookies;
  #connection = null;
  #connecting = null;

  constructor({ cookies }) {
    if (!cookies) throw new Error("MUSE_COOKIES is required (run `npm run import-cookies`)");
    this.#cookies = cookies;
  }

  async #web(path, init = {}) {
    const res = await fetch(MUSE_ORIGIN + path, {
      ...init,
      headers: {
        Cookie: this.#cookies,
        Origin: MUSE_ORIGIN,
        Referer: MUSE_ORIGIN + "/",
        "User-Agent": USER_AGENT,
        Accept: "*/*",
        // muse.ai's API rejects state-changing requests that don't look same-origin.
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? " (muse.ai cookies expired? run `npm run import-cookies`)" : "";
      throw new MuseApiError(`muse.ai ${path} failed: HTTP ${res.status}${hint} ${text.slice(0, 200)}`, res.status === 401 ? 401 : 502);
    }
    return JSON.parse(text);
  }

  async #connect() {
    const session = await this.#web("/api/session?vm_state=live");
    if (!session?.vm_id || !session?.endpoint_url) {
      throw new MuseApiError(`No muse.ai agent VM is assigned (status: ${session?.status})`, 503);
    }
    if (session.vm_state && session.vm_state !== "RUNNING") {
      await this.#web("/api/hatch/vm/wake", { method: "POST", body: JSON.stringify({}) }).catch(() => {});
    }
    const creds = await this.#web("/api/hatch/token", {
      method: "POST",
      body: JSON.stringify({ vmAddress: session.endpoint_url, vmName: session.vm_name }),
    });
    const params = new URLSearchParams({ vm_id: session.vm_id, auth_token: creds.token });
    if (creds.notary_token) params.set("notary_token", creds.notary_token);
    params.set("app_id", APP_ID);
    params.set("request_id", crypto.randomUUID());
    return NoiseConnection.open(`${NOISE_WS_URL}?${params}`);
  }

  /** Shared, lazily (re)established gateway connection. */
  async connection() {
    if (this.#connection && !this.#connection.closed) return this.#connection;
    this.#connecting ??= this.#connect().finally(() => (this.#connecting = null));
    this.#connection = await this.#connecting;
    return this.#connection;
  }

  async request(path, json, opts) {
    return (await this.connection()).request(path, json, opts);
  }

  async subscribe(path, json, handlers) {
    return (await this.connection()).subscribe(path, json, handlers);
  }

  close() {
    this.#connection?.close();
  }
}
