#!/usr/bin/env node

/**
 * copilot-proxy
 *
 * A zero-dependency localhost proxy that translates the Anthropic Messages API
 * into OpenAI Chat Completions format for the GitHub Copilot API.
 *
 * This enables Claude Code (claude-cli) to use a GitHub Copilot subscription
 * as its model backend instead of a direct Anthropic API key.
 *
 * Usage:
 *   ANTHROPIC_BASE_URL=http://localhost:4141 \
 *   ANTHROPIC_API_KEY=sk-ant-copilot-proxy-not-a-real-key \
 *   claude
 *
 * @license MIT
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const PORT = parseInt(process.env.COPILOT_PROXY_PORT || "4141");
const COPILOT_API = "api.business.githubcopilot.com";
const INTEGRATION_ID = "copilot-developer-cli";
const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");

// GitHub OAuth Device Flow config (same app as copilot-cli)
const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";

// ─── Token Management ───────────────────────────────────────────────────────

let cachedToken = null;

function loadToken() {
  // 1. Environment variable override
  if (process.env.COPILOT_GITHUB_TOKEN) {
    log("Using token from COPILOT_GITHUB_TOKEN env var");
    return process.env.COPILOT_GITHUB_TOKEN;
  }

  // 2. OpenCode auth.json
  const opencodePaths = [
    path.join(os.homedir(), ".local/share/opencode/auth.json"),
    path.join(
      process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"),
      "opencode/auth.json"
    ),
  ];
  for (const p of opencodePaths) {
    try {
      const auth = JSON.parse(fs.readFileSync(p, "utf8"));
      if (auth["github-copilot"]?.access) {
        log(`Using token from ${p}`);
        return auth["github-copilot"].access;
      }
    } catch {}
  }

  // 3. Copilot CLI keychain (macOS)
  if (process.platform === "darwin") {
    try {
      const token = execSync(
        'security find-generic-password -s "copilot-cli" -w 2>/dev/null',
        { encoding: "utf8", timeout: 5000 }
      ).trim();
      if (token) {
        log("Using token from macOS keychain (copilot-cli)");
        return token;
      }
    } catch {}
  }

  // 4. GitHub CLI token (may not have copilot scope)
  try {
    const ghToken = execSync("gh auth token 2>/dev/null", {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (ghToken) {
      log("Using token from gh CLI (may not have copilot access)");
      return ghToken;
    }
  } catch {}

  // 5. Legacy copilot extension config
  const legacyPath = path.join(
    os.homedir(),
    ".config/github-copilot/apps.json"
  );
  try {
    const apps = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
    const first = Object.values(apps)[0];
    if (first?.oauth_token) {
      log(`Using token from ${legacyPath}`);
      return first.oauth_token;
    }
  } catch {}

  return null;
}

async function getToken() {
  if (cachedToken) return cachedToken;
  cachedToken = loadToken();
  if (!cachedToken) {
    console.log("\n⚠️  No GitHub Copilot token found.");
    console.log("Starting GitHub Device Flow authentication...\n");
    cachedToken = await githubDeviceFlow();
    if (cachedToken) {
      saveToken(cachedToken);
    }
  }
  return cachedToken;
}

function saveToken(token) {
  const authDir = path.join(os.homedir(), ".local/share/opencode");
  const authFile = path.join(authDir, "auth.json");
  try {
    fs.mkdirSync(authDir, { recursive: true });
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(authFile, "utf8"));
    } catch {}
    existing["github-copilot"] = {
      type: "oauth",
      refresh: token,
      access: token,
      expires: 0,
    };
    fs.writeFileSync(authFile, JSON.stringify(existing, null, 2));
    log(`Token saved to ${authFile}`);
  } catch (e) {
    console.error("Warning: Could not save token:", e.message);
  }
}

// ─── GitHub Device Flow ─────────────────────────────────────────────────────

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const req = https.request(
      {
        hostname,
        port: 443,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch {
            resolve({ error: Buffer.concat(chunks).toString() });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function githubDeviceFlow() {
  const codeResp = await httpsPost("github.com", "/login/device/code", {
    client_id: GITHUB_CLIENT_ID,
    scope: "copilot",
  });

  if (!codeResp.device_code) {
    console.error("Failed to start device flow:", codeResp);
    return null;
  }

  console.log(`🔗 Open this URL: ${codeResp.verification_uri}`);
  console.log(`📋 Enter code:    ${codeResp.user_code}\n`);
  console.log("Waiting for authorization...");

  const interval = (codeResp.interval || 5) * 1000;
  const expires = Date.now() + codeResp.expires_in * 1000;

  while (Date.now() < expires) {
    await new Promise((r) => setTimeout(r, interval));
    const tokenResp = await httpsPost(
      "github.com",
      "/login/oauth/access_token",
      {
        client_id: GITHUB_CLIENT_ID,
        device_code: codeResp.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }
    );

    if (tokenResp.access_token) {
      console.log("✅ Authenticated successfully!\n");
      return tokenResp.access_token;
    }
    if (
      tokenResp.error === "authorization_pending" ||
      tokenResp.error === "slow_down"
    ) {
      continue;
    }
    console.error("Auth error:", tokenResp.error_description || tokenResp);
    return null;
  }
  console.error("Authentication timed out.");
  return null;
}

// ─── API Translation: Anthropic → OpenAI ────────────────────────────────────

// Claude-cli sends dashes (claude-opus-4-6), copilot wants dots (claude-opus-4.6)
// Supported direct mappings: opus 4.5/4.6, sonnet 4.5/4.6, haiku 4.5
const COPILOT_MODELS = new Set([
  "claude-opus-4.5",
  "claude-opus-4.6",
  "claude-sonnet-4.5",
  "claude-sonnet-4.6",
  "claude-haiku-4.5",
]);

function mapModel(model) {
  if (!model) return "claude-sonnet-4.6";

  // Strip common prefixes
  let clean = model.replace(/^anthropic\./, "");

  // Already a valid copilot model ID
  if (COPILOT_MODELS.has(clean)) return clean;

  // Strip date suffixes: claude-opus-4-6-v1, claude-sonnet-4-5-20250929-v1, etc.
  clean = clean.replace(/-\d{8}(-v\d+)?$/, "").replace(/-v\d+$/, "");

  // Convert dashes to dots in version: claude-opus-4-6 → claude-opus-4.6
  const match = clean.match(/^(claude-(?:opus|sonnet|haiku))-(\d+)-(\d+)$/);
  if (match) {
    const mapped = `${match[1]}-${match[2]}.${match[3]}`;
    if (COPILOT_MODELS.has(mapped)) return mapped;
  }

  // Pass through for non-Claude models (gpt-5.2, gemini, etc.)
  return clean;
}

function anthropicToOpenAI(body) {
  const messages = [];

  // System prompt
  if (body.system) {
    if (typeof body.system === "string") {
      messages.push({ role: "system", content: body.system });
    } else if (Array.isArray(body.system)) {
      const text = body.system
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (text) messages.push({ role: "system", content: text });
    }
  }

  // Messages — handle compaction blocks (drop everything before them)
  const rawMessages = body.messages || [];
  let startIdx = 0;
  let compactionSummary = null;

  // Scan for the last compaction block — everything before it gets dropped
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const msg = rawMessages[i];
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "compaction") {
        startIdx = i;
        compactionSummary = block.content;
        break;
      }
    }
    if (compactionSummary) break;
  }

  // If a compaction block was found, inject the summary as a user context message
  if (compactionSummary) {
    messages.push({
      role: "user",
      content: `<context>\nThe following is a summary of our conversation so far:\n\n${compactionSummary}\n</context>`,
    });
  }

  for (const msg of rawMessages.slice(startIdx)) {
    const role = msg.role === "assistant" ? "assistant" : "user";

    if (typeof msg.content === "string") {
      messages.push({ role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      messages.push({ role, content: JSON.stringify(msg.content) });
      continue;
    }

    // Process content blocks
    const parts = [];
    const toolCalls = [];

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          parts.push(block.text);
          break;
        case "image":
          parts.push({
            type: "image_url",
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`,
            },
          });
          break;
        case "tool_use":
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
          break;
        case "tool_result":
          // Tool results become separate messages in OpenAI format
          messages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content:
              typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content),
          });
          break;
        case "thinking":
          // Pass thinking as a system-like annotation
          parts.push(`<thinking>${block.thinking}</thinking>`);
          break;
        case "compaction":
          // Already handled above — skip
          break;
      }
    }

    if (parts.length > 0 || toolCalls.length > 0) {
      const m = { role };
      if (parts.length === 1 && typeof parts[0] === "string") {
        m.content = parts[0];
      } else if (parts.length > 0) {
        // If we have image parts, use the array format
        const hasImages = parts.some((p) => typeof p !== "string");
        if (hasImages) {
          m.content = parts.map((p) =>
            typeof p === "string" ? { type: "text", text: p } : p
          );
        } else {
          m.content = parts.join("\n");
        }
      }
      if (toolCalls.length > 0) {
        m.tool_calls = toolCalls;
        if (!m.content) m.content = null;
      }
      messages.push(m);
    }
  }

  // Build OpenAI request
  const req = {
    model: mapModel(body.model),
    messages,
    stream: body.stream || false,
  };

  if (body.max_tokens) req.max_tokens = body.max_tokens;
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  if (body.stop_sequences) req.stop = body.stop_sequences;

  // Tools
  if (body.tools?.length) {
    req.tools = body.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || {},
      },
    }));
  }

  // Extended thinking → reasoning_effort
  if (body.thinking?.type === "enabled") {
    // Copilot doesn't directly support thinking, pass as parameter
    req.reasoning_effort = "high";
  }

  return req;
}

function openAIToAnthropic(oaiResp, requestModel) {
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return {
      id: oaiResp.id || `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model: requestModel,
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const content = [];
  const msg = choice.message;

  if (msg.content) {
    content.push({ type: "text", text: msg.content });
  }

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: safeJsonParse(tc.function.arguments),
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  const stopMap = {
    stop: "end_turn",
    length: "max_tokens",
    tool_calls: "tool_use",
    function_call: "tool_use",
  };

  return {
    id: `msg_${oaiResp.id || Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model: requestModel,
    stop_reason: stopMap[choice.finish_reason] || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens || 0,
      output_tokens: oaiResp.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens:
        oaiResp.usage?.prompt_tokens_details?.cached_tokens || 0,
    },
  };
}

// ─── Streaming Translation ──────────────────────────────────────────────────

function streamOpenAIToAnthropic(res, requestModel, requestId) {
  // Send Anthropic SSE stream events
  const msgId = `msg_${requestId}`;

  sendSSE(res, "message_start", {
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [],
      model: requestModel,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  sendSSE(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });

  let contentIndex = 0;
  let pendingToolCalls = {};
  let usage = { input_tokens: 0, output_tokens: 0 };
  let buffer = "";

  return {
    processChunk(chunk) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          this.finish(res);
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const delta = parsed.choices?.[0]?.delta;
        const finishReason = parsed.choices?.[0]?.finish_reason;

        if (parsed.usage) {
          usage.input_tokens = parsed.usage.prompt_tokens || 0;
          usage.output_tokens = parsed.usage.completion_tokens || 0;
        }

        if (delta?.content) {
          sendSSE(res, "content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "text_delta", text: delta.content },
          });
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!pendingToolCalls[idx]) {
              // Close text block, start tool block
              sendSSE(res, "content_block_stop", {
                type: "content_block_stop",
                index: contentIndex,
              });
              contentIndex++;
              pendingToolCalls[idx] = {
                id: tc.id || `toolu_${Date.now()}_${idx}`,
                name: tc.function?.name || "",
                args: "",
              };
              sendSSE(res, "content_block_start", {
                type: "content_block_start",
                index: contentIndex,
                content_block: {
                  type: "tool_use",
                  id: pendingToolCalls[idx].id,
                  name: pendingToolCalls[idx].name,
                  input: {},
                },
              });
            }
            if (tc.function?.arguments) {
              pendingToolCalls[idx].args += tc.function.arguments;
              sendSSE(res, "content_block_delta", {
                type: "content_block_delta",
                index: contentIndex,
                delta: {
                  type: "input_json_delta",
                  partial_json: tc.function.arguments,
                },
              });
            }
          }
        }

        if (finishReason) {
          const stopMap = {
            stop: "end_turn",
            length: "max_tokens",
            tool_calls: "tool_use",
          };
          this.stopReason = stopMap[finishReason] || "end_turn";
        }
      }
    },

    finish(res) {
      sendSSE(res, "content_block_stop", {
        type: "content_block_stop",
        index: contentIndex,
      });

      sendSSE(res, "message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: this.stopReason || "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: usage.output_tokens },
      });

      sendSSE(res, "message_stop", { type: "message_stop" });
      res.end();
    },

    stopReason: "end_turn",
  };
}

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── HTTP Proxy Server ──────────────────────────────────────────────────────

function proxyRequest(method, reqPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: COPILOT_API,
        port: 443,
        path: reqPath,
        method,
        headers: {
          ...headers,
          Host: COPILOT_API,
        },
      },
      (res) => resolve(res)
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function handleMessages(req, res) {
  const token = await getToken();
  if (!token) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "No GitHub Copilot token available" }));
    return;
  }

  let rawBody = "";
  for await (const chunk of req) rawBody += chunk;

  let anthropicReq;
  try {
    anthropicReq = JSON.parse(rawBody);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  const requestModel = anthropicReq.model || "claude-sonnet-4.6";

  // Extract compaction config before translation
  const compactionConfig = extractCompactionConfig(anthropicReq);
  if (compactionConfig) {
    delete anthropicReq.context_management;
    log(`Compaction enabled: trigger=${compactionConfig.triggerTokens}, pause=${compactionConfig.pauseAfter}`);
  }

  const openaiReq = anthropicToOpenAI(anthropicReq);
  const openaiBody = JSON.stringify(openaiReq);

  if (VERBOSE) {
    log(
      `→ ${requestModel} → ${openaiReq.model} | ${openaiReq.messages.length} msgs | stream=${openaiReq.stream}`
    );
  }

  try {
    // Check if compaction should trigger
    if (compactionConfig) {
      const estimatedTokens = estimateTokens(openaiReq.messages);
      log(`Token estimate: ~${estimatedTokens} (threshold: ${compactionConfig.triggerTokens})`);

      if (estimatedTokens >= compactionConfig.triggerTokens) {
        log("Compaction threshold exceeded — triggering summarization");
        const compactionResult = await performCompaction(
          openaiReq.messages,
          requestModel,
          compactionConfig.instructions,
          token
        );

        if (compactionResult) {
          return sendCompactionResponse(
            res,
            requestModel,
            compactionResult,
            compactionConfig,
            openaiReq.stream,
            openaiReq.messages
          );
        }
        log("Compaction failed, proceeding with normal request");
      }
    }
    const upstream = await proxyRequest(
      "POST",
      "/chat/completions",
      {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Copilot-Integration-Id": INTEGRATION_ID,
        "Editor-Version": "copilot-proxy/1.0.0",
        "Content-Length": Buffer.byteLength(openaiBody),
      },
      openaiBody
    );

    if (upstream.statusCode === 401 || upstream.statusCode === 403) {
      // Token expired, clear cache and retry once
      log("Token rejected, clearing cache");
      cachedToken = null;
      const newToken = await getToken();
      if (!newToken) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Authentication failed" }));
        return;
      }
      return handleMessages(req, res);
    }

    if (upstream.statusCode !== 200) {
      let errBody = "";
      for await (const chunk of upstream) errBody += chunk;
      log(`Upstream error ${upstream.statusCode}: ${errBody}`);
      res.writeHead(upstream.statusCode, {
        "Content-Type": "application/json",
      });
      res.end(errBody);
      return;
    }

    if (openaiReq.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const translator = streamOpenAIToAnthropic(
        res,
        requestModel,
        Date.now().toString(36)
      );
      upstream.on("data", (chunk) =>
        translator.processChunk(chunk.toString())
      );
      upstream.on("end", () => {
        if (!res.writableEnded) translator.finish(res);
      });
      upstream.on("error", (e) => {
        log(`Stream error: ${e.message}`);
        if (!res.writableEnded) res.end();
      });
    } else {
      let respBody = "";
      for await (const chunk of upstream) respBody += chunk;
      const openaiResp = JSON.parse(respBody);
      const anthropicResp = openAIToAnthropic(openaiResp, requestModel);

      if (VERBOSE) {
        log(
          `← ${anthropicResp.stop_reason} | ${anthropicResp.usage.input_tokens}in/${anthropicResp.usage.output_tokens}out`
        );
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(anthropicResp));
    }
  } catch (e) {
    log(`Proxy error: ${e.message}`);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "api_error", message: e.message },
      })
    );
  }
}

function handleModels(req, res) {
  // Return a fake models list so claude-cli doesn't complain
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      data: [
        { id: "claude-opus-4-6", display_name: "Claude Opus 4.6 (Copilot)" },
        {
          id: "claude-sonnet-4-6",
          display_name: "Claude Sonnet 4.6 (Copilot)",
        },
        {
          id: "claude-haiku-4-5",
          display_name: "Claude Haiku 4.5 (Copilot)",
        },
      ],
    })
  );
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  log(`${req.method} ${url.pathname}`);

  if (url.pathname === "/v1/messages" && req.method === "POST") {
    return handleMessages(req, res);
  }
  if (url.pathname === "/v1/models" && req.method === "GET") {
    return handleModels(req, res);
  }

  // Health check
  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", proxy: "copilot-proxy" }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "127.0.0.1", async () => {
  const token = await getToken();
  console.log(`
┌─────────────────────────────────────────────────┐
│  🚀 Copilot Proxy running on port ${PORT}          │
│                                                 │
│  Token: ${token ? "✅ loaded" : "❌ not found"}                            │
│                                                 │
│  Usage with claude-cli:                         │
│  ANTHROPIC_BASE_URL=http://localhost:${PORT}       │
│  ANTHROPIC_API_KEY=copilot                      │
│  claude                                         │
└─────────────────────────────────────────────────┘
`);
});

// ─── Compaction ─────────────────────────────────────────────────────────────

const DEFAULT_COMPACTION_TRIGGER = 150_000;
const MIN_COMPACTION_TRIGGER = 50_000;

const DEFAULT_COMPACTION_INSTRUCTIONS = `Please provide a detailed summary of the conversation so far. Focus on:
1. Key decisions made and their rationale
2. Current state of any tasks in progress
3. Important code changes, file paths, and technical details
4. Any unresolved questions or next steps
Preserve specific details like file paths, function names, error messages, and configuration values that would be needed to continue the work.`;

function extractCompactionConfig(body) {
  const edits = body.context_management?.edits;
  if (!Array.isArray(edits)) return null;

  const compact = edits.find((e) => e.type === "compact_20260112");
  if (!compact) return null;

  const triggerTokens = Math.max(
    compact.trigger?.value || DEFAULT_COMPACTION_TRIGGER,
    MIN_COMPACTION_TRIGGER
  );

  return {
    triggerTokens,
    pauseAfter: compact.pause_after_compaction ?? true,
    instructions: compact.instructions || DEFAULT_COMPACTION_INSTRUCTIONS,
  };
}

function estimateTokens(openaiMessages) {
  return Math.ceil(JSON.stringify(openaiMessages).length / 4);
}

function sendCompactionResponse(res, requestModel, compactionResult, config, isStreaming, originalMessages) {
  const msgId = `msg_${Date.now().toString(36)}`;
  const compactionUsage = compactionResult.usage;

  if (isStreaming) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // message_start
    sendSSE(res, "message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        content: [],
        model: requestModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: compactionUsage.input_tokens, output_tokens: 0 },
      },
    });

    // compaction content block
    sendSSE(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "compaction", content: "" },
    });

    sendSSE(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "compaction_delta", content: compactionResult.summary },
    });

    sendSSE(res, "content_block_stop", {
      type: "content_block_stop",
      index: 0,
    });

    // message_delta with stop reason
    const stopReason = config.pauseAfter ? "compaction" : "end_turn";
    sendSSE(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: compactionUsage.output_tokens },
    });

    sendSSE(res, "message_stop", { type: "message_stop" });
    res.end();
  } else {
    const stopReason = config.pauseAfter ? "compaction" : "end_turn";
    const anthropicResp = {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [{ type: "compaction", content: compactionResult.summary }],
      model: requestModel,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: compactionUsage.input_tokens,
        output_tokens: compactionUsage.output_tokens,
        iterations: [
          {
            type: "compaction",
            input_tokens: compactionUsage.input_tokens,
            output_tokens: compactionUsage.output_tokens,
          },
        ],
      },
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(anthropicResp));
  }

  log(`Compaction response sent (stop_reason=${config.pauseAfter ? "compaction" : "end_turn"})`);
}

async function performCompaction(messages, model, instructions, token) {
  const summaryMessages = [
    { role: "system", content: instructions },
    ...messages,
    {
      role: "user",
      content:
        "Please summarize the entire conversation above according to the instructions in the system prompt.",
    },
  ];

  const summaryReq = JSON.stringify({
    model: mapModel(model),
    messages: summaryMessages,
    stream: false,
    max_tokens: 8192,
  });

  log(`Compaction: sending summarization request (${summaryMessages.length} msgs)`);

  const upstream = await proxyRequest(
    "POST",
    "/chat/completions",
    {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Copilot-Integration-Id": INTEGRATION_ID,
      "Editor-Version": "copilot-proxy/1.0.0",
      "Content-Length": Buffer.byteLength(summaryReq),
    },
    summaryReq
  );

  let respBody = "";
  for await (const chunk of upstream) respBody += chunk;

  if (upstream.statusCode !== 200) {
    log(`Compaction summarization failed: ${upstream.statusCode} ${respBody}`);
    return null;
  }

  const resp = JSON.parse(respBody);
  const summary = resp.choices?.[0]?.message?.content;
  if (!summary) {
    log("Compaction: no summary content in response");
    return null;
  }

  log(`Compaction: got summary (${summary.length} chars)`);
  return {
    summary,
    usage: {
      input_tokens: resp.usage?.prompt_tokens || 0,
      output_tokens: resp.usage?.completion_tokens || 0,
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(...args) {
  console.error(`[proxy]`, ...args);
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
