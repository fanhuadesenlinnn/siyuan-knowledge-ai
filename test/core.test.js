"use strict";

const assert = require("assert");
const {
  blockToChunks,
  buildModelProxyPayload,
  buildMessages,
  chunkText,
  cosineSimilarity,
  detectProvider,
  extractChatContent,
  extractEmbeddings,
  isLocalModelBaseUrl,
  mergeConfig,
  normalizeModelBaseUrlForRequest,
  parseModelProxyJson,
  PROVIDER_PRESETS,
  rankChunks,
  stableHash,
} = require("../lib/core");

const config = mergeConfig({ chunkSize: 200, chunkOverlap: 20, topK: 2 });

assert.deepStrictEqual(chunkText("", config), []);
assert.ok(chunkText("测试内容。".repeat(80), config).length >= 2);
assert.strictEqual(stableHash("abc"), stableHash("abc"));
assert.notStrictEqual(stableHash("abc"), stableHash("abd"));

const chunks = blockToChunks(
  {
    id: "20260618000000-testabc",
    root_id: "20260618000000-rootdoc",
    hpath: "/测试/文档",
    content: "这是一个用于测试的思源块。它会被切分并生成检索片段。",
    type: "p",
    updated: "20260618000000",
  },
  config,
);
assert.ok(chunks.length > 0);
assert.strictEqual(chunks[0].blockId, "20260618000000-testabc");

const ranked = rankChunks(
  [
    { id: "a", text: "a", embedding: [1, 0] },
    { id: "b", text: "b", embedding: [0, 1] },
    { id: "c", text: "c", embedding: [0.8, 0.2] },
  ],
  [1, 0],
  2,
);
assert.strictEqual(ranked.length, 2);
assert.strictEqual(ranked[0].chunk.id, "a");
assert.ok(cosineSimilarity([1, 0], [1, 0]) > 0.99);

const messages = buildMessages(config, "测试问题", ranked);
assert.strictEqual(messages.length, 2);
assert.ok(messages[1].content.includes("测试问题"));
assert.ok(messages[1].content.includes("[1]"));

// 带 history：历史插在 system 与检索上下文之间，最后仍是当前问题
const history = [
  { role: "user", content: "上一轮问题" },
  { role: "assistant", content: "上一轮回答" },
];
const messagesWithHistory = buildMessages(config, "本轮问题", ranked, history);
assert.strictEqual(messagesWithHistory.length, 4);
assert.strictEqual(messagesWithHistory[0].role, "system");
assert.strictEqual(messagesWithHistory[1].content, "上一轮问题");
assert.strictEqual(messagesWithHistory[2].content, "上一轮回答");
assert.ok(messagesWithHistory[3].content.includes("本轮问题"));
assert.ok(messagesWithHistory[3].content.includes("[1]"));

// 历史中混入无效项应被过滤，不破坏消息结构
const messyHistory = [
  { role: "system", content: "忽略我" },
  { role: "user", content: "" },
  { role: "assistant", content: "保留这条" },
  null,
];
const messagesMessy = buildMessages(config, "问题", ranked, messyHistory);
assert.strictEqual(messagesMessy.length, 3);
assert.strictEqual(messagesMessy[1].content, "保留这条");

const proxyPayload = buildModelProxyPayload(
  "https://api.example.com/v1/chat/completions",
  "sk-test",
  { model: "demo" },
  5000,
);
assert.strictEqual(proxyPayload.method, "POST");
assert.strictEqual(proxyPayload.payload, '{"model":"demo"}');
assert.ok(proxyPayload.headers.some((item) => item.Authorization === "Bearer sk-test"));

const parsed = parseModelProxyJson(
  {
    status: 200,
    body: '{"choices":[{"message":{"content":"ok"}}]}',
  },
  "Chat",
);
assert.strictEqual(extractChatContent(parsed), "ok");
assert.deepStrictEqual(
  extractEmbeddings({
    data: [
      { index: 1, embedding: [0, 1] },
      { index: 0, embedding: [1, 0] },
    ],
  }),
  [
    [1, 0],
    [0, 1],
  ],
);
assert.throws(() => parseModelProxyJson({ status: 401, body: "bad key" }, "Chat"), /401/);

// detectProvider：已知 baseUrl 精确匹配
assert.strictEqual(detectProvider("https://api.openai.com/v1"), "openai");
assert.strictEqual(detectProvider("https://api.openai.com/v1/"), "openai");
assert.strictEqual(detectProvider("https://generativelanguage.googleapis.com/v1beta/openai"), "gemini");
assert.strictEqual(detectProvider("http://localhost:11434/v1"), "ollama");
assert.strictEqual(detectProvider("http://127.0.0.1:11434/v1"), "ollama");
// 容错：改过路径但 host 相同
assert.strictEqual(detectProvider("https://api.openai.com/v1/custom"), "openai");
assert.strictEqual(detectProvider("https://generativelanguage.googleapis.com/v1beta/openai/extra"), "gemini");
// 未知 URL 返回 custom
assert.strictEqual(detectProvider("https://my-proxy.example.com/v1"), "custom");
assert.strictEqual(detectProvider(""), "custom");
assert.strictEqual(detectProvider(null), "custom");

// 本地模型地址：避免 localhost 在思源 forwardProxy 中解析成被禁止的 ::1
assert.strictEqual(isLocalModelBaseUrl("http://localhost:11434/v1"), true);
assert.strictEqual(isLocalModelBaseUrl("http://127.0.0.1:11434/v1"), true);
assert.strictEqual(isLocalModelBaseUrl("https://api.openai.com/v1"), false);
assert.strictEqual(normalizeModelBaseUrlForRequest("http://localhost:11434/v1"), "http://127.0.0.1:11434/v1");
assert.strictEqual(normalizeModelBaseUrlForRequest("http://[::1]:11434/v1/"), "http://127.0.0.1:11434/v1");

// PROVIDER_PRESETS 结构校验
assert.ok(Array.isArray(PROVIDER_PRESETS));
assert.strictEqual(PROVIDER_PRESETS.length, 3);
for (const p of PROVIDER_PRESETS) {
  assert.ok(p.id && typeof p.id === "string");
  assert.ok(p.label && typeof p.label === "string");
  assert.ok(p.baseUrl && typeof p.baseUrl === "string");
  assert.ok(p.chatModel && typeof p.chatModel === "string");
  assert.ok(p.embeddingModel && typeof p.embeddingModel === "string");
}
const geminiPreset = PROVIDER_PRESETS.find((p) => p.id === "gemini");
assert.ok(geminiPreset);
assert.notStrictEqual(geminiPreset.embeddingModel, "text-embedding-004");

console.log("core tests passed");
