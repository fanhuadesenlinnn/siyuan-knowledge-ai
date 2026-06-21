"use strict";

const DEFAULT_CONFIG = {
  baseUrl: "https://api.openai.com/v1",
  chatModel: "gpt-4.1-mini",
  embeddingModel: "text-embedding-3-small",
  temperature: 0.2,
  topK: 8,
  maxIndexedBlocks: 30000,
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
  dailyNotePath: "/daily note",
  enableDailyAiTopics: true,
  dailyAiTopicMaxDays: 30,
  allowWriteActions: true,
  systemPrompt:
    "你是用户的个人思源笔记 AI 助手。优先依据笔记证据回答；证据不足时明确说明。回答要简洁、可执行，并在需要时给出引用编号。",
  // 多 provider profile：索引/检索(embedding) 与日常回答(chat) 可分别选用不同 profile
  // 每个字段：{ id, name, baseUrl, proxyMode, proxyGatewayUrl, proxyFallback, chatModel, embeddingModel, temperature, modelTimeoutMs }
  profiles: [],
  indexingProfileId: "",
  chatProfileId: "",
};

const INDEX_SCHEMA_VERSION = 3;

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
const GEMINI_OPENAI_EMBEDDING_MODEL = "gemini-embedding-2-preview";

// 默认 profile 模板（由旧版单 provider 配置迁移而来，或首次使用时生成）
function makeDefaultProfile(overrides) {
  return Object.assign(
    {
      id: "default",
      name: "默认",
      baseUrl: DEFAULT_CONFIG.baseUrl,
      proxyMode: DEFAULT_CONFIG.proxyMode,
      proxyGatewayUrl: DEFAULT_CONFIG.proxyGatewayUrl,
      proxyFallback: DEFAULT_CONFIG.proxyFallback,
      chatModel: DEFAULT_CONFIG.chatModel,
      embeddingModel: DEFAULT_CONFIG.embeddingModel,
      temperature: DEFAULT_CONFIG.temperature,
      modelTimeoutMs: DEFAULT_CONFIG.modelTimeoutMs,
    },
    overrides || {},
  );
}

function makeProfileId(value, index, used) {
  const raw = String(value || "").trim();
  let id = raw || (index === 0 ? "default" : `profile-${index + 1}`);
  id = id.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!id) id = index === 0 ? "default" : `profile-${index + 1}`;
  const base = id;
  let counter = 2;
  while (used.has(id)) {
    id = `${base}-${counter}`;
    counter += 1;
  }
  used.add(id);
  return id;
}

function normalizeProfile(profile, index, used) {
  const source = profile || {};
  const normalized = makeDefaultProfile(source);
  normalized.id = makeProfileId(source.id || normalized.id, index, used);
  normalized.name = String(normalized.name || `配置 ${index + 1}`).trim() || `配置 ${index + 1}`;
  normalized.baseUrl = normalizeModelBaseUrlForRequest(normalized.baseUrl);
  normalized.proxyMode = normalizeProxyMode(normalized.proxyMode);
  normalized.proxyGatewayUrl = String(normalized.proxyGatewayUrl || "").trim().replace(/\/+$/, "");
  normalized.proxyFallback = normalized.proxyFallback !== false;
  normalized.chatModel = String(normalized.chatModel || DEFAULT_CONFIG.chatModel).trim();
  normalized.embeddingModel = String(normalized.embeddingModel || DEFAULT_CONFIG.embeddingModel).trim();
  if (detectProvider(normalized.baseUrl) === "gemini" && (normalized.embeddingModel === "gemini-embedding-001" || normalized.embeddingModel === "gemini-embedding-2")) {
    normalized.embeddingModel = GEMINI_OPENAI_EMBEDDING_MODEL;
  }
  normalized.temperature = clampNumber(normalized.temperature, 0, 2, DEFAULT_CONFIG.temperature);
  normalized.modelTimeoutMs = clampNumber(normalized.modelTimeoutMs, 1000, 10 * 60 * 1000, DEFAULT_CONFIG.modelTimeoutMs);
  return normalized;
}

// 规范化 profiles：
// - profiles 为空且 config 顶层仍是旧单 provider 配置时，迁移成 1 个默认 profile；
// - 补全每个 profile 缺失的字段，并保证 indexingProfileId/chatProfileId 指向有效 profile。
// 这保证旧用户升级后"0 配置"可用，且现有索引无需重建（embeddingModel 值不变）。
function normalizeProfiles(config) {
  const next = Object.assign({}, config || {});
  if (!Array.isArray(next.profiles)) next.profiles = [];

  // 旧版单 provider → 迁移成默认 profile（profiles 为空且存在旧顶层 baseUrl 时触发）
  if (!next.profiles.length) {
    next.profiles = [
      makeDefaultProfile({
        id: "default",
        name: detectProvider(next.baseUrl) === "ollama" ? "本地模型" : "默认",
        baseUrl: next.baseUrl || DEFAULT_CONFIG.baseUrl,
        proxyMode: normalizeProxyMode(next.proxyMode),
        proxyGatewayUrl: next.proxyGatewayUrl || "",
        proxyFallback: next.proxyFallback !== false,
        chatModel: next.chatModel || DEFAULT_CONFIG.chatModel,
        embeddingModel: next.embeddingModel || DEFAULT_CONFIG.embeddingModel,
        temperature: clampNumber(next.temperature, 0, 2, DEFAULT_CONFIG.temperature),
        modelTimeoutMs: clampNumber(next.modelTimeoutMs, 1000, 10 * 60 * 1000, DEFAULT_CONFIG.modelTimeoutMs),
      }),
    ];
  }

  // 补全每个 profile 缺失字段，并去重 id
  const used = new Set();
  next.profiles = next.profiles.map((profile, index) => normalizeProfile(profile, index, used));

  // 角色 id 落到有效 profile 上
  const hasProfile = (id) => next.profiles.some((profile) => profile.id === id);
  const firstId = next.profiles[0] ? next.profiles[0].id : "";
  if (!hasProfile(next.indexingProfileId)) next.indexingProfileId = firstId;
  if (!hasProfile(next.chatProfileId)) next.chatProfileId = firstId;
  return next;
}

function normalizeApiKeys(values) {
  const keys = {};
  for (const [id, value] of Object.entries(values || {})) {
    const profileId = String(id || "").trim();
    const key = String(value || "").trim();
    if (profileId && key) keys[profileId] = key;
  }
  return keys;
}

function mergeLegacyApiKey(values, legacyKey, defaultProfileId) {
  const keys = normalizeApiKeys(values);
  if (Object.keys(keys).length) return keys;
  const legacy = String(legacyKey || "").trim();
  const id = String(defaultProfileId || "default").trim() || "default";
  return legacy ? { [id]: legacy } : {};
}

function mergeConfig(saved) {
  return normalizeProfiles(Object.assign({}, DEFAULT_CONFIG, saved || {}));
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
    embeddingModel: GEMINI_OPENAI_EMBEDDING_MODEL,
  },
  {
    id: "ollama",
    label: "Ollama (本地)",
    baseUrl: "http://127.0.0.1:11434/v1",
    chatModel: "qwen3:14b",
    embeddingModel: "qwen3-embedding:4b",
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

function normalizeDailyNotePath(value) {
  const raw = String(value || DEFAULT_CONFIG.dailyNotePath).trim().replace(/\/+$/, "");
  if (!raw) return DEFAULT_CONFIG.dailyNotePath;
  return raw.startsWith("/") ? raw : `/${raw}`;
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

function isSafeMarkdownHref(value) {
  const href = String(value || "").trim();
  return /^(https?:|mailto:|siyuan:)/i.test(href);
}

function renderInlineMarkdown(text) {
  const codeSpans = [];
  const htmlSpans = [];
  let value = String(text == null ? "" : text).replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `\u0000CODE${codeSpans.length}\u0000`;
    const escapedCode = escapeHtml(code);
    codeSpans.push({ html: `<code>${escapedCode}</code>`, text: escapedCode });
    return token;
  });
  const restoreCodeSpans = (source, mode) => {
    let restored = source;
    for (const [index, span] of codeSpans.entries()) {
      restored = restored.replace(new RegExp(`\\u0000CODE${index}\\u0000`, "g"), span[mode]);
    }
    return restored;
  };
  const takeHtmlSpan = (html) => {
    const token = `\u0000HTML${htmlSpans.length}\u0000`;
    htmlSpans.push(html);
    return token;
  };
  value = escapeHtml(value);
  value = value.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, href) => {
    const normalizedHref = String(href || "").replace(/&amp;/g, "&");
    const safeAlt = restoreCodeSpans(alt || "", "text");
    if (!isSafeMarkdownHref(normalizedHref)) return safeAlt;
    return takeHtmlSpan(`<img src="${escapeHtml(normalizedHref)}" alt="${safeAlt}">`);
  });
  value = value.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const normalizedHref = String(href || "").replace(/&amp;/g, "&");
    if (!isSafeMarkdownHref(normalizedHref)) return label;
    return takeHtmlSpan(`<a href="${escapeHtml(normalizedHref)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  });
  value = value
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^\*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  for (const [index, html] of htmlSpans.entries()) {
    value = value.replace(new RegExp(`\\u0000HTML${index}\\u0000`, "g"), html);
  }
  return restoreCodeSpans(value, "html");
}

function parseMarkdownTable(lines, start) {
  const header = lines[start];
  const divider = lines[start + 1];
  if (!header || !divider || !header.includes("|") || !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(divider)) {
    return null;
  }
  const split = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  const headers = split(header);
  const rows = [];
  let index = start + 2;
  while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
    rows.push(split(lines[index]));
    index += 1;
  }
  const html = [
    "<table>",
    `<thead><tr>${headers.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead>`,
    rows.length
      ? `<tbody>${rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td>${renderInlineMarkdown(row[cellIndex] || "")}</td>`).join("")}</tr>`).join("")}</tbody>`
      : "",
    "</table>",
  ].join("");
  return { html, next: index };
}

function renderList(lines, start) {
  const ordered = /^\s*\d+[.)]\s+/.test(lines[start] || "");
  const tag = ordered ? "ol" : "ul";
  const items = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    const match = ordered ? line.match(/^\s*\d+[.)]\s+(.+)$/) : line.match(/^\s*[-*+]\s+(.+)$/);
    if (!match) break;
    const item = match[1].replace(/^\[([ xX])\]\s+/, (_, checked) => {
      const isChecked = checked.toLowerCase() === "x" ? " checked" : "";
      return `<input type="checkbox" disabled${isChecked}> `;
    });
    items.push(`<li>${renderInlineMarkdown(item)}</li>`);
    index += 1;
  }
  return { html: `<${tag}>${items.join("")}</${tag}>`, next: index };
}

function renderBasicMarkdownHtml(markdown) {
  const lines = String(markdown == null ? "" : markdown).replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([a-zA-Z0-9_-]*)\s*$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const lang = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : "";
      blocks.push(`<pre><code${lang}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const table = parseMarkdownTable(lines, index);
    if (table) {
      blocks.push(table.html);
      index = table.next;
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${renderBasicMarkdownHtml(quote.join("\n"))}</blockquote>`);
      continue;
    }

    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      const list = renderList(lines, index);
      blocks.push(list.html);
      index = list.next;
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (
      index < lines.length
      && lines[index].trim()
      && !/^\s*```/.test(lines[index])
      && !/^\s{0,3}#{1,6}\s+/.test(lines[index])
      && !/^\s*>/.test(lines[index])
      && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[index])
      && !parseMarkdownTable(lines, index)
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(`<p>${paragraph.map(renderInlineMarkdown).join("<br>")}</p>`);
  }
  return blocks.length ? blocks.join("\n") : "<p></p>";
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

// 按笔记本配额采样：当全库块数超过上限时，保证每个笔记本都有代表性内容进入索引，
// 避免全局 ORDER BY updated DESC LIMIT N 截断导致部分笔记本整体消失。
// 策略：先给每个笔记本分配保底配额（总配额的 BASELINE_FRACTION，至少 1），
// 剩余额度按各笔记本块数比例加权分配。总量未超上限时各笔记本返回各自真实块数。
// counts: { [box]: number }；返回 { [box]: number }（每个笔记本应取的块数）。
function computeNotebookQuotas(counts, limit) {
  const total = clampNumber(limit, 1, 1000000, DEFAULT_CONFIG.maxIndexedBlocks);
  const boxes = Object.keys(counts || {});
  const sizes = {};
  let grandTotal = 0;
  for (const box of boxes) {
    const size = clampNumber(counts[box], 0, 1000000, 0);
    sizes[box] = size;
    grandTotal += size;
  }
  if (!boxes.length || grandTotal <= 0) return {};
  // 总量未超上限：各笔记本取全量，无需配额
  if (grandTotal <= total) {
    const full = {};
    for (const box of boxes) full[box] = sizes[box];
    return full;
  }
  const BASELINE_FRACTION = 0.12; // 每个笔记本至少保留 12% 的总配额，保证覆盖
  const baseline = Math.max(1, Math.floor(total * BASELINE_FRACTION));
  // 保底配额总和不超过 total（笔记本数过多时均分）
  const baselineTotal = Math.min(total, baseline * boxes.length);
  const perBaseline = Math.floor(baselineTotal / boxes.length);
  const remaining = total - perBaseline * boxes.length;
  // 剩余额度按各笔记本块数加权
  const oversizedTotal = boxes.reduce((sum, box) => sum + sizes[box], 0) || 1;
  const quotas = {};
  let allocated = 0;
  for (const box of boxes) {
    const weighted = Math.floor((sizes[box] / oversizedTotal) * remaining);
    const quota = Math.min(sizes[box], perBaseline + weighted);
    quotas[box] = quota;
    allocated += quota;
  }
  // 把因 min(sizes) 截断或取整产生的剩余额度，补给块数最多的笔记本
  let leftover = total - allocated;
  if (leftover > 0) {
    const sorted = boxes.slice().sort((a, b) => sizes[b] - sizes[a]);
    for (let i = 0; leftover > 0 && i < sorted.length; i = (i + 1) % sorted.length) {
      const box = sorted[i];
      if (sizes[box] > quotas[box]) {
        quotas[box] += 1;
        leftover -= 1;
      } else if (i === sorted.length - 1 && sizes[sorted[0]] <= quotas[sorted[0]]) {
        break; // 所有笔记本都已被取满，无法再分配
      }
    }
  }
  return quotas;
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

function regexEscape(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractDateFromPath(value) {
  const text = String(value || "");
  const dashed = Array.from(text.matchAll(/(?:^|[^\d])(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?!\d)/g));
  const dashedMatch = dashed[dashed.length - 1];
  if (dashedMatch) return `${dashedMatch[1]}-${pad2(Number(dashedMatch[2]))}-${pad2(Number(dashedMatch[3]))}`;
  const compact = Array.from(text.matchAll(/(?:^|[^\d])(\d{4})(\d{2})(\d{2})(?!\d)/g));
  const compactMatch = compact[compact.length - 1];
  if (compactMatch) return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
  return "";
}

function isDailyNotePath(value, dailyNotePath) {
  const root = normalizeDailyNotePath(dailyNotePath);
  const pattern = new RegExp(`^${regexEscape(root)}(?:/|$)`, "i");
  return pattern.test(String(value || "")) && Boolean(extractDateFromPath(value));
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

function metricLevelLabel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  if (number >= 4) return "高";
  if (number <= 2) return "低";
  return "中";
}

// 将 custom-metric-* / custom-task-projectid 等结构化属性转成可检索的标签信号。
// 例如 custom-metric-importance=5 → "重要:高"；custom-task-projectid=xxx → "项目:xxx"。
// 这样问"重要的事""某个项目"时能通过标签命中加权（exactMatchScore 对 tags 加权）。
function extractMetricTags(attrs) {
  const tags = [];
  const metricLabels = {
    importance: "重要",
    urgency: "紧急",
    difficulty: "困难",
  };
  for (const [key, rawValue] of Object.entries(attrs || {})) {
    const normalizedKey = String(key || "").toLowerCase();
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      const text = String(value == null ? "" : value).trim();
      if (!text) continue;
      // 重要度/紧急度/难度：保留数值，便于按档位检索（如"重要的"可匹配 4/5 档）
      const metricMatch = normalizedKey.match(/^custom-metric-(importance|urgency|difficulty)$/);
      if (metricMatch) {
        const number = Number(text);
        if (Number.isFinite(number)) {
          const label = metricLabels[metricMatch[1]];
          const level = metricLevelLabel(number);
          tags.push(`${metricMatch[1]}:${number}`, `${label}:${number}`);
          if (level) tags.push(`${metricMatch[1]}:${level}`, `${label}:${level}`, label);
        }
        continue;
      }
      // 任务项目 id：原始值是 quick_xxx 这类无意义串，但仍生成标签以便聚合（高频同值可形成主题）
      if (normalizedKey === "custom-task-projectid") {
        tags.push(`项目:${text}`);
        continue;
      }
    }
  }
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
  const metricTags = extractMetricTags(attrs);
  return unique([...attrTags, ...metricTags, ...extractTextTags(rowText(row))]);
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
    daily_event: "日记事件",
    daily_item: "日记事项",
    daily_detail: "日记明细",
    daily_topic: "日记主题",
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
  const sourceHash = stableHash(
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
  unit.sourceHash = sourceHash;
  unit.hash = sourceHash;
  return unit;
}

function applyUnitSummary(unit, summary) {
  if (!unit) return false;
  const text = String(summary || "").trim();
  const sourceHash = unit.sourceHash || unit.hash || "";
  if (!text || !sourceHash) return false;
  unit.sourceHash = sourceHash;
  unit.summary = text;
  unit.contextText = [`AI 摘要: ${text}`, "", unit.contextText || unit.text].join("\n");
  unit.hash = stableHash(`${sourceHash}\n${text}`);
  return true;
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
  return parts.map((part, index) => {
    const sourceHash = stableHash(`${id}\n${normalized.updated}\n${part}\n${metadata.tags.join(",")}`);
    return {
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
      sourceHash,
      hash: sourceHash,
    };
  });
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

function buildChildMap(rows) {
  const childMap = new Map();
  for (const row of (rows || []).map(normalizeRow)) {
    if (!row.parentId) continue;
    if (!childMap.has(row.parentId)) childMap.set(row.parentId, []);
    childMap.get(row.parentId).push(row);
  }
  for (const children of childMap.values()) children.sort(compareRows);
  return childMap;
}

function descendantRows(rowId, childMap) {
  const result = [];
  const walk = (id) => {
    for (const child of childMap.get(id) || []) {
      result.push(child);
      walk(child.id);
    }
  };
  walk(rowId);
  return result;
}

function descendantRowsExcept(rowId, childMap, skipIds) {
  const result = [];
  const skip = skipIds || new Set();
  const walk = (id) => {
    for (const child of childMap.get(id) || []) {
      if (skip.has(child.id)) continue;
      result.push(child);
      walk(child.id);
    }
  };
  walk(rowId);
  return result;
}

function stripListMarker(value) {
  return stripMarkdown(value)
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)、]\s*/, "")
    .trim();
}

function directLabelRowId(row, childMap) {
  const normalized = normalizeRow(row);
  if (normalized.type !== "i") return "";
  const directText = (childMap.get(normalized.id) || []).find((child) => child.type === "p" || child.type === "h");
  return directText ? directText.id : "";
}

function directLabel(row, childMap) {
  const normalized = normalizeRow(row);
  const labelId = directLabelRowId(normalized, childMap);
  if (labelId) return stripListMarker(rowText((childMap.get(normalized.id) || []).find((child) => child.id === labelId)));
  return stripListMarker(rowText(normalized));
}

function looksLikeTimestamp(value) {
  return Boolean(extractTimestamp(value));
}

function extractTimestamp(value) {
  const match = String(value || "").match(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/);
  return match ? match[0] : "";
}

function removeTimestamp(value) {
  return String(value || "").replace(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/, "").trim();
}

function rowsToMarkdown(rows) {
  return (rows || [])
    .filter((row) => row && row.type !== "l")
    .map((row) => rowText(row))
    .filter(Boolean)
    .join("\n\n");
}

function dailyDetailRows(rows, childMap) {
  const candidates = (rows || []).map(normalizeRow);
  const labelRowIds = new Set();
  for (const row of candidates) {
    const labelId = directLabelRowId(row, childMap);
    if (labelId) labelRowIds.add(labelId);
  }
  return candidates.filter((row) => {
    if (!row.id || !rowText(row) || labelRowIds.has(row.id)) return false;
    if (row.type === "d" || row.type === "l" || row.type === "i" || row.type === "s") return false;
    return true;
  });
}

function pushDailyDetailUnits(units, input, attrsMap, refMaps, options) {
  const labelText = stripMarkdown(input.title || "");
  const detailRows = dailyDetailRows(input.detailRows || [], input.childMap).filter((row) => {
    const text = stripMarkdown(rowText(row));
    if (!text) return false;
    if (labelText && text === labelText && row.type !== "c" && row.type !== "html" && row.type !== "t") return false;
    return true;
  });
  const detailText = rowsToMarkdown(detailRows);
  const parts = chunkText(detailText, options);
  if (!parts.length) return;
  const sourceBlockIds = unique(detailRows.map((row) => row.id).filter(Boolean));
  const metadataRows = detailRows.length ? detailRows : [normalizeRow(input.primary)].filter((row) => row.id);
  const metadata = collectRowMetadata(metadataRows, attrsMap, refMaps);
  for (const [index, part] of parts.entries()) {
    const partTitle = parts.length > 1 ? `${input.title} / 明细 ${index + 1}` : `${input.title} / 明细`;
    units.push(
      makeUnit(
        {
          id: `${input.id}:detail:${index}`,
          type: "daily_detail",
          blockId: input.blockId,
          rootId: input.rootId,
          parentId: input.parentId,
          box: input.box,
          path: input.path,
          hpath: input.hpath,
          title: partTitle,
          rows: metadataRows,
          primary: metadataRows[0] || input.primary,
          metadata,
          sourceBlockIds: sourceBlockIds.length ? sourceBlockIds : [input.blockId].filter(Boolean),
          text: [`日记主题: ${input.topic}`, input.timeLabel ? `时间: ${input.timeLabel}` : "", `明细: ${input.title}`, part].filter(Boolean).join("\n\n"),
          updated: metadataRows.map((row) => row.updated).sort().pop() || input.updated,
        },
        options,
      ),
    );
  }
}

function makeDailyNoteDetailUnit(docRows, attrsMap, refMaps, options) {
  const rows = (docRows || []).map(normalizeRow).filter((row) => row.id && rowText(row));
  if (!rows.length) return null;
  const docRow = normalizeRow(getDocRow(rows, rows[0] && rows[0].rootId));
  const bodyRows = rows.filter((row) => row.id !== docRow.id);
  const detailRows = bodyRows.length ? bodyRows : rows;
  const detailText = rowsToMarkdown(detailRows);
  if (!detailText) return null;
  const date = extractDateFromPath(docRow.hpath) || extractDateFromPath(docRow.content) || blockTitle(docRow);
  const metadata = collectRowMetadata(detailRows, attrsMap, refMaps);
  const unit = makeUnit(
    {
      id: `${docRow.rootId || docRow.id}:daily-detail`,
      type: "daily_detail",
      blockId: docRow.id,
      rootId: docRow.rootId || docRow.id,
      parentId: docRow.parentId,
      box: docRow.box,
      path: docRow.path,
      hpath: docRow.hpath || date,
      title: `${date} 日记明细`,
      rows: detailRows,
      primary: docRow,
      metadata,
      sourceBlockIds: unique(detailRows.map((row) => row.id).filter(Boolean)),
      text: [`日期: ${date}`, "", detailText].filter(Boolean).join("\n"),
      updated: detailRows.map((row) => row.updated).sort().pop() || docRow.updated,
    },
    options,
  );
  unit.dailyScope = "day";
  unit.dailyDate = date;
  unit.dailyNotePath = normalizeDailyNotePath(options && options.dailyNotePath);
  return unit;
}

function dailyTopicFor(row, rowsById, childMap, docRow) {
  let current = normalizeRow(row);
  while (current && current.parentId) {
    const parent = rowsById.get(current.parentId);
    if (!parent) break;
    if (parent.type === "i") {
      const label = directLabel(parent, childMap);
      if (label && !looksLikeTimestamp(label)) return label;
    }
    current = parent;
  }
  return blockTitle(docRow);
}

function eventItemRows(eventRow, childMap) {
  const items = [];
  for (const child of childMap.get(eventRow.id) || []) {
    if (child.type !== "l") continue;
    for (const item of childMap.get(child.id) || []) {
      if (item.type === "i") items.push(item);
    }
  }
  return items;
}

function indexableContentRows(rows) {
  const normalized = (rows || []).map(normalizeRow);
  const childMap = buildChildMap(normalized);
  return normalized.filter((row) => {
    if (!row.id || !rowText(row)) return false;
    if (row.type === "d" || row.type === "l") return false;
    if (row.type === "i" && (childMap.get(row.id) || []).length) return false;
    return true;
  });
}

function buildDailyNoteUnits(docRows, attrsMap, refMaps, options) {
  const rows = (docRows || []).map(normalizeRow).filter((row) => row.id && rowText(row));
  const normalizedAttrs = normalizeAttrsMap(attrsMap);
  const normalizedRefs = normalizeRefs(refMaps);
  const docRow = normalizeRow(getDocRow(rows, rows[0] && rows[0].rootId));
  const childMap = buildChildMap(rows);
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const eventRows = rows.filter((row) => row.type === "i" && looksLikeTimestamp(directLabel(row, childMap)));
  const units = [];
  const usedItemIds = new Set();
  const dayDetail = makeDailyNoteDetailUnit(rows, normalizedAttrs, normalizedRefs, options);
  if (dayDetail) units.push(dayDetail);

  for (const eventRow of eventRows) {
    const rawTimeLabel = directLabel(eventRow, childMap);
    const timeLabel = extractTimestamp(rawTimeLabel) || rawTimeLabel;
    const inlineTopic = removeTimestamp(rawTimeLabel).replace(/[#：:，,。\s-]+$/g, "").trim();
    const topic = inlineTopic || dailyTopicFor(eventRow, rowsById, childMap, docRow);
    const itemRows = eventItemRows(eventRow, childMap);
    const descendants = descendantRows(eventRow.id, childMap);
    const eventDetailRows = descendantRowsExcept(eventRow.id, childMap, new Set(itemRows.map((item) => item.id)));
    const itemLines = itemRows
      .map((item) => directLabel(item, childMap))
      .filter(Boolean)
      .map((item) => `- ${item}`)
      .join("\n");
    const eventRowsForMeta = [eventRow, ...descendants];
    const eventText = [
      `日记主题: ${topic}`,
      `时间: ${timeLabel}`,
      itemLines ? `事项:\n${itemLines}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    units.push(
      makeUnit(
        {
          id: `${eventRow.rootId}:daily-event:${eventRow.id}`,
          type: "daily_event",
          blockId: eventRow.id,
          rootId: eventRow.rootId,
          parentId: eventRow.parentId,
          box: eventRow.box,
          path: eventRow.path,
          hpath: `${docRow.hpath || blockTitle(docRow)} / ${topic} / ${timeLabel}`,
          title: `${topic} / ${timeLabel}`,
          rows: eventRowsForMeta,
          primary: eventRow,
            metadata: collectRowMetadata(eventRowsForMeta, normalizedAttrs, normalizedRefs),
          sourceBlockIds: unique([eventRow.id, ...descendants.map((row) => row.id)]),
          text: eventText,
          updated: eventRowsForMeta.map((row) => row.updated).sort().pop() || eventRow.updated,
        },
        options,
      ),
    );
    pushDailyDetailUnits(
      units,
      {
        id: `${eventRow.rootId}:daily-event:${eventRow.id}`,
        title: `${topic} / ${timeLabel}`,
        blockId: eventRow.id,
        rootId: eventRow.rootId,
        parentId: eventRow.parentId,
        box: eventRow.box,
        path: eventRow.path,
        hpath: `${docRow.hpath || blockTitle(docRow)} / ${topic} / ${timeLabel}`,
        topic,
        timeLabel,
        detailRows: [eventRow, ...eventDetailRows],
        childMap,
        primary: eventRow,
        updated: eventRow.updated,
      },
      normalizedAttrs,
      normalizedRefs,
      options,
    );

    for (const itemRow of itemRows) {
      const itemLabel = directLabel(itemRow, childMap);
      if (!itemLabel || looksLikeTimestamp(itemLabel)) continue;
      usedItemIds.add(itemRow.id);
      const itemDescendants = descendantRows(itemRow.id, childMap);
      const itemRowsForMeta = [itemRow, ...itemDescendants];
      const itemText = [
        `日记主题: ${topic}`,
        `时间: ${timeLabel}`,
        `事项: ${itemLabel}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      units.push(
        makeUnit(
          {
            id: `${itemRow.rootId}:daily-item:${itemRow.id}`,
            type: "daily_item",
            blockId: itemRow.id,
            rootId: itemRow.rootId,
            parentId: itemRow.parentId,
            box: itemRow.box,
            path: itemRow.path,
            hpath: `${docRow.hpath || blockTitle(docRow)} / ${topic} / ${timeLabel}`,
            title: itemLabel,
            rows: itemRowsForMeta,
            primary: itemRow,
            metadata: collectRowMetadata(itemRowsForMeta, normalizedAttrs, normalizedRefs),
            sourceBlockIds: unique([itemRow.id, ...itemDescendants.map((row) => row.id)]),
            text: itemText,
            updated: itemRowsForMeta.map((row) => row.updated).sort().pop() || itemRow.updated,
          },
          options,
        ),
      );
      pushDailyDetailUnits(
        units,
        {
          id: `${itemRow.rootId}:daily-item:${itemRow.id}`,
          title: itemLabel,
          blockId: itemRow.id,
          rootId: itemRow.rootId,
          parentId: itemRow.parentId,
          box: itemRow.box,
          path: itemRow.path,
          hpath: `${docRow.hpath || blockTitle(docRow)} / ${topic} / ${timeLabel}`,
          topic,
          timeLabel,
          detailRows: [itemRow, ...itemDescendants],
          childMap,
          primary: itemRow,
          updated: itemRow.updated,
        },
        normalizedAttrs,
        normalizedRefs,
        options,
      );
    }
  }

  const eventIds = new Set(eventRows.map((row) => row.id));
  const orphanItems = rows.filter((row) => row.type === "i" && !eventIds.has(row.id) && !usedItemIds.has(row.id));
  for (const itemRow of orphanItems) {
    const label = directLabel(itemRow, childMap);
    if (!label || label.length < 4 || looksLikeTimestamp(label)) continue;
    const children = descendantRows(itemRow.id, childMap);
    if (children.some((child) => child.type === "i" && looksLikeTimestamp(directLabel(child, childMap)))) continue;
    const itemRowsForMeta = [itemRow, ...children];
    units.push(
      makeUnit(
        {
          id: `${itemRow.rootId}:daily-item:${itemRow.id}`,
          type: "daily_item",
          blockId: itemRow.id,
          rootId: itemRow.rootId,
          parentId: itemRow.parentId,
          box: itemRow.box,
          path: itemRow.path,
          hpath: docRow.hpath || blockTitle(docRow),
          title: label,
          rows: itemRowsForMeta,
          primary: itemRow,
          metadata: collectRowMetadata(itemRowsForMeta, normalizedAttrs, normalizedRefs),
          sourceBlockIds: unique([itemRow.id, ...children.map((row) => row.id)]),
          text: `日记事项: ${label}`,
          updated: itemRowsForMeta.map((row) => row.updated).sort().pop() || itemRow.updated,
        },
        options,
      ),
    );
    pushDailyDetailUnits(
      units,
      {
        id: `${itemRow.rootId}:daily-item:${itemRow.id}`,
        title: label,
        blockId: itemRow.id,
        rootId: itemRow.rootId,
        parentId: itemRow.parentId,
        box: itemRow.box,
        path: itemRow.path,
        hpath: docRow.hpath || blockTitle(docRow),
        topic: blockTitle(docRow),
        timeLabel: "",
        detailRows: [itemRow, ...children],
        childMap,
        primary: itemRow,
        updated: itemRow.updated,
      },
      normalizedAttrs,
      normalizedRefs,
      options,
    );
  }
  return units;
}

function normalizeDailyTopic(topic) {
  if (!topic) return null;
  const category = String(topic.category || topic.class || topic.type || topic.label || "其他").trim() || "其他";
  const title = String(topic.title || topic.topic || topic.name || topic.summary || "").trim();
  const summary = String(topic.summary || topic.description || topic.detail || "").trim();
  if (!title && !summary) return null;
  return {
    category: category.replace(/^#+|#+$/g, "").slice(0, 24),
    title: (title || summary).replace(/\s+/g, " ").slice(0, 80),
    summary: summary.replace(/\s+/g, " ").slice(0, 240),
  };
}

function parseDailyTopicResponse(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) candidates.unshift(fenced[1].trim());

  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : parsed && (parsed.topics || parsed.items || parsed.results);
      if (Array.isArray(list)) return list.map(normalizeDailyTopic).filter(Boolean).slice(0, 12);
    } catch (error) {
      // 非 JSON 时继续尝试按文本行解析。
    }
  }

  const topics = [];
  for (const line of raw.split(/\n+/)) {
    const text = line.trim().replace(/^[-*]\s*/, "");
    if (!text) continue;
    let match = text.match(/(?:\d{4}-\d{2}-\d{2}\s*\/\s*)?\[([^\]]+)\]\s*(.+)/);
    if (!match) match = text.match(/^([^:：]{1,24})[:：]\s*(.+)$/);
    if (match) topics.push(normalizeDailyTopic({ category: match[1], title: match[2] }));
  }
  return topics.filter(Boolean).slice(0, 12);
}

function buildDailyTopicUnits(detailUnit, topics, options) {
  if (!detailUnit || detailUnit.type !== "daily_detail") return [];
  const sourceHash = detailUnit.sourceHash || detailUnit.hash || "";
  if (!detailUnit.id || !sourceHash) return [];
  const sourceKey = `${detailUnit.id}\n${sourceHash}`;
  const date = detailUnit.dailyDate || extractDateFromPath(detailUnit.hpath) || extractDateFromPath(detailUnit.title) || "";
  const normalizedTopics = (topics || []).map(normalizeDailyTopic).filter(Boolean);
  const units = [];
  const usedIds = new Set();
  for (const topic of normalizedTopics) {
    const slug = stableHash(`${sourceKey}\n${topic.category}\n${topic.title}`).slice(0, 10);
    let id = `${detailUnit.id}:topic:${slug}`;
    let counter = 2;
    while (usedIds.has(id)) {
      id = `${detailUnit.id}:topic:${slug}-${counter}`;
      counter += 1;
    }
    usedIds.add(id);
    const title = [date, `[${topic.category}] ${topic.title}`].filter(Boolean).join(" / ");
    const text = [
      date ? `日期: ${date}` : "",
      `分类: ${topic.category}`,
      `主题: ${topic.title}`,
      topic.summary ? `摘要: ${topic.summary}` : "",
      "",
      "相关日记明细:",
      limitText(detailUnit.text || detailUnit.contextText || "", 1600),
    ]
      .filter(Boolean)
      .join("\n");
    const metadata = {
      tags: unique([...(detailUnit.tags || []), topic.category, topic.title]),
      attrs: detailUnit.attrs || {},
      refs: detailUnit.refs || [],
      backlinks: detailUnit.backlinks || [],
    };
    const unit = makeUnit(
      {
        id,
        type: "daily_topic",
        blockId: detailUnit.blockId,
        rootId: detailUnit.rootId,
        parentId: detailUnit.parentId,
        box: detailUnit.box,
        path: detailUnit.path,
        hpath: [detailUnit.hpath || date, `[${topic.category}] ${topic.title}`].filter(Boolean).join(" / "),
        title,
        metadata,
        sourceBlockIds: detailUnit.sourceBlockIds || [],
        text,
        updated: detailUnit.updated,
      },
      options || {},
    );
    unit.dailySourceKey = sourceKey;
    unit.dailyDate = date;
    unit.dailyCategory = topic.category;
    unit.dailyTopic = topic.title;
    if (topic.summary) unit.summary = topic.summary;
    units.push(unit);
  }
  return units;
}

function buildBlockUnits(rows, attrs, refs, options) {
  const config = options || {};
  const attrsMap = normalizeAttrsMap(attrs);
  const refMaps = normalizeRefs(refs);
  const units = [];
  for (const row of indexableContentRows(rows)) {
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
  const attrsMap = normalizeAttrsMap(attrs);
  const refMaps = normalizeRefs(refs);
  const groups = groupRowsByRoot(normalizedRows);
  const regularRows = [];
  const dailyUnits = [];

  for (const docRows of groups.values()) {
    const docRow = getDocRow(docRows, docRows[0] && docRows[0].rootId);
    if (isDailyNotePath(docRow.hpath, options && options.dailyNotePath)) {
      dailyUnits.push(...buildDailyNoteUnits(docRows, attrsMap, refMaps, options));
    } else {
      regularRows.push(...docRows);
    }
  }

  const regularContentRows = indexableContentRows(regularRows);
  const blockUnits = buildBlockUnits(regularContentRows, attrsMap, refMaps, options);
  const sectionUnits = buildSectionUnits(regularContentRows, attrsMap, refMaps, options);
  const documentUnits = buildDocumentUnits(regularContentRows, sectionUnits, attrsMap, refMaps, options);
  const topicUnits = buildNotebookAndVaultUnits([...documentUnits, ...dailyUnits.filter((unit) => unit.type === "daily_event" || unit.type === "daily_topic")], options);
  return [...blockUnits, ...sectionUnits, ...documentUnits, ...dailyUnits, ...topicUnits];
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

// ===== 时间轴：解析中文时间词 → 日期范围 =====
// 用于"最近一周工作""上周三干了啥""6月做了什么"这类时间线问题。
// 返回 { start:'YYYY-MM-DD', end:'YYYY-MM-DD', label:'...' } 或 null（无时间词）。
// today 注入当前日期，保证纯函数可测。范围是闭区间 [start, end]。
function pad2(value) {
  return String(value).padStart(2, "0");
}

function toDateNumber(date) {
  return Number(`${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`);
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function addDays(date, delta) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + delta);
  return next;
}

const WEEKDAY_LABELS = { 0: "日", 1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六" };

function parseTimeRange(question, today) {
  const text = String(question || "").trim();
  if (!text) return null;
  const now = today instanceof Date ? today : new Date();

  // 中文数字转阿拉伯
  const cnNum = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const readNumber = (word) => (cnNum[word] != null ? cnNum[word] : Number(word));

  // 今天 / 今日 / 今儿
  if (/(今天|今日|今日里|今天的)/.test(text)) {
    return { start: formatDate(now), end: formatDate(now), label: "今天" };
  }
  // 昨天 / 昨日
  if (/(昨天|昨日)/.test(text)) {
    const day = addDays(now, -1);
    return { start: formatDate(day), end: formatDate(day), label: "昨天" };
  }
  // 前天 / 大前天
  if (/大前天/.test(text)) {
    const day = addDays(now, -3);
    return { start: formatDate(day), end: formatDate(day), label: "大前天" };
  }
  if (/前天/.test(text)) {
    const day = addDays(now, -2);
    return { start: formatDate(day), end: formatDate(day), label: "前天" };
  }

  // 最近N天 / 近N天 / 这N天 / 过去N天（"最近一周"→7天）
  let match = text.match(/(?:最近|近|过去|这)\s*([一二两三四五六七八九十\d]+)\s*(天|日)/);
  if (match) {
    const days = readNumber(match[1]);
    if (days > 0 && days < 400) {
      const start = addDays(now, -(days - 1));
      return { start: formatDate(start), end: formatDate(now), label: `最近${days}天` };
    }
  }

  // 最近一周 / 近一周（"一周"=7天 的常用说法）
  match = text.match(/(?:最近|近|过去)\s*([一二三四五六七八九十\d]+)?\s*周/);
  if (match) {
    const weeks = match[1] ? readNumber(match[1]) : 1;
    if (weeks > 0 && weeks < 60) {
      const days = weeks * 7;
      const start = addDays(now, -(days - 1));
      return { start: formatDate(start), end: formatDate(now), label: `最近${weeks}周` };
    }
  }

  // 本周 / 这周（周一到今天）
  if (/(本周|这周|这一个周)/.test(text)) {
    const weekday = now.getDay() || 7; // 周日记为7
    const monday = addDays(now, -(weekday - 1));
    return { start: formatDate(monday), end: formatDate(now), label: "本周" };
  }

  // 上周 / 上个周（上周一到上周日）
  if (/(上个?周|上周)/.test(text)) {
    // 上周X：上周三 → 上周指定日
    const wdMatch = text.match(/上个?周\s*([一二三四五六七八天日])/);
    if (wdMatch) {
      const dayLabel = wdMatch[1];
      const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
      const targetWd = map[dayLabel];
      if (targetWd) {
        const thisWd = now.getDay() || 7;
        const delta = -(thisWd + (7 - targetWd));
        const day = addDays(now, delta);
        return { start: formatDate(day), end: formatDate(day), label: `上周${WEEKDAY_LABELS[targetWd]}` };
      }
    }
    const thisWd = now.getDay() || 7;
    const lastMonday = addDays(now, -(thisWd + 6));
    const lastSunday = addDays(now, -thisWd);
    return { start: formatDate(lastMonday), end: formatDate(lastSunday), label: "上周" };
  }

  // 本月 / 这个月 / X月 / X月份（支持"6月""上月""上个月"）
  match = text.match(/上个?月/);
  if (match) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return { start: formatDate(start), end: formatDate(end), label: "上个月" };
  }
  if (/(本月|这个月|当月)/.test(text)) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { start: formatDate(start), end: formatDate(end), label: "本月" };
  }
  match = text.match(/(\d{1,2})\s*月份?(?!\s*\d)/);
  if (match) {
    const month = Number(match[1]);
    if (month >= 1 && month <= 12) {
      const year = now.getFullYear();
      const start = new Date(year, month - 1, 1);
      const end = new Date(year, month, 0);
      // 不含"去年"且月份在当前月份之后，则认为是去年的
      if (!/去年/.test(text) && start > now && month > now.getMonth() + 1) {
        return { start: formatDate(new Date(year - 1, month - 1, 1)), end: formatDate(new Date(year - 1, month, 0)), label: `去年${month}月` };
      }
      return { start: formatDate(start), end: formatDate(end), label: `${month}月` };
    }
  }

  // 精确日期：2026-06-18 / 20260618 / 6月18号
  match = text.match(/(\d{4})[-年](\d{1,2})[-月](\d{1,2})/);
  if (match) {
    const day = `${match[1]}-${pad2(Number(match[2]))}-${pad2(Number(match[3]))}`;
    return { start: day, end: day, label: day };
  }
  match = text.match(/(\d{4})(\d{2})(\d{2})/);
  if (match) {
    const day = `${match[1]}-${match[2]}-${match[3]}`;
    return { start: day, end: day, label: day };
  }
  match = text.match(/(\d{1,2})\s*(?:\/|月)\s*(\d{1,2})(?:日|号)?/);
  if (match) {
    const month = Number(match[1]);
    const dayNumber = Number(match[2]);
    if (month >= 1 && month <= 12 && dayNumber >= 1 && dayNumber <= 31) {
      let year = now.getFullYear();
      const day = new Date(year, month - 1, dayNumber);
      if (!/明年/.test(text) && day > now) year -= 1;
      const formatted = `${year}-${pad2(month)}-${pad2(dayNumber)}`;
      return { start: formatted, end: formatted, label: formatted };
    }
  }

  return null;
}

// 把日期范围应用到 daily note 块上：按 hpath 末尾日期过滤，并按日期分组。
// rows: 思源 blocks 行；pathPrefix: daily note 路径前缀（如 "/daily note"）。
// 返回 [{ date, blocks: [...] }]，仅含落在 [start,end] 区间的天。
function groupDailyRowsByDate(rows, timeRange, pathPrefix) {
  if (!timeRange) return [];
  const prefix = normalizeDailyNotePath(pathPrefix).toLowerCase();
  const startNum = Number(timeRange.start.replace(/-/g, ""));
  const endNum = Number(timeRange.end.replace(/-/g, ""));
  const byDate = {};
  for (const row of rows || []) {
    const normalized = normalizeRow(row);
    const hpath = String(normalized.hpath || "").toLowerCase();
    if (!hpath.startsWith(prefix)) continue;
    const date = extractDateFromPath(hpath);
    const dateStr = date.replace(/-/g, "");
    if (!dateStr) continue;
    const num = Number(dateStr);
    if (num < startNum || num > endNum) continue;
    if (!byDate[dateStr]) byDate[dateStr] = [];
    byDate[dateStr].push(normalized);
  }
  return Object.keys(byDate)
    .sort()
    .map((dateStr) => ({
      date: `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`,
      blocks: byDate[dateStr],
    }));
}

// 把按日期分组的 daily note 聚合成给 AI 的时间段上下文文本。
function buildTimelineContext(groups, options) {
  const perDayLimit = clampNumber(options && options.perDayBlockLimit, 1, 200, 80);
  const maxChars = clampNumber(options && options.maxChars, 1000, 40000, 12000);
  const parts = [];
  let length = 0;
  let truncated = false;
  for (const group of groups || []) {
    const lines = [`【${group.date}】`];
    let count = 0;
    for (const block of group.blocks || []) {
      if (count >= perDayLimit) {
        lines.push(`- ...（当天还有 ${(group.blocks || []).length - count} 条记录未展开）`);
        break;
      }
      const content = String(block.content || block.markdown || "").trim();
      if (content) {
        lines.push(`- ${content.replace(/\s+/g, " ").slice(0, 200)}`);
        count += 1;
      }
    }
    const part = lines.join("\n");
    if (length + part.length + 2 > maxChars) {
      truncated = true;
      break;
    }
    parts.push(part);
    length += part.length + 2;
  }
  if (truncated) parts.push("...（时间段记录已达到上下文上限，后续日期未展开）");
  return parts.join("\n\n");
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
  if (type === "daily_event") return macro ? 0.09 : 0.04;
  if (type === "daily_topic") return macro ? 0.1 : 0.075;
  if (type === "daily_item") return 0.06;
  if (type === "daily_detail") return macro ? 0.03 : 0.055;
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
  const limit = clampNumber(topK, 1, 120, DEFAULT_CONFIG.topK);
  const scored = (chunks || [])
    .filter((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length)
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding) + exactMatchScore(chunk, question) + typeBoost(chunk, question) + Number(chunk.rankBoost || 0),
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
      daily_event: "日记事件",
      daily_item: "日记事项",
      daily_detail: "日记明细",
      daily_topic: "日记主题",
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

function buildMessages(config, question, ranked, history, options) {
  const context = buildContext(ranked);
  const timeline = options && options.timeline ? options.timeline : null;
  const timelineContext = timeline && timeline.context ? String(timeline.context).trim() : "";
  const timelineLabel = timeline && timeline.range
    ? `${timeline.range.label || "时间段"}（${timeline.range.start} 至 ${timeline.range.end}）`
    : "时间段";
  const messages = [
    {
      role: "system",
      content: [
        config.systemPrompt || DEFAULT_CONFIG.systemPrompt,
        "当同时提供时间段记录和知识单元时：进度、最近做了什么、当天发生了什么优先依据时间段记录；技术概念、方案细节、长期知识优先依据知识单元；笔记分类、主题归纳和关键事项要结合两者。证据不足时明确说明。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "请基于下面的思源笔记知识单元回答问题。",
        "要求：",
        "1. 优先使用知识单元中的事实；章节/文档/笔记本/全库单元用于理解主题，具体结论要尽量落到块级证据。",
        "2. 如果提供了时间段记录，回答时间线/进度类问题时优先使用这些记录，并写出日期。",
        "3. 每个关键结论后标注引用编号，例如 [1]；仅来自时间段记录的结论标注日期即可。",
        "4. 如果证据不足以回答，明确说明缺口。",
        "",
        timelineContext ? `时间段记录：${timelineLabel}` : "",
        timelineContext,
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
    const providerMessage = extractModelErrorMessage(body);
    const detail = formatModelErrorDetail(label, status, providerMessage || body);
    const retryDelayMs = extractRetryDelayMs(body);
    const hint = formatModelErrorHint(label, status, retryDelayMs);
    const error = new Error(`${label} API ${status || "请求失败"}: ${detail || response.url || "无响应内容"}${hint}`);
    error.status = status || 0;
    error.retryDelayMs = retryDelayMs;
    error.providerMessage = providerMessage;
    error.rawBody = body;
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

function extractModelErrorMessage(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const data = JSON.parse(text);
    if (data && data.error && typeof data.error.message === "string") return data.error.message.trim();
    if (data && typeof data.message === "string") return data.message.trim();
    if (typeof data.error === "string") return data.error.trim();
  } catch (error) {
    // 非 JSON 响应按普通文本处理。
  }
  return text;
}

function formatModelErrorDetail(label, status, detail) {
  if (status === 401) return "未提供 API Key，或当前模型配置的 API Key 为空/没有随请求发送";
  if (status === 403) return "API Key 无权访问该模型，或当前账号/项目权限不足";
  if (status === 404) return label === "Embedding" ? "Embedding 模型或接口不存在" : "聊天模型或接口不存在";
  if (status === 429) return "服务商配额或限流已触发";
  const text = String(detail || "");
  return text.length > 600 ? `${text.slice(0, 600)}...` : text;
}

function formatModelErrorHint(label, status, retryDelayMs) {
  if (status === 401) {
    const role = label === "Embedding" ? "索引配置" : "问答配置";
    return `。请在模型页给正在使用的${role}填写 API Key；API Key 按模型配置单独保存在本机。Ollama 本地模型可留空，但 Base URL 应为 http://127.0.0.1:11434/v1`;
  }
  if (status === 403) return "。请检查 API Key、账号额度、项目权限，以及该 key 是否允许访问当前模型";
  if (label === "Embedding" && status === 404) {
    return "。通常是 Embedding 模型名和当前 Base URL 不匹配；Gemini OpenAI-compatible 建议使用 gemini-embedding-2-preview";
  }
  if (status === 404) return "。请检查模型名、Base URL 和接口兼容协议是否匹配";
  if (label === "Embedding" && status === 429) {
    return `。插件会尽量等待后重试；如果仍失败，建议换用 OpenAI text-embedding-3-small 或 Ollama qwen3-embedding:4b${retryDelayMs ? `，也可以等待 ${Math.ceil(retryDelayMs / 1000)} 秒后继续` : ""}`;
  }
  if (status === 429) {
    return `。已触发服务商配额或限流${retryDelayMs ? `，建议等待 ${Math.ceil(retryDelayMs / 1000)} 秒后继续` : ""}`;
  }
  return "";
}

function extractRetryDelayMs(value) {
  const text = String(value || "");
  const retryMatch = text.match(/retry\s+in\s+([0-9.]+)\s*s/i);
  if (retryMatch) return Math.ceil(Number(retryMatch[1]) * 1000);
  const retryDelayMatch = text.match(/"retryDelay"\s*:\s*"([0-9.]+)s"/i);
  if (retryDelayMatch) return Math.ceil(Number(retryDelayMatch[1]) * 1000);
  return 0;
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

// embeddingModel: 当前索引角色 profile 的 embedding 模型名（由调用方从 profile 解析后传入）。
// 这样检查只关心"当前要用的 embedding 模型"是否与索引一致，不再依赖顶层 config 结构。
function getIndexManifestError(manifest, embeddingModel, currentVersion) {
  if (!manifest || !Array.isArray(manifest.shards) || !manifest.shards.length) {
    return "索引不存在，请先在设置中更新索引并等待思源同步";
  }
  const expected = currentVersion || INDEX_SCHEMA_VERSION;
  const version = Number(manifest.schemaVersion || manifest.version || 0);
  if (version !== expected) return "索引版本不兼容，请重新更新索引";
  const expectedModel = embeddingModel;
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
  applyUnitSummary,
  blockToChunks,
  buildBlockUnits,
  buildContext,
  buildDailyNoteUnits,
  buildDailyTopicUnits,
  buildDocumentUnits,
  buildGatewayProxyPayload,
  buildKnowledgeUnits,
  buildMessages,
  buildModelProxyPayload,
  buildModelRequestHeaders,
  buildNotebookAndVaultUnits,
  buildSectionUnits,
  buildTimelineContext,
  chunkText,
  clampNumber,
  computeNotebookQuotas,
  cosineSimilarity,
  detectProvider,
  escapeHtml,
  escapeSql,
  extractChatContent,
  extractDateFromPath,
  extractEmbeddings,
  extractMetricTags,
  extractRetryDelayMs,
  extractQueryTerms,
  getIndexManifestError,
  getModelRequestRoutes,
  countEmbeddedUnits,
  isFallbackAllowed,
  isLocalModelBaseUrl,
  makeDefaultProfile,
  makeManifestPath,
  makeShardPath,
  mergeConfig,
  mergeLegacyApiKey,
  markModelRouteError,
  modelRouteLabel,
  normalizeApiKeys,
  normalizeAttrsMap,
  normalizeBaseUrl,
  normalizeDailyNotePath,
  normalizeProfiles,
  normalizeModelBaseUrlForRequest,
  normalizeProxyMode,
  normalizeRefs,
  nowIso,
  groupDailyRowsByDate,
  parseDailyTopicResponse,
  parseModelProxyJson,
  parseTimeRange,
  rankChunks,
  renderBasicMarkdownHtml,
  stableHash,
  unitTypeLabel,
};
