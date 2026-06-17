"use strict";

const assert = require("assert");
const {
  blockToChunks,
  buildMessages,
  chunkText,
  cosineSimilarity,
  mergeConfig,
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

console.log("core tests passed");
