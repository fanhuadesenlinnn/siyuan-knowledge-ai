"use strict";

const siyuan = require("siyuan");
const {
  DEFAULT_CONFIG,
  blockToChunks,
  buildMessages,
  clampNumber,
  escapeHtml,
  escapeSql,
  makeManifestPath,
  makeShardPath,
  mergeConfig,
  normalizeBaseUrl,
  nowIso,
  rankChunks,
  stableHash,
} = require("./lib/core");

const { Dialog, Plugin, fetchSyncPost, openTab, showMessage } = siyuan;

const PLUGIN_NAME = "siyuan-knowledge-ai";
const CONFIG_FILE = "config.json";
const API_KEY_STORAGE = `${PLUGIN_NAME}:api-key`;
const CURRENT_INDEX_VERSION = 1;

class SiyuanKnowledgeAI extends Plugin {
  async onload() {
    this.config = await this.loadConfig();
    this.lastAnswer = "";
    this.lastSources = [];
    this.indexTimer = null;

    this.addIcons(`
      <symbol id="iconKnowledgeAI" viewBox="0 0 24 24">
        <path d="M12 2.75a2.75 2.75 0 0 1 2.7 2.25h1.55A3.75 3.75 0 0 1 20 8.75v6.5A3.75 3.75 0 0 1 16.25 19h-.52a3.25 3.25 0 0 1-6.46 0h-.52A3.75 3.75 0 0 1 5 15.25v-6.5A3.75 3.75 0 0 1 8.75 5h1.55A2.75 2.75 0 0 1 12 2.75Zm0 1.5a1.25 1.25 0 0 0-1.25 1.25v.25c0 .41-.34.75-.75.75H8.75A2.25 2.25 0 0 0 6.5 8.75v6.5a2.25 2.25 0 0 0 2.25 2.25H10c.41 0 .75.34.75.75a1.25 1.25 0 0 0 2.5 0c0-.41.34-.75.75-.75h2.25a2.25 2.25 0 0 0 2.25-2.25v-6.5a2.25 2.25 0 0 0-2.25-2.25H14c-.41 0-.75-.34-.75-.75V5.5A1.25 1.25 0 0 0 12 4.25Z"/>
        <path d="M9.25 10.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm5.5 0a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z"/>
      </symbol>
    `);

    this.addTopBar({
      icon: "iconKnowledgeAI",
      title: "Knowledge AI",
      position: "right",
      callback: () => this.openMainDialog(),
    });

    this.addCommand({
      langKey: "openKnowledgeAI",
      hotkey: "",
      callback: () => this.openMainDialog(),
    });

    this.startIndexSchedule();
    if (this.config.autoIndexOnStart) {
      window.setTimeout(() => this.buildIndex(null, { silent: true }), 5000);
    }
  }

  onunload() {
    if (this.indexTimer) window.clearInterval(this.indexTimer);
  }

  async loadConfig() {
    try {
      const saved = await this.loadData(CONFIG_FILE);
      return mergeConfig(saved);
    } catch (error) {
      console.warn("Knowledge AI: failed to load config", error);
      return mergeConfig();
    }
  }

  async saveConfig(nextConfig) {
    const merged = mergeConfig(nextConfig);
    merged.temperature = clampNumber(merged.temperature, 0, 2, DEFAULT_CONFIG.temperature);
    merged.topK = clampNumber(merged.topK, 1, 30, DEFAULT_CONFIG.topK);
    merged.maxIndexedBlocks = clampNumber(
      merged.maxIndexedBlocks,
      100,
      100000,
      DEFAULT_CONFIG.maxIndexedBlocks,
    );
    merged.chunkSize = clampNumber(merged.chunkSize, 200, 4000, DEFAULT_CONFIG.chunkSize);
    merged.chunkOverlap = clampNumber(merged.chunkOverlap, 0, Math.floor(merged.chunkSize / 2), DEFAULT_CONFIG.chunkOverlap);
    merged.batchSize = clampNumber(merged.batchSize, 1, 128, DEFAULT_CONFIG.batchSize);
    merged.shardSize = clampNumber(merged.shardSize, 20, 500, DEFAULT_CONFIG.shardSize);
    merged.autoIndexEveryHours = clampNumber(
      merged.autoIndexEveryHours,
      1,
      24 * 30,
      DEFAULT_CONFIG.autoIndexEveryHours,
    );
    merged.baseUrl = normalizeBaseUrl(merged.baseUrl);
    this.config = merged;
    await this.saveData(CONFIG_FILE, merged);
    this.startIndexSchedule();
  }

  getApiKey() {
    return window.localStorage.getItem(API_KEY_STORAGE) || "";
  }

  setApiKey(value) {
    const key = String(value || "").trim();
    if (key) window.localStorage.setItem(API_KEY_STORAGE, key);
    else window.localStorage.removeItem(API_KEY_STORAGE);
  }

  startIndexSchedule() {
    if (this.indexTimer) window.clearInterval(this.indexTimer);
    const hours = clampNumber(this.config.autoIndexEveryHours, 1, 24 * 30, DEFAULT_CONFIG.autoIndexEveryHours);
    this.indexTimer = window.setInterval(() => {
      if (this.config.autoIndexOnStart) this.buildIndex(null, { silent: true });
    }, hours * 60 * 60 * 1000);
  }

  openMainDialog() {
    const dialog = new Dialog({
      title: "Knowledge AI",
      content: this.renderDialog(),
      width: "min(1100px, 92vw)",
      height: "min(820px, 88vh)",
      destroyCallback: () => {},
    });
    const root = dialog.element.querySelector(".kai-root");
    this.bindDialog(root);
    this.refreshIndexStatus(root);
  }

  renderDialog() {
    const config = this.config || DEFAULT_CONFIG;
    return `
      <div class="kai-root">
        <div class="kai-layout">
          <section class="kai-panel kai-settings">
            <div class="kai-section-title">模型</div>
            <label>接口地址
              <input class="b3-text-field kai-input" data-kai-config="baseUrl" value="${escapeHtml(config.baseUrl)}">
            </label>
            <label>聊天模型
              <input class="b3-text-field kai-input" data-kai-config="chatModel" value="${escapeHtml(config.chatModel)}">
            </label>
            <label>Embedding 模型
              <input class="b3-text-field kai-input" data-kai-config="embeddingModel" value="${escapeHtml(config.embeddingModel)}">
            </label>
            <label>API Key
              <input class="b3-text-field kai-input" type="password" data-kai-api-key value="${escapeHtml(this.getApiKey())}">
            </label>
            <div class="kai-grid">
              <label>温度
                <input class="b3-text-field kai-input" type="number" step="0.1" min="0" max="2" data-kai-config="temperature" value="${escapeHtml(config.temperature)}">
              </label>
              <label>引用数
                <input class="b3-text-field kai-input" type="number" min="1" max="30" data-kai-config="topK" value="${escapeHtml(config.topK)}">
              </label>
            </div>

            <div class="kai-section-title">索引</div>
            <div class="kai-grid">
              <label>块上限
                <input class="b3-text-field kai-input" type="number" min="100" data-kai-config="maxIndexedBlocks" value="${escapeHtml(config.maxIndexedBlocks)}">
              </label>
              <label>分片大小
                <input class="b3-text-field kai-input" type="number" min="20" data-kai-config="shardSize" value="${escapeHtml(config.shardSize)}">
              </label>
            </div>
            <label class="kai-check">
              <input type="checkbox" data-kai-config="autoIndexOnStart" ${config.autoIndexOnStart ? "checked" : ""}>
              启动后定期更新
            </label>
            <label>间隔小时
              <input class="b3-text-field kai-input" type="number" min="1" data-kai-config="autoIndexEveryHours" value="${escapeHtml(config.autoIndexEveryHours)}">
            </label>

            <div class="kai-section-title">写入</div>
            <label>默认笔记本
              <select class="b3-select kai-input" data-kai-config="defaultNotebook">
                <option value="${escapeHtml(config.defaultNotebook)}">${escapeHtml(config.defaultNotebook || "未选择")}</option>
              </select>
            </label>
            <label>默认路径
              <input class="b3-text-field kai-input" data-kai-config="defaultPath" value="${escapeHtml(config.defaultPath)}">
            </label>
            <label>系统提示词
              <textarea class="b3-text-field kai-input kai-system" data-kai-config="systemPrompt">${escapeHtml(config.systemPrompt)}</textarea>
            </label>

            <div class="kai-actions">
              <button class="b3-button" data-kai-action="save-settings">保存</button>
              <button class="b3-button b3-button--outline" data-kai-action="load-notebooks">笔记本</button>
            </div>
          </section>

          <section class="kai-panel kai-main">
            <div class="kai-indexbar">
              <div>
                <div class="kai-section-title">本地知识索引</div>
                <div class="kai-muted" data-kai-index-status>读取中...</div>
              </div>
              <div class="kai-actions">
                <button class="b3-button" data-kai-action="build-index">更新索引</button>
                <button class="b3-button b3-button--outline" data-kai-action="clear-index">清空</button>
              </div>
            </div>

            <div class="kai-chat">
              <textarea class="b3-text-field kai-question" data-kai-question placeholder="问你的思源笔记..."></textarea>
              <div class="kai-actions kai-chat-actions">
                <button class="b3-button" data-kai-action="ask">提问</button>
                <button class="b3-button b3-button--outline" data-kai-action="save-answer-doc">存为文档</button>
                <button class="b3-button b3-button--outline" data-kai-action="append-answer-doc">追加到当前文档</button>
              </div>
              <div class="kai-answer" data-kai-answer></div>
              <div class="kai-sources" data-kai-sources></div>
            </div>

            <pre class="kai-log" data-kai-log></pre>
          </section>
        </div>
      </div>
    `;
  }

  bindDialog(root) {
    if (!root) return;
    root.addEventListener("click", async (event) => {
      const target = event.target.closest("[data-kai-action], [data-kai-open-block]");
      if (!target) return;
      event.preventDefault();

      const action = target.getAttribute("data-kai-action");
      const blockId = target.getAttribute("data-kai-open-block");
      try {
        if (blockId) {
          await this.openBlock(blockId);
        } else if (action === "save-settings") {
          await this.readAndSaveSettings(root);
          this.setLog(root, "设置已保存");
        } else if (action === "load-notebooks") {
          await this.loadNotebookOptions(root);
        } else if (action === "build-index") {
          await this.readAndSaveSettings(root);
          await this.buildIndex(root);
        } else if (action === "clear-index") {
          await this.clearIndex(root);
        } else if (action === "ask") {
          await this.ask(root);
        } else if (action === "save-answer-doc") {
          await this.saveAnswerAsDocument(root);
        } else if (action === "append-answer-doc") {
          await this.appendAnswerToCurrentDocument(root);
        }
      } catch (error) {
        console.error("Knowledge AI action failed", error);
        this.setLog(root, `错误：${error.message || error}`, true);
        showMessage(`Knowledge AI：${error.message || error}`, 7000, "error");
      }
    });
  }

  async readAndSaveSettings(root) {
    const next = Object.assign({}, this.config);
    for (const input of root.querySelectorAll("[data-kai-config]")) {
      const key = input.getAttribute("data-kai-config");
      if (input.type === "checkbox") next[key] = input.checked;
      else if (input.type === "number") next[key] = Number(input.value);
      else next[key] = input.value;
    }
    const apiKeyInput = root.querySelector("[data-kai-api-key]");
    if (apiKeyInput) this.setApiKey(apiKeyInput.value);
    await this.saveConfig(next);
  }

  setLog(root, text, isError) {
    const log = root && root.querySelector("[data-kai-log]");
    if (!log) return;
    const line = `[${new Date().toLocaleTimeString()}] ${text}`;
    log.textContent = `${line}\n${log.textContent || ""}`.slice(0, 8000);
    log.classList.toggle("kai-log-error", Boolean(isError));
  }

  setIndexStatus(root, text) {
    const element = root && root.querySelector("[data-kai-index-status]");
    if (element) element.textContent = text;
  }

  async refreshIndexStatus(root) {
    const manifest = await this.readManifest();
    if (!manifest) {
      this.setIndexStatus(root, "未建立索引");
      return;
    }
    this.setIndexStatus(
      root,
      `${manifest.chunkCount || 0} 个片段 / ${manifest.shards ? manifest.shards.length : 0} 个分片 / ${manifest.builtAt || ""}`,
    );
  }

  async loadNotebookOptions(root) {
    const data = await this.siyuanPost("/api/notebook/lsNotebooks", {});
    const select = root.querySelector('[data-kai-config="defaultNotebook"]');
    if (!select) return;
    const notebooks = (data && data.notebooks ? data.notebooks : []).filter((item) => !item.closed);
    select.innerHTML = notebooks
      .map((item) => {
        const selected = item.id === this.config.defaultNotebook ? "selected" : "";
        return `<option value="${escapeHtml(item.id)}" ${selected}>${escapeHtml(item.name)} (${escapeHtml(item.id)})</option>`;
      })
      .join("");
    this.setLog(root, `已读取 ${notebooks.length} 个笔记本`);
  }

  async siyuanPost(path, payload) {
    const response = await fetchSyncPost(path, payload || {});
    if (!response || response.code !== 0) {
      throw new Error((response && response.msg) || `${path} 调用失败`);
    }
    return response.data;
  }

  async readJsonFile(path, fallback) {
    const response = await fetch("/api/file/getFile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (response.status === 202 || response.status === 404) return fallback;
    const text = await response.text();
    if (!text) return fallback;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.code === "number" && parsed.code !== 0) return fallback;
      return parsed;
    } catch (error) {
      console.warn("Knowledge AI: failed to parse json file", path, error);
      return fallback;
    }
  }

  async putJsonFile(path, value) {
    const blob = new Blob([JSON.stringify(value)], { type: "application/json" });
    const file = new File([blob], path.split("/").pop() || "data.json", { type: "application/json" });
    const form = new FormData();
    form.append("path", path);
    form.append("file", file);
    form.append("isDir", "false");
    const response = await fetch("/api/file/putFile", {
      method: "POST",
      body: form,
    });
    const data = await response.json();
    if (!data || data.code !== 0) throw new Error((data && data.msg) || `写入 ${path} 失败`);
  }

  async removeFile(path) {
    const response = await fetch("/api/file/removeFile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = await response.json();
    if (data && data.code !== 0) throw new Error(data.msg || `删除 ${path} 失败`);
  }

  async readManifest() {
    return this.readJsonFile(makeManifestPath(PLUGIN_NAME), null);
  }

  async buildIndex(root, options) {
    const silent = options && options.silent;
    const apiKey = this.getApiKey();
    if (!apiKey) {
      if (!silent) throw new Error("请先填写 API Key");
      return;
    }
    if (!this.config.embeddingModel) {
      if (!silent) throw new Error("请先填写 Embedding 模型");
      return;
    }

    this.setLog(root, "开始读取思源块索引");
    const limit = clampNumber(this.config.maxIndexedBlocks, 100, 100000, DEFAULT_CONFIG.maxIndexedBlocks);
    const sql = [
      "SELECT id, root_id, parent_id, box, path, hpath, type, subtype, content, updated",
      "FROM blocks",
      "WHERE content IS NOT NULL AND content != ''",
      "AND type IN ('d','h','p','l','i','c','b','m','t')",
      "ORDER BY updated DESC",
      `LIMIT ${limit}`,
    ].join(" ");
    const rows = (await this.siyuanPost("/api/query/sql", { stmt: sql })) || [];
    const chunks = [];
    for (const row of rows) chunks.push(...blockToChunks(row, this.config));
    if (!chunks.length) throw new Error("没有可索引的块内容");

    this.setLog(root, `准备向量化 ${chunks.length} 个片段`);
    const batchSize = clampNumber(this.config.batchSize, 1, 128, DEFAULT_CONFIG.batchSize);
    for (let start = 0; start < chunks.length; start += batchSize) {
      const batch = chunks.slice(start, start + batchSize);
      const embeddings = await this.embedTexts(batch.map((item) => item.text));
      embeddings.forEach((embedding, index) => {
        batch[index].embedding = embedding;
      });
      this.setLog(root, `向量化 ${Math.min(start + batch.length, chunks.length)} / ${chunks.length}`);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }

    await this.writeIndex(root, rows, chunks);
    await this.refreshIndexStatus(root);
    if (!silent) showMessage("Knowledge AI：索引已更新");
  }

  async writeIndex(root, rows, chunks) {
    const oldManifest = await this.readManifest();
    if (oldManifest && Array.isArray(oldManifest.shards)) {
      for (const shard of oldManifest.shards) {
        if (shard && shard.path) {
          try {
            await this.removeFile(shard.path);
          } catch (error) {
            console.warn("Knowledge AI: failed to remove old shard", shard.path, error);
          }
        }
      }
    }

    const shardSize = clampNumber(this.config.shardSize, 20, 500, DEFAULT_CONFIG.shardSize);
    const shards = [];
    for (let start = 0; start < chunks.length; start += shardSize) {
      const shardChunks = chunks.slice(start, start + shardSize);
      const shardId = `shard-${String(shards.length + 1).padStart(5, "0")}`;
      const path = makeShardPath(PLUGIN_NAME, shardId);
      await this.putJsonFile(path, {
        id: shardId,
        createdAt: nowIso(),
        chunks: shardChunks,
      });
      shards.push({ id: shardId, path, count: shardChunks.length });
      this.setLog(root, `写入分片 ${shards.length}`);
    }

    const manifest = {
      version: CURRENT_INDEX_VERSION,
      plugin: PLUGIN_NAME,
      builtAt: nowIso(),
      baseUrl: normalizeBaseUrl(this.config.baseUrl),
      embeddingModel: this.config.embeddingModel,
      chunkSize: this.config.chunkSize,
      chunkOverlap: this.config.chunkOverlap,
      blockCount: rows.length,
      chunkCount: chunks.length,
      shards,
      hash: stableHash(chunks.map((item) => item.hash).join("\n")),
    };
    await this.putJsonFile(makeManifestPath(PLUGIN_NAME), manifest);
  }

  async clearIndex(root) {
    const manifest = await this.readManifest();
    if (!manifest) {
      this.setLog(root, "没有可清空的索引");
      return;
    }
    if (!window.confirm("清空 Knowledge AI 的索引分片？不会删除你的笔记。")) return;
    for (const shard of manifest.shards || []) {
      if (shard.path) {
        try {
          await this.removeFile(shard.path);
        } catch (error) {
          console.warn("Knowledge AI: failed to remove shard", error);
        }
      }
    }
    await this.removeFile(makeManifestPath(PLUGIN_NAME));
    this.setLog(root, "索引已清空");
    await this.refreshIndexStatus(root);
  }

  async loadIndexedChunks() {
    const manifest = await this.readManifest();
    if (!manifest || !Array.isArray(manifest.shards) || !manifest.shards.length) {
      throw new Error("索引不存在，请先更新索引");
    }
    if (manifest.embeddingModel !== this.config.embeddingModel) {
      throw new Error(`当前 Embedding 模型为 ${this.config.embeddingModel}，索引使用 ${manifest.embeddingModel}，请重新更新索引`);
    }
    const chunks = [];
    for (const shard of manifest.shards) {
      const data = await this.readJsonFile(shard.path, null);
      if (data && Array.isArray(data.chunks)) chunks.push(...data.chunks);
    }
    if (!chunks.length) throw new Error("索引分片为空，请重新更新索引");
    return chunks;
  }

  async ask(root) {
    await this.readAndSaveSettings(root);
    const question = root.querySelector("[data-kai-question]").value.trim();
    if (!question) throw new Error("请输入问题");
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error("请先填写 API Key");

    this.setLog(root, "检索相关笔记");
    const chunks = await this.loadIndexedChunks();
    const queryEmbedding = (await this.embedTexts([question]))[0];
    const ranked = rankChunks(chunks, queryEmbedding, this.config.topK);
    this.lastSources = ranked;
    this.renderSources(root, ranked);

    this.setLog(root, "请求聊天模型");
    const messages = buildMessages(this.config, question, ranked);
    const answer = await this.chat(messages);
    this.lastAnswer = answer;
    this.renderAnswer(root, answer);
    this.setLog(root, "回答完成");
  }

  async embedTexts(texts) {
    const response = await fetch(`${normalizeBaseUrl(this.config.baseUrl)}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.getApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.embeddingModel,
        input: texts,
      }),
    });
    if (!response.ok) throw new Error(`Embedding API ${response.status}: ${await response.text()}`);
    const data = await response.json();
    if (!Array.isArray(data.data)) throw new Error("Embedding API 返回格式不正确");
    return data.data
      .slice()
      .sort((a, b) => Number(a.index || 0) - Number(b.index || 0))
      .map((item) => item.embedding);
  }

  async chat(messages) {
    const response = await fetch(`${normalizeBaseUrl(this.config.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.getApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.chatModel,
        messages,
        temperature: this.config.temperature,
      }),
    });
    if (!response.ok) throw new Error(`Chat API ${response.status}: ${await response.text()}`);
    const data = await response.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error("Chat API 没有返回回答内容");
    return content;
  }

  renderAnswer(root, answer) {
    const element = root.querySelector("[data-kai-answer]");
    if (!element) return;
    element.innerHTML = `<pre>${escapeHtml(answer)}</pre>`;
  }

  renderSources(root, ranked) {
    const element = root.querySelector("[data-kai-sources]");
    if (!element) return;
    if (!ranked || !ranked.length) {
      element.innerHTML = "";
      return;
    }
    element.innerHTML = ranked
      .map((item, index) => {
        const chunk = item.chunk;
        const title = chunk.hpath || chunk.title || chunk.blockId;
        return `
          <div class="kai-source">
            <button class="b3-button b3-button--outline" data-kai-open-block="${escapeHtml(chunk.blockId)}">[${index + 1}]</button>
            <div>
              <div class="kai-source-title">${escapeHtml(title)}</div>
              <div class="kai-muted">${escapeHtml(chunk.blockId)} · ${item.score.toFixed(3)}</div>
              <div class="kai-source-text">${escapeHtml(chunk.text.slice(0, 240))}</div>
            </div>
          </div>
        `;
      })
      .join("");
  }

  async openBlock(blockId) {
    const id = escapeSql(blockId);
    const rows = await this.siyuanPost("/api/query/sql", {
      stmt: `SELECT id, root_id, type FROM blocks WHERE id='${id}' LIMIT 1`,
    });
    const row = rows && rows[0];
    const docId = row && row.type === "d" ? row.id : row && row.root_id ? row.root_id : blockId;
    await openTab({
      app: this.app,
      doc: {
        id: docId,
        action: ["cb-get-focus", "cb-get-hl"],
      },
      keepCursor: false,
      removeCurrentTab: false,
      openNewTab: true,
    });
  }

  async saveAnswerAsDocument(root) {
    if (!this.lastAnswer) throw new Error("没有可保存的回答");
    await this.readAndSaveSettings(root);
    let notebook = this.config.defaultNotebook;
    if (!notebook) {
      const data = await this.siyuanPost("/api/notebook/lsNotebooks", {});
      const first = (data.notebooks || []).find((item) => !item.closed);
      notebook = first && first.id;
    }
    if (!notebook) throw new Error("请先选择默认笔记本");
    const title = window.prompt("文档标题", `AI 回答 ${new Date().toLocaleString()}`);
    if (!title) return;
    const directory = normalizeDocPath(this.config.defaultPath || "/Knowledge AI");
    const path = `${directory}/${safePathSegment(title)}`;
    const markdown = this.formatAnswerMarkdown(title);
    if (!window.confirm(`创建文档：${path}`)) return;
    const id = await this.siyuanPost("/api/filetree/createDocWithMd", {
      notebook,
      path,
      markdown,
    });
    this.setLog(root, `已创建文档 ${id || path}`);
    showMessage("Knowledge AI：文档已创建");
  }

  async appendAnswerToCurrentDocument(root) {
    if (!this.lastAnswer) throw new Error("没有可追加的回答");
    const docId = await this.getCurrentDocId();
    if (!docId) throw new Error("没有找到当前文档");
    const markdown = `\n\n${this.formatAnswerMarkdown("AI 回答")}`;
    if (!window.confirm(`追加回答到当前文档：${docId}`)) return;
    await this.siyuanPost("/api/block/appendBlock", {
      dataType: "markdown",
      data: markdown,
      parentID: docId,
    });
    this.setLog(root, `已追加到 ${docId}`);
    showMessage("Knowledge AI：已追加到当前文档");
  }

  async getCurrentDocId() {
    if (typeof siyuan.getActiveEditor === "function") {
      const editor = siyuan.getActiveEditor(false);
      const blockId =
        editor &&
        editor.protyle &&
        editor.protyle.block &&
        (editor.protyle.block.id || editor.protyle.block.parentID);
      if (blockId) return this.resolveRootDocument(blockId);
    }
    const activeTitle = document.querySelector(".layout__wnd--active .protyle-title[data-node-id]");
    const domId = activeTitle && activeTitle.getAttribute("data-node-id");
    if (domId) return this.resolveRootDocument(domId);
    return "";
  }

  async resolveRootDocument(blockId) {
    const rows = await this.siyuanPost("/api/query/sql", {
      stmt: `SELECT id, root_id, type FROM blocks WHERE id='${escapeSql(blockId)}' LIMIT 1`,
    });
    const row = rows && rows[0];
    if (!row) return blockId;
    return row.type === "d" ? row.id : row.root_id || blockId;
  }

  formatAnswerMarkdown(title) {
    const lines = [`# ${title}`, "", this.lastAnswer.trim()];
    if (this.lastSources && this.lastSources.length) {
      lines.push("", "## 引用");
      this.lastSources.forEach((item, index) => {
        const chunk = item.chunk;
        const sourceTitle = chunk.hpath || chunk.title || chunk.blockId;
        lines.push(`${index + 1}. ${sourceTitle} \`${chunk.blockId}\``);
      });
    }
    return lines.join("\n");
  }
}

function normalizeDocPath(value) {
  const text = String(value || "/Knowledge AI").trim().replace(/\\/g, "/");
  return `/${text.replace(/^\/+|\/+$/g, "")}`;
}

function safePathSegment(value) {
  return String(value || "Untitled")
    .trim()
    .replace(/[\\/:*?"<>|#\[\]]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

module.exports = SiyuanKnowledgeAI;
