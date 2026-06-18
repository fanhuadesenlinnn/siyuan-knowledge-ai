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
  enableAiSummaries: false,
  aiSummaryMaxUnits: 120,
  batchSize: 32,
  shardSize: 80,
  modelTimeoutMs: 120000,
  proxyMode: "system",
  proxyGatewayUrl: "",
  proxyFallback: true,
  autoIndexOnStart: false,
  autoIndexEveryHours: 24,
  defaultNotebook: "",
  defaultPath: "/Knowledge AI",
  allowWriteActions: true,
  systemPrompt:
    "你是用户的个人思源笔记 AI 助手。优先依据笔记证据回答；证据不足时明确说明。回答要简洁、可执行，并在需要时给出引用编号。",
};

const INDEX_SCHEMA_VERSION = 2;

const PROXY_MODE_OPTIONS = [
  { id: "system", label: "系统代理优先" },
  { id: "siyuan", label: "思源转发" },
  { id: "direct", label: "浏览器直连" },
  { id: "gateway", label: "自定义转发网关" },
];

const MODEL_ROUTE_LABELS = {
  direct: "浏览器直连",
  siyuan: "思源转发",
  gateway: "自定义转发网关",
};

const NON_FALLBACK_STATUSES = new Set([401, 403, 404, 429]);

function mergeConfig(saved) {
  return Object.assign({}, DEFAULT_CONFIG, saved || {});
}

// 模型服务商预设：均走 OpenAI 兼容协议，现有调用层无需区分
// 自定义（custom）不在预设中，由 detectProvider 在无法匹配时返回
const PROVIDER_PRESETS = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    chatModel: "gpt-4.1-mini",
    embeddingModel: "text-embedding-3-small",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    chatModel: "gemini-3.5-flash",
    embeddingModel: "gemini-embedding-001",
  },
  {
    id: "ollama",
    label: "Ollama (本地)",
    baseUrl: "http://127.0.0.1:11434/v1",
    chatModel: "llama3.2",
    embeddingModel: "nomic-embed-text",
  },
];

// 根据 baseUrl 反推服务商 id，用于设置页下拉显示当前选中项
function detectProvider(baseUrl) {
  const value = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!value) return "custom";
  for (const preset of PROVIDER_PRESETS) {
    if (value === preset.baseUrl.replace(/\/+$/, "")) return preset.id;
  }
  // 容错：匹配到 host 也算命中（用户可能改过路径但仍是同一服务商）
  for (const preset of PROVIDER_PRESETS) {
    const host = preset.baseUrl.replace(/^https?:\/\//, "").split("/")[0];
    if (value.includes(host)) return preset.id;
  }
  if (isLocalModelBaseUrl(value)) return "ollama";
  return "custom";
}

function normalizeBaseUrl(value) {
  const base = String(value || DEFAULT_CONFIG.baseUrl).trim();
  return base.replace(/\/+$/, "");
}

function parseUrl(value) {
  try {
    return new URL(normalizeBaseUrl(value));
  } catch (error) {
    return null;
  }
}

function isLocalModelBaseUrl(value) {
  const url = parseUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "0.0.0.0";
}

function normalizeModelBaseUrlForRequest(value) {
  const normalized = normalizeBaseUrl(value);
  const url = parseUrl(normalized);
  if (!url) return normalized;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]" || host === "0.0.0.0") {
    const port = url.port ? `:${url.port}` : "";
    return `${url.protocol}//127.0.0.1${port}${url.pathname}${url.search}${url.hash}`.replace(/\/+$/, "");
  }
  return url.toString().replace(/\/+$/, "");
}

function normalizeProxyMode(value) {
  const mode = String(value || DEFAULT_CONFIG.proxyMode).trim().toLowerCase();
  return PROXY_MODE_OPTIONS.some((item) => item.id === mode) ? mode : DEFAULT_CONFIG.proxyMode;
}

function getModelRequestRoutes(config, baseUrl) {
  if (isLocalModelBaseUrl(baseUrl || (config && config.baseUrl))) return ["direct"];
  const mode = normalizeProxyMode(config && config.proxyMode);
  if (mode === "siyuan") return ["siyuan"];
  if (mode === "direct") return ["direct"];
  if (mode === "gateway") return ["gateway"];
  return config && config.proxyFallback === false ? ["direct"] : ["direct", "siyuan"];
}

function modelRouteLabel(route) {
  return MODEL_ROUTE_LABELS[route] || route || "未知路由";
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

function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const text = String(value == null ? "" : value).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function limitText(text, maxLength) {
  const value = String(text || "").replace(/\r\n/g, "\n").trim();
  const limit = clampNumber(maxLength, 200, 20000, 4000);
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trim()}\n...`;
}

function stripMarkdown(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\(\(([0-9]{14}-[a-z0-9]{7})(?:\s+"([^"]*)")?\)\)/g, "$2")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}

function normalizeRow(row) {
  const source = row || {};
  const id = String(source.id || "").trim();
  const rootId = String(source.root_id || source.rootID || source.rootId || id).trim();
  const parentId = String(source.parent_id || source.parentID || source.parentId || "").trim();
  const markdown = String(source.markdown || source.kramdown || source.content || source.fcontent || "").trim();
  const content = String(source.content || stripMarkdown(markdown)).trim();
  const hpath = String(source.hpath || source.hPath || "").trim();
  const path = String(source.path || "").trim();
  const type = String(source.type || "").trim();
  const subtype = String(source.subtype || source.subType || "").trim();
  return Object.assign({}, source, {
    id,
    rootId,
    root_id: rootId,
    parentId,
    parent_id: parentId,
    box: String(source.box || "").trim(),
    path,
    hpath,
    hPath: hpath,
    type,
    subtype,
    subType: subtype,
    content,
    markdown,
    updated: String(source.updated || "").trim(),
  });
}

function rowText(row) {
  const normalized = normalizeRow(row);
  return String(normalized.markdown || normalized.content || normalized.fcontent || "").trim();
}

function pathTail(value) {
  const parts = String(value || "")
    .split("/")
    .map((item) => item.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function headingLevel(row) {
  const normalized = normalizeRow(row);
  if (normalized.type !== "h") return 0;
  const subtypeMatch = String(normalized.subtype || "").match(/h([1-6])/i);
  if (subtypeMatch) return Number(subtypeMatch[1]);
  const markdownMatch = rowText(normalized).match(/^\s{0,3}(#{1,6})\s+/);
  return markdownMatch ? markdownMatch[1].length : 1;
}

function blockTitle(row) {
  const normalized = normalizeRow(row);
  if (normalized.type === "d") return pathTail(normalized.hpath) || stripMarkdown(normalized.content) || normalized.id;
  if (normalized.type === "h") return stripMarkdown(rowText(normalized)) || normalized.content || normalized.id;
  return stripMarkdown(normalized.content) || pathTail(normalized.hpath) || normalized.id;
}

function compareRows(a, b) {
  const left = normalizeRow(a);
  const right = normalizeRow(b);
  return (
    left.box.localeCompare(right.box) ||
    left.rootId.localeCompare(right.rootId) ||
    left.path.localeCompare(right.path) ||
    left.id.localeCompare(right.id)
  );
}

function normalizeAttrsMap(attrs) {
  if (!attrs) return {};
  if (!Array.isArray(attrs) && typeof attrs === "object") {
    const mapped = {};
    for (const [id, value] of Object.entries(attrs)) {
      if (value && typeof value === "object" && !Array.isArray(value)) mapped[id] = Object.assign({}, value);
    }
    return mapped;
  }
  const result = {};
  for (const row of attrs || []) {
    const blockId = String(row.block_id || row.blockID || row.blockId || row.id || "").trim();
    const name = String(row.name || row.key || "").trim();
    if (!blockId || !name) continue;
    if (!result[blockId]) result[blockId] = {};
    result[blockId][name] = row.value == null ? "" : String(row.value);
  }
  return result;
}

function splitAttrList(value) {
  return String(value || "")
    .split(/[,，;；\n]/)
    .map((item) => item.trim().replace(/^#+|#+$/g, ""))
    .filter(Boolean);
}

function extractTextTags(text) {
  const tags = [];
  const value = String(text || "");
  const regex = /(^|[\s([（])#([^#\s][^#\n]{0,60}?)#/g;
  let match;
  while ((match = regex.exec(value))) tags.push(match[2].trim());
  return tags;
}

function extractTags(row, attrs) {
  const attrTags = [];
  for (const [key, value] of Object.entries(attrs || {})) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "tags" || normalizedKey === "tag" || normalizedKey === "custom-tags" || normalizedKey === "custom-tag") {
      attrTags.push(...splitAttrList(value));
    }
  }
  return unique([...attrTags, ...extractTextTags(rowText(row))]);
}

function parseTextRefs(text) {
  const refs = [];
  const value = String(text || "");
  const blockRef = /\(\(([0-9]{14}-[a-z0-9]{7})(?:\s+"[^"]*")?\)\)/g;
  const blockUrl = /siyuan:\/\/blocks\/([0-9]{14}-[a-z0-9]{7})/g;
  let match;
  while ((match = blockRef.exec(value))) refs.push(match[1]);
  while ((match = blockUrl.exec(value))) refs.push(match[1]);
  return refs;
}

function normalizeRefs(refs) {
  const outgoing = {};
  const backlinks = {};
  const add = (source, target) => {
    const from = String(source || "").trim();
    const to = String(target || "").trim();
    if (!from || !to || from === to) return;
    if (!outgoing[from]) outgoing[from] = [];
    if (!backlinks[to]) backlinks[to] = [];
    outgoing[from].push(to);
    backlinks[to].push(from);
  };

  if (Array.isArray(refs)) {
    for (const row of refs) {
      add(row.block_id || row.blockID || row.blockId || row.source_id || row.sourceId, row.def_block_id || row.defBlockId || row.def_id || row.target_id || row.targetId);
    }
  } else if (refs && typeof refs === "object") {
    if (refs.outgoing || refs.backlinks) {
      for (const [source, targets] of Object.entries(refs.outgoing || {})) {
        for (const target of targets || []) add(source, target);
      }
      for (const [target, sources] of Object.entries(refs.backlinks || {})) {
        for (const source of sources || []) add(source, target);
      }
    } else {
      for (const [source, targets] of Object.entries(refs)) {
        for (const target of targets || []) add(source, target);
      }
    }
  }

  for (const [source, targets] of Object.entries(outgoing)) outgoing[source] = unique(targets);
  for (const [target, sources] of Object.entries(backlinks)) backlinks[target] = unique(sources);
  return { outgoing, backlinks };
}

function mergeAttrs(rows, attrsMap) {
  const merged = {};
  for (const row of rows || []) {
    const attrs = attrsMap[normalizeRow(row).id] || {};
    for (const [key, value] of Object.entries(attrs)) {
      if (!merged[key]) merged[key] = [];
      merged[key].push(value);
    }
  }
  const result = {};
  for (const [key, values] of Object.entries(merged)) {
    const list = unique(values);
    result[key] = list.length <= 1 ? list[0] || "" : list;
  }
  return result;
}

function collectRowMetadata(rows, attrsMap, refMaps) {
  const tags = [];
  const refs = [];
  const backlinks = [];
  for (const row of rows || []) {
    const normalized = normalizeRow(row);
    const attrs = attrsMap[normalized.id] || {};
    tags.push(...extractTags(normalized, attrs));
    refs.push(...(refMaps.outgoing[normalized.id] || []), ...parseTextRefs(rowText(normalized)));
    backlinks.push(...(refMaps.backlinks[normalized.id] || []));
  }
  return {
    tags: unique(tags),
    attrs: mergeAttrs(rows, attrsMap),
    refs: unique(refs),
    backlinks: unique(backlinks),
  };
}

function formatMetadataLines(unit) {
  const lines = [];
  if (unit.title) lines.push(`标题: ${unit.title}`);
  if (unit.hpath) lines.push(`路径: ${unit.hpath}`);
  if (unit.box) lines.push(`笔记本: ${unit.notebookName || unit.box}`);
  if (unit.tags && unit.tags.length) lines.push(`标签: ${unit.tags.map((tag) => `#${tag}`).join(" ")}`);
  if (unit.refs && unit.refs.length) lines.push(`引用: ${unit.refs.slice(0, 20).join(", ")}`);
  if (unit.backlinks && unit.backlinks.length) lines.push(`反链: ${unit.backlinks.slice(0, 20).join(", ")}`);
  return lines;
}

function buildUnitContext(unit, options) {
  const config = options || {};
  const maxLength = clampNumber(config.unitTextLength || config.chunkSize * 4, 1000, 16000, 3600);
  const typeLabel = {
    block: "块",
    section: "章节",
    document: "文档",
    notebook: "笔记本",
    vault: "全库",
  }[unit.type] || unit.type;
  const lines = [`知识层级: ${typeLabel}`, ...formatMetadataLines(unit), "", unit.text || ""];
  return limitText(lines.join("\n"), maxLength);
}

function makeUnit(input, options) {
  const rows = (input.rows || []).map(normalizeRow);
  const primary = normalizeRow(input.primary || rows[0] || {});
  const metadata = input.metadata || { tags: [], attrs: {}, refs: [], backlinks: [] };
  const text = limitText(input.text || rows.map((row) => rowText(row)).filter(Boolean).join("\n\n"), options && (options.chunkSize * 4 || 3600));
  const sourceBlockIds = unique(input.sourceBlockIds || rows.map((row) => row.id).filter(Boolean));
  const unit = {
    id: input.id,
    type: input.type,
    blockId: input.blockId == null ? primary.id : input.blockId,
    rootId: input.rootId == null ? primary.rootId : input.rootId,
    parentId: input.parentId == null ? primary.parentId : input.parentId,
    box: input.box == null ? primary.box : input.box,
    notebookName: input.notebookName || "",
    path: input.path == null ? primary.path : input.path,
    hpath: input.hpath == null ? primary.hpath : input.hpath,
    title: input.title || blockTitle(primary),
    text,
    tags: unique(metadata.tags || []),
    attrs: metadata.attrs || {},
    refs: unique(metadata.refs || []),
    backlinks: unique(metadata.backlinks || []),
    sourceBlockIds,
    updated: input.updated || rows.map((row) => row.updated).sort().pop() || primary.updated || "",
  };
  unit.contextText = input.contextText || buildUnitContext(unit, options || {});
  unit.hash = stableHash(
    [
      unit.id,
      unit.type,
      unit.updated,
      unit.contextText,
      unit.tags.join(","),
      unit.refs.join(","),
      unit.backlinks.join(","),
    ].join("\n"),
  );
  return unit;
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
  const normalized = normalizeRow(row);
  const id = normalized.id;
  const content = rowText(normalized);
  if (!id || !content) return [];
  const attrsMap = normalizeAttrsMap(options && options.attrs);
  const refMaps = normalizeRefs(options && options.refs);
  const attrs = attrsMap[id] || {};
  const metadata = collectRowMetadata([normalized], Object.assign({}, attrsMap, { [id]: attrs }), refMaps);
  metadata.refs = unique([...metadata.refs, ...parseTextRefs(content)]);
  const parts = chunkText(content, options);
  return parts.map((part, index) => ({
    id: `${id}:block:${index}`,
    type: "block",
    blockId: id,
    rootId: normalized.rootId,
    parentId: normalized.parentId,
    box: normalized.box,
    path: normalized.path,
    hpath: normalized.hpath,
    title: blockTitle(normalized),
    tags: metadata.tags,
    attrs: metadata.attrs,
    refs: metadata.refs,
    backlinks: metadata.backlinks,
    sourceBlockIds: [id],
    updated: normalized.updated,
    text: part,
    contextText: buildUnitContext(
      {
        type: "block",
        title: blockTitle(normalized),
        hpath: normalized.hpath,
        box: normalized.box,
        tags: metadata.tags,
        refs: metadata.refs,
        backlinks: metadata.backlinks,
        text: part,
      },
      options || {},
    ),
    hash: stableHash(`${id}\n${normalized.updated}\n${part}\n${metadata.tags.join(",")}`),
  }));
}

function groupRowsByRoot(rows) {
  const groups = new Map();
  for (const row of (rows || []).map(normalizeRow).filter((item) => item.id)) {
    const key = row.rootId || row.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const group of groups.values()) group.sort(compareRows);
  return groups;
}

function buildBlockUnits(rows, attrs, refs, options) {
  const config = options || {};
  const attrsMap = normalizeAttrsMap(attrs);
  const refMaps = normalizeRefs(refs);
  const units = [];
  for (const row of rows || []) {
    const normalized = normalizeRow(row);
    if (!normalized.id || !rowText(normalized)) continue;
    units.push(...blockToChunks(normalized, Object.assign({}, config, { attrs: attrsMap, refs: refMaps })));
  }
  return units;
}

function getDocRow(rows, rootId) {
  return rows.find((row) => row.id === rootId && row.type === "d") || rows.find((row) => row.type === "d") || rows[0] || {};
}

function sectionTitlePath(docRow, headingRow) {
  const docPath = normalizeRow(docRow).hpath || blockTitle(docRow);
  const heading = headingRow ? blockTitle(headingRow) : "";
  if (!heading || heading === docPath || String(docPath).endsWith(`/${heading}`)) return docPath || heading;
  return `${docPath} / ${heading}`;
}

function makeSectionUnit(rootId, docRow, sectionRows, titleRow, attrsMap, refMaps, options, suffix) {
  const rows = sectionRows.map(normalizeRow).filter((row) => row.id && rowText(row));
  if (!rows.length) return null;
  const anchor = normalizeRow(titleRow || rows[0] || docRow);
  const metadata = collectRowMetadata(rows, attrsMap, refMaps);
  const text = rows
    .map((row) => {
      const prefix = row.type === "h" ? `${"#".repeat(headingLevel(row) || 1)} ` : "";
      return `${prefix}${rowText(row)}`.trim();
    })
    .filter(Boolean)
    .join("\n\n");
  const title = sectionTitlePath(docRow, titleRow || rows[0]);
  return makeUnit(
    {
      id: `${rootId}:section:${suffix || anchor.id}`,
      type: "section",
      blockId: anchor.id || rootId,
      rootId,
      parentId: anchor.parentId,
      box: anchor.box || normalizeRow(docRow).box,
      path: anchor.path || normalizeRow(docRow).path,
      hpath: title,
      title,
      rows,
      primary: anchor,
      metadata,
      text,
    },
    options,
  );
}

function buildFallbackSections(rootId, docRow, bodyRows, attrsMap, refMaps, options) {
  const units = [];
  const maxLength = clampNumber(options && options.chunkSize, 200, 4000, DEFAULT_CONFIG.chunkSize) * 2;
  let bucket = [];
  let length = 0;
  const flush = () => {
    if (!bucket.length) return;
    const unit = makeSectionUnit(rootId, docRow, bucket, bucket[0], attrsMap, refMaps, options, `window-${units.length + 1}`);
    if (unit) units.push(unit);
    bucket = [];
    length = 0;
  };
  for (const row of bodyRows) {
    const text = rowText(row);
    if (!text) continue;
    if (bucket.length && length + text.length > maxLength) flush();
    bucket.push(row);
    length += text.length;
  }
  flush();
  return units;
}

function buildSectionUnits(rows, attrs, refs, options) {
  const attrsMap = normalizeAttrsMap(attrs);
  const refMaps = normalizeRefs(refs);
  const groups = groupRowsByRoot(rows);
  const units = [];
  for (const [rootId, docRows] of groups.entries()) {
    const docRow = getDocRow(docRows, rootId);
    const bodyRows = docRows.filter((row) => row.id !== normalizeRow(docRow).id && row.type !== "d");
    const headingIndexes = [];
    for (let index = 0; index < bodyRows.length; index += 1) {
      if (headingLevel(bodyRows[index])) headingIndexes.push(index);
    }

    if (!headingIndexes.length) {
      units.push(...buildFallbackSections(rootId, docRow, bodyRows.length ? bodyRows : [docRow], attrsMap, refMaps, options));
      continue;
    }

    if (headingIndexes[0] > 0) {
      const preamble = bodyRows.slice(0, headingIndexes[0]);
      const unit = makeSectionUnit(rootId, docRow, preamble, preamble[0] || docRow, attrsMap, refMaps, options, "preamble");
      if (unit) units.push(unit);
    }

    for (let pointer = 0; pointer < headingIndexes.length; pointer += 1) {
      const start = headingIndexes[pointer];
      const level = headingLevel(bodyRows[start]);
      let end = bodyRows.length;
      for (let nextPointer = pointer + 1; nextPointer < headingIndexes.length; nextPointer += 1) {
        const nextIndex = headingIndexes[nextPointer];
        if (headingLevel(bodyRows[nextIndex]) <= level) {
          end = nextIndex;
          break;
        }
      }
      const sectionRows = bodyRows.slice(start, end);
      const unit = makeSectionUnit(rootId, docRow, sectionRows, bodyRows[start], attrsMap, refMaps, options, bodyRows[start].id);
      if (unit) units.push(unit);
    }
  }
  return units;
}

function buildDocumentUnits(rows, sectionUnits, attrs, refs, options) {
  const attrsMap = normalizeAttrsMap(attrs);
  const refMaps = normalizeRefs(refs);
  const groups = groupRowsByRoot(rows);
  const sectionsByRoot = {};
  for (const section of sectionUnits || []) {
    if (!sectionsByRoot[section.rootId]) sectionsByRoot[section.rootId] = [];
    sectionsByRoot[section.rootId].push(section);
  }

  const units = [];
  for (const [rootId, docRows] of groups.entries()) {
    const docRow = normalizeRow(getDocRow(docRows, rootId));
    const sections = sectionsByRoot[rootId] || [];
    const metadata = collectRowMetadata(docRows, attrsMap, refMaps);
    const title = docRow.hpath || blockTitle(docRow);
    const sectionList = sections.map((section) => `- ${section.title}`).join("\n");
    const keyText = sections.map((section) => `${section.title}\n${limitText(section.text, 700)}`).join("\n\n");
    units.push(
      makeUnit(
        {
          id: `${rootId}:document`,
          type: "document",
          blockId: rootId,
          rootId,
          parentId: docRow.parentId,
          box: docRow.box,
          path: docRow.path,
          hpath: title,
          title,
          rows: docRows,
          primary: docRow,
          metadata,
          sourceBlockIds: unique([rootId, ...sections.flatMap((section) => section.sourceBlockIds || [])]),
          text: [`文档: ${title}`, sectionList ? `章节:\n${sectionList}` : "", keyText].filter(Boolean).join("\n\n"),
        },
        options,
      ),
    );
  }
  return units;
}

function buildNotebookAndVaultUnits(documentUnits, options) {
  const config = options || {};
  const notebookNames = config.notebooks || config.notebookNames || {};
  const byNotebook = new Map();
  for (const doc of documentUnits || []) {
    const box = doc.box || "unknown";
    if (!byNotebook.has(box)) byNotebook.set(box, []);
    byNotebook.get(box).push(doc);
  }

  const units = [];
  for (const [box, docs] of byNotebook.entries()) {
    const title = notebookNames[box] || box || "未命名笔记本";
    const tags = unique(docs.flatMap((doc) => doc.tags || []));
    const text = [
      `笔记本: ${title}`,
      tags.length ? `标签: ${tags.map((tag) => `#${tag}`).join(" ")}` : "",
      "文档:",
      docs.map((doc) => `- ${doc.title}`).join("\n"),
      "",
      docs.map((doc) => `${doc.title}\n${limitText(doc.text, 500)}`).join("\n\n"),
    ]
      .filter(Boolean)
      .join("\n");
    units.push(
      makeUnit(
        {
          id: `${box}:notebook`,
          type: "notebook",
          blockId: "",
          rootId: "",
          parentId: "",
          box,
          notebookName: title,
          path: "",
          hpath: title,
          title,
          metadata: { tags, attrs: {}, refs: unique(docs.flatMap((doc) => doc.refs || [])), backlinks: unique(docs.flatMap((doc) => doc.backlinks || [])) },
          sourceBlockIds: unique(docs.flatMap((doc) => doc.sourceBlockIds || [])),
          text,
          updated: docs.map((doc) => doc.updated).sort().pop() || "",
        },
        config,
      ),
    );
  }

  if (documentUnits && documentUnits.length) {
    const tags = unique(documentUnits.flatMap((doc) => doc.tags || []));
    const text = [
      "全库主题",
      tags.length ? `标签: ${tags.map((tag) => `#${tag}`).join(" ")}` : "",
      "笔记本:",
      units.map((unit) => `- ${unit.title}`).join("\n"),
      "",
      "文档:",
      documentUnits.map((doc) => `- ${doc.title}`).join("\n"),
    ]
      .filter(Boolean)
      .join("\n");
    units.push(
      makeUnit(
        {
          id: "vault:all",
          type: "vault",
          blockId: "",
          rootId: "",
          parentId: "",
          box: "",
          path: "",
          hpath: "全库",
          title: "全库",
          metadata: { tags, attrs: {}, refs: unique(documentUnits.flatMap((doc) => doc.refs || [])), backlinks: unique(documentUnits.flatMap((doc) => doc.backlinks || [])) },
          sourceBlockIds: unique(documentUnits.flatMap((doc) => doc.sourceBlockIds || [])),
          text,
          updated: documentUnits.map((doc) => doc.updated).sort().pop() || "",
        },
        config,
      ),
    );
  }
  return units;
}

function buildKnowledgeUnits(rows, attrs, refs, options) {
  const normalizedRows = (rows || []).map(normalizeRow).filter((row) => row.id && rowText(row));
  const blockUnits = buildBlockUnits(normalizedRows, attrs, refs, options);
  const sectionUnits = buildSectionUnits(normalizedRows, attrs, refs, options);
  const documentUnits = buildDocumentUnits(normalizedRows, sectionUnits, attrs, refs, options);
  const topicUnits = buildNotebookAndVaultUnits(documentUnits, options);
  return [...blockUnits, ...sectionUnits, ...documentUnits, ...topicUnits];
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

function extractQueryTerms(question) {
  const text = String(question || "").toLowerCase();
  const terms = [];
  const tagRegex = /#([^#\s]{1,60})#?/g;
  let match;
  while ((match = tagRegex.exec(text))) terms.push(match[1]);
  for (const token of text.split(/[\s,，。；;:：!?！？()[\]{}"'`、/\\|]+/)) {
    const clean = token.trim();
    if (clean.length >= 2) terms.push(clean);
  }
  const chinese = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const segment of chinese) {
    terms.push(segment);
    if (segment.length > 4) {
      for (let index = 0; index <= segment.length - 2; index += 2) terms.push(segment.slice(index, index + 2));
    }
  }
  return unique(terms).slice(0, 40);
}

function isMacroQuestion(question) {
  return /全库|整个|所有|整体|总览|概览|主题|主要|文档|笔记本|知识库|笔记库|总结|脉络/.test(String(question || ""));
}

function exactMatchScore(unit, question) {
  const terms = extractQueryTerms(question);
  if (!terms.length) return 0;
  const title = String(unit.title || "").toLowerCase();
  const hpath = String(unit.hpath || unit.path || "").toLowerCase();
  const text = String(unit.text || unit.contextText || "").toLowerCase();
  const tags = (unit.tags || []).map((tag) => String(tag).toLowerCase());
  let score = 0;
  for (const term of terms) {
    if (tags.some((tag) => tag === term || tag.includes(term) || term.includes(tag))) score += 0.12;
    if (title.includes(term)) score += 0.08;
    if (hpath.includes(term)) score += 0.05;
    if (unit.blockId && term === String(unit.blockId).toLowerCase()) score += 0.2;
    if (text.includes(term)) score += 0.02;
  }
  return Math.min(0.45, score);
}

function typeBoost(unit, question) {
  const type = unit.type || "block";
  const macro = isMacroQuestion(question);
  if (macro && type === "vault") return 0.12;
  if (macro && type === "notebook") return 0.1;
  if (macro && type === "document") return 0.08;
  if (type === "section") return 0.05;
  if (type === "document") return 0.025;
  if (type === "block") return 0.01;
  if (type === "notebook" || type === "vault") return macro ? 0.06 : -0.03;
  return 0;
}

function rankChunks(chunks, queryEmbedding, topK, question) {
  const limit = clampNumber(topK, 1, 30, DEFAULT_CONFIG.topK);
  const scored = (chunks || [])
    .filter((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length)
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding) + exactMatchScore(chunk, question) + typeBoost(chunk, question),
    }));
  const roots = {};
  for (const item of scored) {
    const rootId = item.chunk.rootId || item.chunk.blockId || "";
    if (!rootId) continue;
    roots[rootId] = (roots[rootId] || 0) + 1;
  }
  for (const item of scored) {
    const rootId = item.chunk.rootId || item.chunk.blockId || "";
    if (rootId && roots[rootId] > 1) item.score += Math.min(0.08, (roots[rootId] - 1) * 0.01);
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function countEmbeddedUnits(units) {
  return (units || []).filter((unit) => Array.isArray(unit && unit.embedding) && unit.embedding.length).length;
}

function unitTypeLabel(unit) {
  return (
    {
      block: "块",
      section: "章节",
      document: "文档",
      notebook: "笔记本",
      vault: "全库",
    }[unit && unit.type] || "片段"
  );
}

function buildContext(ranked) {
  return ranked
    .map((item, index) => {
      const chunk = item.chunk;
      const title = chunk.hpath || chunk.title || chunk.blockId;
      const sourceBlockIds = chunk.sourceBlockIds && chunk.sourceBlockIds.length ? chunk.sourceBlockIds.slice(0, 8).join(", ") : chunk.blockId;
      return [
        `[${index + 1}] ${unitTypeLabel(chunk)} / ${title}`,
        chunk.blockId ? `blockId: ${chunk.blockId}` : "",
        sourceBlockIds ? `sourceBlocks: ${sourceBlockIds}` : "",
        `score: ${item.score.toFixed(4)}`,
        chunk.summary ? `summary: ${chunk.summary}` : "",
        chunk.contextText || chunk.text,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n---\n\n");
}

function buildMessages(config, question, ranked, history) {
  const context = buildContext(ranked);
  const messages = [
    {
      role: "system",
      content: config.systemPrompt || DEFAULT_CONFIG.systemPrompt,
    },
    {
      role: "user",
      content: [
        "请基于下面的思源笔记知识单元回答问题。",
        "要求：",
        "1. 优先使用知识单元中的事实；章节/文档/笔记本/全库单元用于理解主题，具体结论要尽量落到块级证据。",
        "2. 每个关键结论后标注引用编号，例如 [1]。",
        "3. 如果证据不足以回答，明确说明缺口。",
        "",
        "知识单元：",
        context || "无命中的知识单元。",
        "",
        "问题：",
        String(question || "").trim(),
      ].join("\n"),
    },
  ];
  const previous = Array.isArray(history) ? history : [];
  if (previous.length) {
    // 把多轮历史插在 system 之后、检索上下文之前，让模型带上之前的对话记忆
    const historyMessages = previous
      .filter((item) => item && (item.role === "user" || item.role === "assistant") && item.content)
      .map((item) => ({ role: item.role, content: String(item.content) }));
    if (historyMessages.length) {
      messages.splice(1, 0, ...historyMessages);
    }
  }
  return messages;
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

function buildGatewayProxyPayload(gatewayUrl, url, apiKey, payload, timeout) {
  const gateway = String(gatewayUrl || "").trim().replace(/\/+$/, "");
  if (!gateway) throw new Error("请填写自定义转发网关 URL");
  return {
    gatewayUrl: gateway,
    payload: buildModelProxyPayload(url, apiKey, payload, timeout),
  };
}

function buildModelRequestHeaders(apiKey) {
  const headers = { "Content-Type": "application/json" };
  const token = String(apiKey || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function parseModelProxyJson(proxyResponse, label) {
  const response = proxyResponse || {};
  const status = Number(response.status || 0);
  const body = String(response.body || "");
  if (status < 200 || status >= 300) {
    const detail = body.length > 600 ? `${body.slice(0, 600)}...` : body;
    const error = new Error(`${label} API ${status || "请求失败"}: ${detail || response.url || "无响应内容"}`);
    error.status = status || 0;
    error.isNetworkError = false;
    throw error;
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    const parseError = new Error(`${label} API 返回的不是 JSON`);
    parseError.status = status || 0;
    parseError.isNetworkError = false;
    throw parseError;
  }
}

function isFallbackAllowed(error, config, remainingRoutes) {
  if (!remainingRoutes || !remainingRoutes.length) return false;
  if (config && config.proxyFallback === false) return false;
  const status = Number(error && error.status ? error.status : 0);
  if (NON_FALLBACK_STATUSES.has(status)) return false;
  return Boolean(error && error.isNetworkError);
}

function markModelRouteError(error, route, isNetworkError) {
  const source = error instanceof Error ? error : new Error(String(error || "请求失败"));
  source.route = route;
  if (typeof source.isNetworkError !== "boolean") source.isNetworkError = Boolean(isNetworkError);
  if (source.name === "AbortError") source.isNetworkError = true;
  return source;
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

function getIndexManifestError(manifest, config, currentVersion) {
  if (!manifest || !Array.isArray(manifest.shards) || !manifest.shards.length) {
    return "索引不存在，请先在设置中更新索引并等待思源同步";
  }
  const expected = currentVersion || INDEX_SCHEMA_VERSION;
  const version = Number(manifest.schemaVersion || manifest.version || 0);
  if (version !== expected) return "索引版本不兼容，请重新更新索引";
  const expectedModel = config && config.embeddingModel;
  if (expectedModel && manifest.embeddingModel !== expectedModel) {
    return `当前 Embedding 模型为 ${expectedModel}，索引使用 ${manifest.embeddingModel}，请切回该模型或重新更新索引`;
  }
  return "";
}

module.exports = {
  DEFAULT_CONFIG,
  INDEX_SCHEMA_VERSION,
  MODEL_ROUTE_LABELS,
  PROXY_MODE_OPTIONS,
  PROVIDER_PRESETS,
  blockToChunks,
  buildBlockUnits,
  buildContext,
  buildDocumentUnits,
  buildGatewayProxyPayload,
  buildKnowledgeUnits,
  buildMessages,
  buildModelProxyPayload,
  buildModelRequestHeaders,
  buildNotebookAndVaultUnits,
  buildSectionUnits,
  chunkText,
  clampNumber,
  cosineSimilarity,
  detectProvider,
  escapeHtml,
  escapeSql,
  extractChatContent,
  extractEmbeddings,
  extractQueryTerms,
  getIndexManifestError,
  getModelRequestRoutes,
  countEmbeddedUnits,
  isFallbackAllowed,
  isLocalModelBaseUrl,
  makeManifestPath,
  makeShardPath,
  mergeConfig,
  markModelRouteError,
  modelRouteLabel,
  normalizeAttrsMap,
  normalizeBaseUrl,
  normalizeModelBaseUrlForRequest,
  normalizeProxyMode,
  normalizeRefs,
  nowIso,
  parseModelProxyJson,
  rankChunks,
  stableHash,
  unitTypeLabel,
};
