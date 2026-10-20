# muse2api

Local proxy server biến agent [muse.ai](https://muse.ai) thành API tương thích OpenAI (`/v1/chat/completions`, `/v1/models`).

Proxy kết nối trực tiếp tới VM agent của bạn qua kênh WebSocket mã hoá Noise (giống web app của muse.ai), nên không cần mở Chrome khi chạy. Mỗi request được gửi trong một **sidechat mới** để không dùng context của main chat, và sidechat đó tự xoá sau khi trả lời xong.

## Yêu cầu

- Node.js 22 trở lên
- Google Chrome đã đăng nhập muse.ai (chỉ cần khi lấy cookie)
- Agent muse.ai loại thường (agent bảo mật CVM chưa được hỗ trợ)

## Cài đặt

```bash
git clone git@github.com:ethantrannn/muse2api.git
cd muse2api
npm install
```

## Lấy cookie muse.ai

1. Mở Chrome, đăng nhập https://muse.ai.
2. Vào `chrome://inspect/#remote-debugging` và bật **Allow remote debugging for this browser instance**.
3. Chạy:

   ```bash
   npm run import-cookies
   ```

4. Chrome sẽ hỏi có cho phép remote debugging không, chọn **Allow**. Cookie được lưu vào file `.env` (đã nằm trong `.gitignore`).

Nếu script không tự tìm thấy Chrome, truyền endpoint DevTools thủ công:

```bash
CHROME_CDP_URL="ws://127.0.0.1:9222/devtools/browser/<id>" npm run import-cookies
```

Khi API báo lỗi 401/403 (phiên đăng nhập hết hạn), chạy lại `npm run import-cookies`.

## Chạy server

```bash
npm start                 # http://127.0.0.1:8787/v1
PORT=8790 npm start       # đổi cổng nếu 8787 đã bị dùng
```

## Test bằng curl

```bash
# Danh sách model
curl -s http://127.0.0.1:8787/v1/models

# Chat thường
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"muse","messages":[{"role":"user","content":"Xin chào!"}]}'

# Chat stream (SSE)
curl -sN http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"muse","stream":true,"messages":[{"role":"user","content":"Đếm từ 1 đến 5"}]}'
```

## Dùng với OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="unused")
reply = client.chat.completions.create(
    model="muse",
    messages=[{"role": "user", "content": "Xin chào!"}],
)
print(reply.choices[0].message.content)
```

```js
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://127.0.0.1:8787/v1", apiKey: "unused" });
const stream = await client.chat.completions.create({
  model: "muse",
  stream: true,
  messages: [{ role: "user", content: "Xin chào!" }],
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
```

## Cấu hình (`.env`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `MUSE_COOKIES` | (bắt buộc) | Cookie muse.ai, do `npm run import-cookies` điền |
| `PORT` | `8787` | Cổng server |
| `HOST` | `127.0.0.1` | Địa chỉ lắng nghe |
| `API_KEY` | (trống) | Nếu đặt, mọi request phải có `Authorization: Bearer <API_KEY>` |
| `MUSE_MODEL_ID` | `muse` | Tên model trả về ở `/v1/models` |
| `MUSE_TIMEOUT_MS` | `600000` | Thời gian chờ tối đa cho một câu trả lời |
| `MUSE_TIMEZONE` | múi giờ máy | Múi giờ gửi kèm tin nhắn |
| `MUSE_KEEP_SIDECHATS` | `false` | Đặt `true` để giữ lại sidechat (debug) |

Xem mẫu ở `.env.example`.

## Lưu ý

- Muse là agent đầy đủ (có công cụ, file, duyệt web), không phải LLM thuần, nên mỗi câu trả lời thường mất khoảng 5–30 giây.
- Mảng `messages` được gộp thành một prompt (`[System]`, `[User]`, `[Assistant]`); `usage` luôn trả về 0.
- Chi tiết giao thức giữa muse.ai và server nằm trong [`docs/usage.md`](docs/usage.md).
