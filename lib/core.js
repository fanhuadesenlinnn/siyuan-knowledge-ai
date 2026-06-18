"use strict";

const DEFAULT_CONFIG = {
  baseUrl: "https://api.openai.com/v1",
  chatModel: "gpt-4.1-mini",
  embeddingModel: "text-embedding-3-small",
  temperature: 0.2,
  topK: 8,
  maxIndexedBlocks: 12000,
  chunkSize: 900,
  chunkOverlap: 120,
  batchSize: 32,
  shardSize: 80,
  modelTimeoutMs: 120000,
  autoIndexOnStart: false,
  autoIndexEveryHours: 24,
  defaultNotebook: "",
  defaultPath: "/Knowledge AI",
  allowWriteActions: true,
  systemPrompt:
    "你是用户的个人思源笔记 AI 助手。优先依据笔记证据回答；证据不足时明确说明。回答要简洁、可执行，并在需要时给出引用编号。",
};

function mergeConfig(saved) {
  return Object.assign({}, DEFAULT_CONFIG, saved || {});
}

function normalizeBaseUrl(value) {
  const base = String(value || DEFAULT_CONFIG.baseUrl).trim();
  return base.replace(/\/+$/, "");
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeSql(value) {
  return String(value == null ? "" : value).replace(/'/g, "''");
}

function stableHash(text) {
  const input = String(text || "");
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function chunkText(text, options) {
  const content = String(text || "").replace(/\r\n/g, "\n").trim();
  const size = clampNumber(options && options.chunkSize, 200, 4000, DEFAULT_CONFIG.chunkSize);
  const overlap = clampNumber(options && options.chunkOverlap, 0, Math.floor(size / 2), DEFAULT_CONFIG.chunkOverlap);
  if (!content) return [];
  if (content.length <= size) return [content];

  const chunks = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(content.length, start + size);
    if (end < content.length) {
      const newline = content.lastIndexOf("\n", end);
      const period = content.lastIndexOf("。", end);
      const asciiPeriod = content.lastIndexOf(".", end);
      const cut = Math.max(newline, period, asciiPeriod);
      if (cut > start + Math.floor(size * 0.55)) end = cut + 1;
    }
    const chunk = content.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= content.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

function blockToChunks(row, options) {
  const id = String(row.id || "").trim();
  const content = String(row.markdown || row.content || row.fcontent || "").trim();
  if (!id || !content) return [];
  const title = String(row.hpath || row.hPath || row.content || "").trim();
  const parts = chunkText(content, options);
  return parts.map((part, index) => ({
    id: `${id}:${index}`,
    blockId: id,
    rootId: row.root_id || row.rootID || row.id || "",
    box: row.box || "",
    path: row.path || "",
    hpath: row.hpath || row.hPath || "",
    type: row.type || "",
    subtype: row.subtype || "",
    updated: row.updated || "",
    title,
    text: part,
    hash: stableHash(`${id}\n${row.updated || ""}\n${part}`),
  }));
}

function dot(a, b) {
  const length = Math.min(a.length, b.length);
  let value = 0;
  for (let i = 0; i < length; i += 1) value += Number(a[i] || 0) * Number(b[i] || 0);
  return value;
}

function norm(a) {
  let value = 0;
  for (const number of a || []) value += Number(number || 0) * Number(number || 0);
  return Math.sqrt(value);
}

function cosineSimilarity(a, b) {
  const denominator = norm(a) * norm(b);
  if (!denominator) return 0;
  return dot(a, b) / denominator;
}

function rankChunks(chunks, queryEmbedding, topK) {
  const limit = clampNumber(topK, 1, 30, DEFAULT_CONFIG.topK);
  return (chunks || [])
    .filter((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length)
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function buildContext(ranked) {
  return ranked
    .map((item, index) => {
      const chunk = item.chunk;
      const title = chunk.hpath || chunk.title || chunk.blockId;
      return [
        `[${index + 1}] ${title}`,
        `blockId: ${chunk.blockId}`,
        `score: ${item.score.toFixed(4)}`,
        chunk.text,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

function buildMessages(config, question, ranked) {
  const context = buildContext(ranked);
  return [
    {
      role: "system",
      content: config.systemPrompt || DEFAULT_CONFIG.systemPrompt,
    },
    {
      role: "user",
      content: [
        "请基于下面的思源笔记片段回答问题。",
        "要求：",
        "1. 优先使用片段中的事实。",
        "2. 每个关键结论后标注引用编号，例如 [1]。",
        "3. 如果片段不足以回答，明确说明缺口。",
        "",
        "笔记片段：",
        context || "无命中的笔记片段。",
        "",
        "问题：",
        String(question || "").trim(),
      ].join("\n"),
    },
  ];
}

function buildModelProxyPayload(url, apiKey, payload, timeout) {
  const headers = [{ "Content-Type": "application/json" }];
  const token = String(apiKey || "").trim();
  if (token) headers.push({ Authorization: `Bearer ${token}` });
  return {
    url,
    method: "POST",
    timeout: clampNumber(timeout, 1000, 10 * 60 * 1000, 120000),
    contentType: "application/json",
    headers,
    payload: JSON.stringify(payload || {}),
    payloadEncoding: "text",
    responseEncoding: "text",
  };
}

function parseModelProxyJson(proxyResponse, label) {
  const response = proxyResponse || {};
  const status = Number(response.status || 0);
  const body = String(response.body || "");
  if (status < 200 || status >= 300) {
    const detail = body.length > 600 ? `${body.slice(0, 600)}...` : body;
    throw new Error(`${label} API ${status || "请求失败"}: ${detail || response.url || "无响应内容"}`);
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`${label} API 返回的不是 JSON`);
  }
}

function extractEmbeddings(data) {
  if (!data || !Array.isArray(data.data)) throw new Error("Embedding API 返回格式不正确");
  return data.data
    .slice()
    .sort((a, b) => Number(a.index || 0) - Number(b.index || 0))
    .map((item) => {
      if (!Array.isArray(item.embedding)) throw new Error("Embedding API 返回格式不正确");
      return item.embedding;
    });
}

function extractChatContent(data) {
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error("Chat API 没有返回回答内容");
  return content;
}

function nowIso() {
  return new Date().toISOString();
}

function makeShardPath(pluginName, shardId) {
  return `/data/storage/petal/${pluginName}/index/shards/${shardId}.json`;
}

function makeManifestPath(pluginName) {
  return `/data/storage/petal/${pluginName}/index/manifest.json`;
}

module.exports = {
  DEFAULT_CONFIG,
  blockToChunks,
  buildContext,
  buildMessages,
  buildModelProxyPayload,
  chunkText,
  clampNumber,
  cosineSimilarity,
  escapeHtml,
  escapeSql,
  extractChatContent,
  extractEmbeddings,
  makeManifestPath,
  makeShardPath,
  mergeConfig,
  normalizeBaseUrl,
  nowIso,
  parseModelProxyJson,
  rankChunks,
  stableHash,
};
