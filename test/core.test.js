"use strict";

const assert = require("assert");
const {
  blockToChunks,
  buildGatewayProxyPayload,
  buildKnowledgeUnits,
  buildSectionUnits,
  buildModelProxyPayload,
  buildMessages,
  chunkText,
  cosineSimilarity,
  detectProvider,
  extractChatContent,
  extractEmbeddings,
  getIndexManifestError,
  getModelRequestRoutes,
  isFallbackAllowed,
  isLocalModelBaseUrl,
  markModelRouteError,
  mergeConfig,
  normalizeProxyMode,
  normalizeModelBaseUrlForRequest,
  parseModelProxyJson,
  PROVIDER_PRESETS,
  PROXY_MODE_OPTIONS,
  rankChunks,
  stableHash,
} = require("../lib/core");

const config = mergeConfig({ chunkSize: 200, chunkOverlap: 20, topK: 2 });

assert.strictEqual(config.proxyMode, "system");
assert.strictEqual(config.proxyFallback, true);
assert.strictEqual(config.proxyGatewayUrl, "");

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
assert.strictEqual(chunks[0].type, "block");

const rows = [
  {
    id: "20260618000100-rootdoc",
    root_id: "20260618000100-rootdoc",
    box: "box-a",
    path: "/20260618000100-rootdoc.sy",
    hpath: "/项目/RAG 插件",
    type: "d",
    content: "RAG 插件",
    markdown: "RAG 插件",
    updated: "20260618000100",
  },
  {
    id: "20260618000200-heading",
    root_id: "20260618000100-rootdoc",
    parent_id: "20260618000100-rootdoc",
    box: "box-a",
    path: "/20260618000100-rootdoc.sy",
    hpath: "/项目/RAG 插件",
    type: "h",
    subtype: "h2",
    content: "检索设计",
    markdown: "## 检索设计",
    updated: "20260618000200",
  },
  {
    id: "20260618000300-paraaaa",
    root_id: "20260618000100-rootdoc",
    parent_id: "20260618000200-heading",
    box: "box-a",
    path: "/20260618000100-rootdoc.sy",
    hpath: "/项目/RAG 插件",
    type: "p",
    content: "章节下面的块应该作为同一个小主题，并考虑 #RAG# 标签。",
    markdown: "章节下面的块应该作为同一个小主题，并考虑 #RAG# 标签。",
    updated: "20260618000300",
  },
  {
    id: "20260618000400-subhead",
    root_id: "20260618000100-rootdoc",
    parent_id: "20260618000200-heading",
    box: "box-a",
    path: "/20260618000100-rootdoc.sy",
    hpath: "/项目/RAG 插件",
    type: "h",
    subtype: "h3",
    content: "标签权重",
    markdown: "### 标签权重",
    updated: "20260618000400",
  },
  {
    id: "20260618000500-parabbb",
    root_id: "20260618000100-rootdoc",
    parent_id: "20260618000400-subhead",
    box: "box-a",
    path: "/20260618000100-rootdoc.sy",
    hpath: "/项目/RAG 插件",
    type: "p",
    content: "标签命中时应该提高排序分数。",
    markdown: "标签命中时应该提高排序分数。",
    updated: "20260618000500",
  },
];
const attrs = {
  "20260618000300-paraaaa": { "custom-tags": "RAG, 插件" },
};
const refs = [{ block_id: "20260618000300-paraaaa", def_block_id: "20260618000500-parabbb" }];
const sections = buildSectionUnits(rows, attrs, refs, config);
assert.ok(sections.length >= 2);
const h2Section = sections.find((section) => section.blockId === "20260618000200-heading");
assert.ok(h2Section);
assert.ok(h2Section.text.includes("章节下面的块"));
assert.ok(h2Section.text.includes("标签权重"));
assert.ok(h2Section.tags.includes("RAG"));
assert.ok(h2Section.refs.includes("20260618000500-parabbb"));

const fallbackRows = [
  {
    id: "20260618001000-rootdoc",
    root_id: "20260618001000-rootdoc",
    box: "box-a",
    hpath: "/无标题结构",
    type: "d",
    content: "无标题结构",
    markdown: "无标题结构",
  },
  {
    id: "20260618001100-para",
    root_id: "20260618001000-rootdoc",
    box: "box-a",
    hpath: "/无标题结构",
    type: "p",
    content: "没有标题时，相邻块应该形成 fallback section。",
    markdown: "没有标题时，相邻块应该形成 fallback section。",
  },
];
const fallbackSections = buildSectionUnits(fallbackRows, {}, {}, config);
assert.strictEqual(fallbackSections.length, 1);
assert.strictEqual(fallbackSections[0].type, "section");

const units = buildKnowledgeUnits(rows, attrs, refs, Object.assign({}, config, { notebooks: { "box-a": "默认笔记本" } }));
assert.ok(units.some((unit) => unit.type === "block"));
assert.ok(units.some((unit) => unit.type === "section"));
assert.ok(units.some((unit) => unit.type === "document"));
assert.ok(units.some((unit) => unit.type === "notebook"));
assert.ok(units.some((unit) => unit.type === "vault"));

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

const taggedRanked = rankChunks(
  [
    { id: "plain", type: "block", text: "普通内容", title: "普通", tags: [], embedding: [0.98, 0.02] },
    { id: "tagged", type: "section", text: "相关内容", title: "插件", tags: ["RAG"], embedding: [0.9, 0.1] },
  ],
  [1, 0],
  2,
  "RAG 插件怎么设计",
);
assert.strictEqual(taggedRanked[0].chunk.id, "tagged");

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

const gatewayPayload = buildGatewayProxyPayload(
  "http://127.0.0.1:7891/proxy/",
  "https://api.example.com/v1/chat/completions",
  "sk-test",
  { model: "demo" },
  5000,
);
assert.strictEqual(gatewayPayload.gatewayUrl, "http://127.0.0.1:7891/proxy");
assert.deepStrictEqual(gatewayPayload.payload, proxyPayload);
assert.throws(() => buildGatewayProxyPayload("", "https://api.example.com/v1/chat/completions", "", {}, 5000), /网关 URL/);

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

assert.strictEqual(normalizeProxyMode("system"), "system");
assert.strictEqual(normalizeProxyMode("bad-mode"), "system");
assert.deepStrictEqual(getModelRequestRoutes(mergeConfig({ proxyMode: "system" }), "https://api.openai.com/v1"), [
  "direct",
  "siyuan",
]);
assert.deepStrictEqual(getModelRequestRoutes(mergeConfig({ proxyMode: "system", proxyFallback: false }), "https://api.openai.com/v1"), [
  "direct",
]);
assert.deepStrictEqual(getModelRequestRoutes(mergeConfig({ proxyMode: "siyuan" }), "https://api.openai.com/v1"), ["siyuan"]);
assert.deepStrictEqual(getModelRequestRoutes(mergeConfig({ proxyMode: "direct" }), "https://api.openai.com/v1"), ["direct"]);
assert.deepStrictEqual(getModelRequestRoutes(mergeConfig({ proxyMode: "gateway" }), "https://api.openai.com/v1"), ["gateway"]);
assert.deepStrictEqual(getModelRequestRoutes(mergeConfig({ proxyMode: "gateway" }), "http://127.0.0.1:11434/v1"), ["direct"]);

const networkError = markModelRouteError(new Error("Failed to fetch"), "direct", true);
assert.strictEqual(isFallbackAllowed(networkError, config, ["siyuan"]), true);
const authError = new Error("bad key");
authError.status = 401;
authError.isNetworkError = false;
assert.strictEqual(isFallbackAllowed(authError, config, ["siyuan"]), false);
const rateError = new Error("rate limited");
rateError.status = 429;
rateError.isNetworkError = false;
assert.strictEqual(isFallbackAllowed(rateError, config, ["siyuan"]), false);
assert.strictEqual(isFallbackAllowed(networkError, mergeConfig({ proxyFallback: false }), ["siyuan"]), false);

assert.match(
  getIndexManifestError({ version: 1, shards: [{ path: "old" }], embeddingModel: config.embeddingModel }, config, 2),
  /版本不兼容/,
);
assert.strictEqual(
  getIndexManifestError({ version: 2, schemaVersion: 2, shards: [{ path: "new" }], embeddingModel: config.embeddingModel }, config, 2),
  "",
);

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

assert.ok(Array.isArray(PROXY_MODE_OPTIONS));
assert.ok(PROXY_MODE_OPTIONS.some((item) => item.id === "system"));
assert.ok(PROXY_MODE_OPTIONS.some((item) => item.id === "gateway"));

console.log("core tests passed");
