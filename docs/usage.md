# muse2api

Local OpenAI-compatible API for the muse.ai agent.

## How muse.ai talks to its server

1. The web app (Next.js) uses cookie-authenticated HTTP endpoints on `https://muse.ai`:
   - `GET /api/session?vm_state=live` returns the user's agent VM (`vm_id`, `vm_name`, `endpoint_url`).
   - `POST /api/hatch/token {vmAddress, vmName}` returns `token` (VM auth token) and `notary_token`.
2. Chat traffic goes over one WebSocket to `wss://hatch.metaaivm.com/v1/noise?vm_id=…&auth_token=…&notary_token=…&app_id=hatch-web&request_id=…`,
   end-to-end encrypted with **Noise_XX_25519_AESGCM_SHA256**:
   - msg1 payload = protobuf `{1: client_nonce(32 bytes)}`
   - msg2 payload = VM attestation (a confidential VM also sends an RV challenge, which needs a recovery-key proof and is not supported here)
   - msg3 payload = empty for standard VMs
3. After the handshake, every WebSocket binary message is one AES-GCM frame (empty AD, counter nonce) holding
   `NoiseTransportFrame{chunk_id, chunk_index, total_chunks, payload}` → `ServiceRequest{service=DAEMON, payload}` →
   `ServiceFrame{stream_id, request|response|body_chunk|reset}`. Requests are HTTP-like
   (`verb`, `path`, `headers`, JSON `body`); responses stream as body chunks.
4. Chat RPCs (JSON):
   - `POST /chat/stream {message, session_id, capabilities}` sends a message and returns an ack. A new random
     `session_id` creates a new **side chat**.
   - `POST /chat/subscribe {session_id, after_stream_seq, after_chat_event_seq, capabilities}` returns NDJSON events:
     `delta.message_start`, `delta.text_append {text}`, `delta.message_done`, `task.status {status}`.
   - `POST /chat/cancel {session_id}` stops a running turn.

## Setup

```bash
npm install
# In Chrome: open chrome://inspect/#remote-debugging and enable remote debugging,
# make sure you are logged in to muse.ai, then approve the prompt this triggers:
npm run import-cookies
npm start            # http://127.0.0.1:8787/v1
```

Re-run `npm run import-cookies` when requests fail with 401/403 (expired muse.ai session).

## API

- `GET /v1/models`
- `POST /v1/chat/completions` (supports `stream: true`)

Every request runs in a **new side chat**, so the main chat's long context is never used. The side chat is deleted
(`POST /session/delete {method: "/api/session/delete", session_id}`) once the reply finishes, fails, or the client
disconnects; set `MUSE_KEEP_SIDECHATS=true` to keep them. The OpenAI `messages`
array is flattened into one prompt (`[System]`, `[User]`, `[Assistant]` sections). A single user message is sent as is.
Token usage is not reported (always 0).

```bash
curl http://127.0.0.1:8787/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"muse","stream":true,"messages":[{"role":"user","content":"hello"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="unused")
print(client.chat.completions.create(model="muse", messages=[{"role": "user", "content": "hi"}]).choices[0].message.content)
```

## Configuration (`.env`)

See `.env.example`: `PORT`, `HOST`, `API_KEY` (optional bearer auth), `MUSE_MODEL_ID`, `MUSE_TIMEOUT_MS`, `MUSE_TIMEZONE`,
`MUSE_KEEP_SIDECHATS`.

## Limitations

- The agent is a full agent (tools, files, browsing), not a bare LLM, so replies can be slow (often 5–30 s) and may arrive as a few large deltas.
- Confidential (CVM) agents are not supported.
