"use strict";

const assert = require("assert");
const {
  blockToChunks,
  buildDailyNoteUnits,
  buildDailyTopicUnits,
  buildGatewayProxyPayload,
  buildKnowledgeUnits,
  buildSectionUnits,
  buildModelProxyPayload,
  buildMessages,
  buildTimelineContext,
  chunkText,
  cosineSimilarity,
  countEmbeddedUnits,
  detectProvider,
  extractChatContent,
  extractEmbeddings,
  extractRetryDelayMs,
  getIndexManifestError,
  getModelRequestRoutes,
  isFallbackAllowed,
  isLocalModelBaseUrl,
  markModelRouteError,
  mergeConfig,
  mergeLegacyApiKey,
  groupDailyRowsByDate,
  normalizeApiKeys,
  normalizeDailyNotePath,
  normalizeProxyMode,
  normalizeModelBaseUrlForRequest,
  parseDailyTopicResponse,
  parseTimeRange,
  parseModelProxyJson,
  PROVIDER_PRESETS,
  PROXY_MODE_OPTIONS,
  applyUnitSummary,
  rankChunks,
  renderBasicMarkdownHtml,
  stableHash,
} = require("../lib/core");

const config = mergeConfig({ chunkSize: 200, chunkOverlap: 20, topK: 2 });

assert.strictEqual(config.proxyMode, "system");
assert.strictEqual(config.proxyFallback, true);
assert.strictEqual(config.proxyGatewayUrl, "");
assert.strictEqual(config.dailyNotePath, "/daily note");
assert.strictEqual(config.enableDailyAiTopics, true);
assert.strictEqual(config.dailyAiTopicMaxDays, 30);
assert.strictEqual(normalizeDailyNotePath("daily note/"), "/daily note");

assert.deepStrictEqual(chunkText("", config), []);
assert.ok(chunkText("测试内容。".repeat(80), config).length >= 2);
assert.strictEqual(stableHash("abc"), stableHash("abc"));
assert.notStrictEqual(stableHash("abc"), stableHash("abd"));
assert.deepStrictEqual(normalizeApiKeys({ openai: " sk-openai ", gemini: "", "": "sk-empty-id" }), { openai: "sk-openai" });
assert.deepStrictEqual(mergeLegacyApiKey({}, " sk-legacy ", "default"), { default: "sk-legacy" });
assert.deepStrictEqual(mergeLegacyApiKey({ gemini: "sk-gemini", default: "" }, "sk-legacy", "default"), { gemini: "sk-gemini" });

const markdownHtml = renderBasicMarkdownHtml([
  "# 标题",
  "",
  "- **重点**",
  "- `代码`",
  "",
  "| 名称 | 值 |",
  "| --- | --- |",
  "| A | [链接](https://example.com) |",
  "",
  "[星号链接](https://example.com/a**b**)",
  "![`alt`](https://example.com/image.png)",
  "",
  "```js",
  "console.log('<x>')",
  "```",
  "",
  "[坏链接](javascript:alert(1))",
  "<img src=x onerror=alert(1)>",
].join("\n"));
assert.ok(markdownHtml.includes("<h1>标题</h1>"));
assert.ok(markdownHtml.includes("<ul><li><strong>重点</strong></li><li><code>代码</code></li></ul>"));
assert.ok(markdownHtml.includes("<table>"));
assert.ok(markdownHtml.includes('href="https://example.com"'));
assert.ok(markdownHtml.includes('href="https://example.com/a**b**"'));
assert.ok(markdownHtml.includes('alt="alt"'));
assert.ok(markdownHtml.includes("&lt;x&gt;"));
assert.ok(!markdownHtml.includes("javascript:"));
assert.ok(markdownHtml.includes("&lt;img src=x onerror=alert(1)&gt;"));

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
assert.strictEqual(chunks[0].sourceHash, chunks[0].hash);

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
  "20260618000300-paraaaa": {
    "custom-tags": "RAG, 插件",
    "custom-metric-importance": "5",
    "custom-task-projectid": "quick_572",
  },
};
const refs = [{ block_id: "20260618000300-paraaaa", def_block_id: "20260618000500-parabbb" }];
const sections = buildSectionUnits(rows, attrs, refs, config);
assert.ok(sections.length >= 2);
const h2Section = sections.find((section) => section.blockId === "20260618000200-heading");
assert.ok(h2Section);
assert.ok(h2Section.text.includes("章节下面的块"));
assert.ok(h2Section.text.includes("标签权重"));
assert.ok(h2Section.tags.includes("RAG"));
assert.ok(h2Section.tags.includes("重要:高"));
assert.ok(!h2Section.tags.includes("高"));
assert.ok(h2Section.tags.includes("项目:quick_572"));
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
const documentUnit = units.find((unit) => unit.type === "document");
assert.ok(documentUnit);
const originalSourceHash = documentUnit.sourceHash;
const originalHash = documentUnit.hash;
assert.strictEqual(originalSourceHash, originalHash);
assert.strictEqual(applyUnitSummary(documentUnit, "这是可复用的主题摘要。"), true);
assert.strictEqual(documentUnit.sourceHash, originalSourceHash);
assert.notStrictEqual(documentUnit.hash, originalHash);
assert.ok(documentUnit.contextText.includes("AI 摘要: 这是可复用的主题摘要。"));

const dailyRows = [
  {
    id: "20260618000000-dailydoc",
    root_id: "20260618000000-dailydoc",
    box: "daily-box",
    path: "/daily.sy",
    hpath: "/daily note/2026/06/2026-06-18",
    type: "d",
    content: "2026-06-18",
    markdown: "2026-06-18",
    updated: "20260618000000",
  },
  {
    id: "20260618000100-topic-item",
    root_id: "20260618000000-dailydoc",
    parent_id: "20260618000000-dailydoc",
    box: "daily-box",
    path: "/daily.sy",
    hpath: "/daily note/2026/06/2026-06-18",
    type: "i",
    subtype: "u",
    content: "思源 AI 插件 2026-06-19 10:25:50 索引最大只能是30个 Markdown 渲染",
    markdown: "- 思源 AI 插件\n  - 2026-06-19 10:25:50\n    1. 索引最大只能是30个\n    2. Markdown 渲染",
    updated: "20260619102550",
  },
  {
    id: "20260618000101-topic-text",
    root_id: "20260618000000-dailydoc",
    parent_id: "20260618000100-topic-item",
    box: "daily-box",
    path: "/daily.sy",
    hpath: "/daily note/2026/06/2026-06-18",
    type: "p",
    content: "思源 AI 插件",
    markdown: "思源 AI 插件",
    updated: "20260619102550",
  },
  {
    id: "20260618000200-event-item",
    root_id: "20260618000000-dailydoc",
    parent_id: "20260618000100-topic-item",
    box: "daily-box",
    path: "/daily.sy",
    hpath: "/daily note/2026/06/2026-06-18",
    type: "i",
    subtype: "u",
    content: "2026-06-19 10:25:50 索引最大只能是30个 Markdown 渲染",
    markdown: "- 2026-06-19 10:25:50\n  1. 索引最大只能是30个\n  2. Markdown 渲染",
    updated: "20260619102550",
  },
  {
    id: "20260618000201-event-text",
    root_id: "20260618000000-dailydoc",
    parent_id: "20260618000200-event-item",
    box: "daily-box",
    path: "/daily.sy",
    hpath: "/daily note/2026/06/2026-06-18",
    type: "p",
    content: "2026-06-19 10:25:50",
    markdown: "2026-06-19 10:25:50",
    updated: "20260619102550",
  },
  {
    id: "20260618000300-list",
    root_id: "20260618000000-dailydoc",
    parent_id: "20260618000200-event-item",
    box: "daily-box",
    path: "/daily.sy",
    hpath: "/daily note/2026/06/2026-06-18",
    type: "l",
    subtype: "o",
    content: "索引最大只能是30个 Markdown 渲染",
    markdown: "1. 索引最大只能是30个\n2. Markdown 渲染",
    updated: "20260619102550",
  },
  {
    id: "20260618000400-first",
    root_id: "20260618000000-dailydoc",
    parent_id: "20260618000300-list",
    box: "daily-box",
    path: "/daily.sy",
    hpath: "/daily note/2026/06/2026-06-18",
    type: "i",
    subtype: "o",
    content: "索引最大只能是30个",
    markdown: "1. 索引最大只能是30个",
    updated: "20260619102550",
  },
  {
    id: "20260618000401-first-text",
    root_id: "20260618000000-dailydoc",
    parent_id: "20260618000400-first",
    box: "daily-box",
    path: "/daily.sy",
    hpath: "/daily note/2026/06/2026-06-18",
    type: "p",
    content: "索引最大只能是30个",
    markdown: "索引最大只能是30个",
    updated: "20260619102550",
  },
  {
    id: "20260618000500-second",
    root_id: "20260618000000-dailydoc",
    parent_id: "20260618000300-list",
    box: "daily-box",
    path: "/daily.sy",
    hpath: "/daily note/2026/06/2026-06-18",
    type: "i",
    subtype: "o",
    content: "Markdown 渲染",
    markdown: "2. Markdown 渲染",
    updated: "20260619102550",
  },
  {
    id: "20260618000501-second-text",
    root_id: "20260618000000-dailydoc",
    parent_id: "20260618000500-second",
    box: "daily-box",
    path: "/daily.sy",
    hpath: "/daily note/2026/06/2026-06-18",
    type: "p",
    content: "Markdown 渲染",
    markdown: "Markdown 渲染",
    updated: "20260619102550",
  },
  {
    id: "20260618000502-second-code",
    root_id: "20260618000000-dailydoc",
    parent_id: "20260618000500-second",
    box: "daily-box",
    path: "/daily.sy",
    hpath: "/daily note/2026/06/2026-06-18",
    type: "c",
    content: "dock 打开很宽才行\n更新索引要复用旧向量",
    markdown: "```text\ndock 打开很宽才行\n更新索引要复用旧向量\n```",
    updated: "20260619102550",
  },
];
const dailyUnits = buildKnowledgeUnits(dailyRows, {}, {}, config);
const dayDetail = dailyUnits.find((unit) => unit.type === "daily_detail" && unit.dailyScope === "day");
assert.ok(dayDetail);
assert.strictEqual(dayDetail.dailyDate, "2026-06-18");
assert.ok(dayDetail.text.includes("索引最大只能是30个"));
assert.ok(dailyUnits.some((unit) => unit.type === "daily_event" && unit.text.includes("思源 AI 插件")));
assert.strictEqual(dailyUnits.filter((unit) => unit.type === "daily_item").length, 2);
assert.ok(dailyUnits.some((unit) => unit.type === "daily_detail" && unit.title.includes("Markdown 渲染") && unit.text.includes("复用旧向量")));
assert.ok(!dailyUnits.some((unit) => unit.type === "document" && unit.title === "2026-06-18"));
const directDailyUnits = buildDailyNoteUnits(dailyRows, {}, {}, config);
assert.ok(directDailyUnits.some((unit) => unit.type === "daily_detail" && unit.dailyScope === "day"));
assert.deepStrictEqual(parseDailyTopicResponse('{"topics":[{"category":"技术","title":"Markdown 渲染","summary":"优化 dock 内回答显示"}]}'), [
  { category: "技术", title: "Markdown 渲染", summary: "优化 dock 内回答显示" },
]);
assert.deepStrictEqual(parseDailyTopicResponse("2026-06-18 / [工作] 英方备份系统重新部署"), [
  { category: "工作", title: "英方备份系统重新部署", summary: "" },
]);
const dailyTopicUnits = buildDailyTopicUnits(dayDetail, [
  { category: "技术", title: "Markdown 渲染", summary: "优化 dock 内回答显示" },
], config);
assert.strictEqual(dailyTopicUnits.length, 1);
assert.strictEqual(dailyTopicUnits[0].type, "daily_topic");
assert.strictEqual(dailyTopicUnits[0].dailySourceKey, `${dayDetail.id}\n${dayDetail.sourceHash}`);
assert.ok(dailyTopicUnits[0].title.includes("[技术] Markdown 渲染"));

const today = new Date(2026, 5, 21);
assert.deepStrictEqual(parseTimeRange("今天干了啥", today), { start: "2026-06-21", end: "2026-06-21", label: "今天" });
assert.deepStrictEqual(parseTimeRange("最近一周工作", today), { start: "2026-06-15", end: "2026-06-21", label: "最近1周" });
assert.deepStrictEqual(parseTimeRange("上周三干了啥", today), { start: "2026-06-10", end: "2026-06-10", label: "上周三" });
assert.deepStrictEqual(parseTimeRange("6/15 干了啥", today), { start: "2026-06-15", end: "2026-06-15", label: "2026-06-15" });
const timelineGroups = groupDailyRowsByDate(dailyRows, parseTimeRange("6月18号", today), "/daily note");
assert.strictEqual(timelineGroups.length, 1);
assert.strictEqual(timelineGroups[0].date, "2026-06-18");
assert.ok(buildTimelineContext(timelineGroups).includes("Markdown 渲染"));
const truncatedTimeline = buildTimelineContext(
  [
    { date: "2026-06-18", blocks: Array.from({ length: 20 }, (_, index) => ({ content: `很长的日记记录 ${index} ${"x".repeat(500)}` })) },
    { date: "2026-06-19", blocks: Array.from({ length: 20 }, (_, index) => ({ content: `另一条很长记录 ${index} ${"y".repeat(500)}` })) },
  ],
  { perDayBlockLimit: 3, maxChars: 1000 },
);
assert.ok(truncatedTimeline.includes("当天还有"));
assert.ok(truncatedTimeline.includes("上下文上限"));

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
assert.strictEqual(countEmbeddedUnits([{ embedding: [1] }, { embedding: [] }, {}, { embedding: [0, 1] }]), 2);

const manyRanked = rankChunks(
  Array.from({ length: 40 }, (_, index) => ({ id: `item-${index}`, text: `item ${index}`, embedding: [1, index / 100] })),
  [1, 0],
  40,
);
assert.strictEqual(manyRanked.length, 40);

const boostedRanked = rankChunks(
  [
    { id: "near", text: "普通", embedding: [0.99, 0.01] },
    { id: "scoped", text: "笔记本命中", embedding: [0.94, 0.06], rankBoost: 0.08 },
  ],
  [1, 0],
  2,
);
assert.strictEqual(boostedRanked[0].chunk.id, "scoped");

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
const timelineMessages = buildMessages(config, "6/18 干了啥", [], [], {
  timeline: {
    range: { start: "2026-06-18", end: "2026-06-18", label: "2026-06-18" },
    context: "【2026-06-18】\n- 修复 Markdown 渲染",
  },
});
assert.ok(timelineMessages[0].content.includes("时间段记录"));
assert.ok(timelineMessages[1].content.includes("时间段记录：2026-06-18"));
assert.ok(timelineMessages[1].content.includes("修复 Markdown 渲染"));

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
assert.throws(() => parseModelProxyJson({ status: 401, body: "bad key" }, "Chat"), /问答配置/);
{
  let missingKeyError = null;
  try {
    parseModelProxyJson(
      {
        status: 401,
        body: '{"error":{"message":"You didn\'t provide an API key. You need to provide your API key in an Authorization header using Bearer auth."}}',
      },
      "Embedding",
    );
  } catch (error) {
    missingKeyError = error;
  }
  assert.ok(missingKeyError);
  assert.strictEqual(missingKeyError.status, 401);
  assert.match(missingKeyError.message, /未提供 API Key/);
  assert.match(missingKeyError.message, /索引配置/);
  assert.match(missingKeyError.message, /Ollama/);
  assert.strictEqual(missingKeyError.providerMessage, "You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth.");
}
assert.throws(
  () => parseModelProxyJson({ status: 404, body: '{"error":{"message":"Requested entity was not found."}}' }, "Embedding"),
  /gemini-embedding-2-preview/,
);
assert.strictEqual(extractRetryDelayMs("Please retry in 32.307986642s."), 32308);
{
  let quotaError = null;
  try {
    parseModelProxyJson({ status: 429, body: '{"error":{"message":"Please retry in 32.307986642s.","status":"RESOURCE_EXHAUSTED"}}' }, "Embedding");
  } catch (error) {
    quotaError = error;
  }
  assert.ok(quotaError);
  assert.strictEqual(quotaError.status, 429);
  assert.strictEqual(quotaError.retryDelayMs, 32308);
  assert.match(quotaError.message, /限流/);
}

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
  getIndexManifestError({ version: 1, shards: [{ path: "old" }], embeddingModel: config.embeddingModel }, config.embeddingModel, 2),
  /版本不兼容/,
);
assert.strictEqual(
  getIndexManifestError({ version: 2, schemaVersion: 2, shards: [{ path: "new" }], embeddingModel: config.embeddingModel }, config.embeddingModel, 2),
  "",
);

// 多模型 profile：旧单 provider 配置应自动迁移，角色 id 应落到有效 profile
{
  const migrated = mergeConfig({
    baseUrl: "http://localhost:11434/v1",
    chatModel: "llama3.2",
    embeddingModel: "nomic-embed-text",
    proxyMode: "bad-mode",
  });
  assert.strictEqual(migrated.profiles.length, 1);
  assert.strictEqual(migrated.profiles[0].id, "default");
  assert.strictEqual(migrated.profiles[0].baseUrl, "http://127.0.0.1:11434/v1");
  assert.strictEqual(migrated.profiles[0].chatModel, "llama3.2");
  assert.strictEqual(migrated.profiles[0].embeddingModel, "nomic-embed-text");
  assert.strictEqual(migrated.profiles[0].proxyMode, "system");
  assert.strictEqual(migrated.indexingProfileId, "default");
  assert.strictEqual(migrated.chatProfileId, "default");

  const multiple = mergeConfig({
    profiles: [
      { id: "main", name: "Main", baseUrl: "https://api.openai.com/v1" },
      { id: "main", name: "Other", baseUrl: "https://example.com/v1", proxyMode: "gateway", proxyGatewayUrl: "http://127.0.0.1:7891/proxy/" },
    ],
    indexingProfileId: "missing",
    chatProfileId: "main",
  });
  assert.strictEqual(multiple.profiles.length, 2);
  assert.strictEqual(multiple.profiles[0].id, "main");
  assert.strictEqual(multiple.profiles[1].id, "main-2");
  assert.strictEqual(multiple.indexingProfileId, "main");
  assert.strictEqual(multiple.chatProfileId, "main");
  assert.strictEqual(multiple.profiles[1].proxyGatewayUrl, "http://127.0.0.1:7891/proxy");
}

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
assert.strictEqual(geminiPreset.embeddingModel, "gemini-embedding-2-preview");
const ollamaPreset = PROVIDER_PRESETS.find((p) => p.id === "ollama");
assert.ok(ollamaPreset);
assert.strictEqual(ollamaPreset.chatModel, "qwen3:14b");
assert.strictEqual(ollamaPreset.embeddingModel, "qwen3-embedding:4b");

const migratedGeminiProfile = mergeConfig({
  profiles: [
    {
      id: "gemini",
      name: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      chatModel: "gemini-3.5-flash",
      embeddingModel: "gemini-embedding-001",
    },
  ],
});
assert.strictEqual(migratedGeminiProfile.profiles[0].embeddingModel, "gemini-embedding-2-preview");

assert.ok(Array.isArray(PROXY_MODE_OPTIONS));
assert.ok(PROXY_MODE_OPTIONS.some((item) => item.id === "system"));
assert.ok(PROXY_MODE_OPTIONS.some((item) => item.id === "gateway"));

// computeNotebookQuotas：笔记本配额采样
{
  const { computeNotebookQuotas } = require("../lib/core");
  // 总量未超上限：全量，各笔记本返回真实块数
  const full = computeNotebookQuotas({ a: 100, b: 200 }, 1000);
  assert.deepStrictEqual(full, { a: 100, b: 200 });

  // 用户真实场景：4 个笔记本 27648 块，上限 12000，每个笔记本都应有非零配额
  const realCounts = {
    "20221129151653-cx2hgpt": 15739, // 笔记库
    "20230105142030-zll00ti": 5960, // tem
    "20221130134134-kx6yh5d": 3386, // 通用性技术文档
    "20240326171438-cqbp67x": 2563, // 工作
  };
  const quotas = computeNotebookQuotas(realCounts, 12000);
  const boxes = Object.keys(quotas);
  assert.strictEqual(boxes.length, 4);
  // 每个笔记本都必须有非零配额（修复的核心诉求）
  for (const box of boxes) {
    assert.ok(quotas[box] > 0, `笔记本 ${box} 配额为 0`);
  }
  // 配额总和不超过上限
  const totalQuota = boxes.reduce((sum, box) => sum + quotas[box], 0);
  assert.ok(totalQuota <= 12000, `配额总和 ${totalQuota} 超过上限`);
  // 大笔记本拿到更多配额
  assert.ok(quotas["20221129151653-cx2hgpt"] > quotas["20240326171438-cqbp67x"]);
  // 小笔记本（2563 块）配额不超过其真实块数
  assert.ok(quotas["20240326171438-cqbp67x"] <= 2563);

  // 边界：空输入
  assert.deepStrictEqual(computeNotebookQuotas({}, 1000), {});
  assert.deepStrictEqual(computeNotebookQuotas({ a: 0, b: 0 }, 1000), {});

  // 小笔记本块数少于保底配额：不应超额分配
  const skewed = computeNotebookQuotas({ big: 10000, tiny: 10 }, 5000);
  assert.ok(skewed.tiny <= 10);
  assert.ok(skewed.big > 0);
}

console.log("core tests passed");
