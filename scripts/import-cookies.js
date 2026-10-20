#!/usr/bin/env node
// Copy muse.ai cookies from a running Chrome (remote debugging enabled via
// chrome://inspect/#remote-debugging) into .env as MUSE_COOKIES.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENV_FILE = path.resolve(import.meta.dirname, "..", ".env");
const PORT_FILES = [
  "Library/Application Support/Google/Chrome/DevToolsActivePort",
  ".config/google-chrome/DevToolsActivePort",
  "AppData/Local/Google/Chrome/User Data/DevToolsActivePort",
].map((p) => path.join(os.homedir(), p));

async function browserWsUrl() {
  if (process.env.CHROME_CDP_URL) return process.env.CHROME_CDP_URL;
  for (const file of PORT_FILES) {
    if (!fs.existsSync(file)) continue;
    const [port, wsPath] = fs.readFileSync(file, "utf8").trim().split("\n");
    return `ws://127.0.0.1:${port}${wsPath}`;
  }
  const port = process.env.CHROME_CDP_PORT ?? "9222";
  const res = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
  if (res?.ok) return (await res.json()).webSocketDebuggerUrl;
  throw new Error(
    "Cannot find Chrome's DevTools endpoint. Enable chrome://inspect/#remote-debugging, " +
      "or set CHROME_CDP_URL=ws://127.0.0.1:<port>/devtools/browser/<id>"
  );
}

async function getCookies(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("Chrome refused the DevTools connection (approve the prompt in Chrome)"));
  });
  ws.send(JSON.stringify({ id: 1, method: "Storage.getCookies" }));
  const { result, error } = await new Promise((resolve) => {
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id === 1) resolve(msg);
    };
  });
  ws.close();
  if (error) throw new Error(error.message);
  return result.cookies.filter((c) => c.domain === "muse.ai" || c.domain.endsWith(".muse.ai"));
}

function writeEnv(key, value) {
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8").split("\n") : [];
  const entry = `${key}=${JSON.stringify(value)}`;
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = entry;
  else lines.splice(lines.length && lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, entry);
  fs.writeFileSync(ENV_FILE, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
}

const cookies = await getCookies(await browserWsUrl());
if (cookies.length === 0) throw new Error("No muse.ai cookies found — log in to https://muse.ai in Chrome first");
writeEnv("MUSE_COOKIES", cookies.map((c) => `${c.name}=${c.value}`).join("; "));
console.log(`Saved ${cookies.length} muse.ai cookies to ${ENV_FILE}`);
