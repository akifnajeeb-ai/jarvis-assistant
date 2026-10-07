import { createServer } from "node:http";
import { readFile, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.env.PORT || "3000", 10);
const maxRequestBytes = 64 * 1024;

try {
  const envFile = readFileSync(path.join(projectDirectory, ".env"), "utf8");
  for (const line of envFile.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator < 1 || line.trimStart().startsWith("#")) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^(?:"(.*)"|'(.*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
    if (name && process.env[name] === undefined) process.env[name] = value;
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteCount = 0;
    let tooLarge = false;

    request.on("data", (chunk) => {
      byteCount += chunk.length;
      if (byteCount > maxRequestBytes) {
        tooLarge = true;
      } else {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("Request is too large."), { status: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

async function handleChat(request, response) {
  if (!process.env.OPENAI_API_KEY) {
    sendJson(response, 503, { error: "Add OPENAI_API_KEY to your .env file, then restart Jarvis." });
    return;
  }

  const body = await readJson(request);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    sendJson(response, 400, { error: "Send at least one chat message." });
    return;
  }

  const messages = body.messages.slice(-12);
  const validMessages = messages.every((message) =>
    message &&
    ["user", "assistant"].includes(message.role) &&
    typeof message.content === "string" &&
    message.content.trim().length > 0 &&
    message.content.length <= 4000
  );
  if (!validMessages || !messages.some((message) => message.role === "user")) {
    sendJson(response, 400, { error: "Chat messages must have a user or assistant role and contain under 4,000 characters." });
    return;
  }

  const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are Jarvis, a helpful, concise personal assistant. Be clear that you cannot control devices or access private data unless a capability is explicitly provided." },
        ...messages,
      ],
      max_completion_tokens: 700,
    }),
  });
  const result = await upstream.json().catch(() => ({}));

  if (!upstream.ok) {
    const detail = result.error?.message;
    sendJson(response, upstream.status === 429 ? 429 : 502, {
      error: typeof detail === "string" ? detail.slice(0, 400) : "The AI service could not complete the request.",
    });
    return;
  }

  const reply = result.choices?.[0]?.message?.content;
  if (typeof reply !== "string" || !reply.trim()) {
    sendJson(response, 502, { error: "The AI service returned an empty response." });
    return;
  }
  sendJson(response, 200, { reply: reply.trim() });
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;

  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { configured: Boolean(process.env.OPENAI_API_KEY) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/chat") {
    try {
      await handleChat(request, response);
    } catch (error) {
      sendJson(response, error.status || 502, {
        error: error.status ? error.message : "Could not reach the AI service. Check your connection and API configuration.",
      });
    }
    return;
  }

  if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    readFile(path.join(projectDirectory, "index.html"), (error, html) => {
      if (error) {
        response.writeHead(500);
        response.end("Could not load the Jarvis page.");
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(html);
    });
    return;
  }

  sendJson(response, 404, { error: "Not found." });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Jarvis is running at http://localhost:${port}`);
});