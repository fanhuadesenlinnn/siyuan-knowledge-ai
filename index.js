"use strict";

const siyuan = require("siyuan");
const {
  DEFAULT_CONFIG,
  blockToChunks,
  buildMessages,
  buildModelProxyPayload,
  clampNumber,
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
} = require("./lib/core");

const {
  Dialog,
  Plugin,
  fetchSyncPost,
  getActiveEditor,
  openTab,
  showMessage,
} = siyuan;

const PLUGIN_NAME = "siyuan-knowledge-ai";
const CONFIG_FILE = "config.json";
const API_KEY_STORAGE = `${PLUGIN_NAME}:api-key`;
const TAB_TYPE = "knowledge-ai-workbench";
const CURRENT_INDEX_VERSION = 1;
const INDEX_ROOT = `/data/storage/petal/${PLUGIN_NAME}/index`;

class SiyuanKnowledgeAI extends Plugin {
  async onload() {
    this.config = await this.loadConfig();
    this.lastAnswer = "";
    this.lastQuestion = "";
    this.lastSources = [];
    this.noteDraft = "";
    this.updateDraft = null;
    this.activeRoots = new Set();
    this.indexTimer = null;
    this.indexing = false;

    this.addIcons(`
      <symbol id="iconKnowledgeAI" viewBox="0 0 24 24">
        <path d="M12 2.75a2.75 2.75 0 0 1 2.7 2.25h1.55A3.75 3.75 0 0 1 20 8.75v6.5A3.75 3.75 0 0 1 16.25 19h-.52a3.25 3.25 0 0 1-6.46 0h-.52A3.75 3.75 0 0 1 5 15.25v-6.5A3.75 3.75 0 0 1 8.75 5h1.55A2.75 2.75 0 0 1 12 2.75Zm0 1.5a1.25 1.25 0 0 0-1.25 1.25v.25c0 .41-.34.75-.75.75H8.75A2.25 2.25 0 0 0 6.5 8.75v6.5a2.25 2.25 0 0 0 2.25 2.25H10c.41 0 .75.34.75.75a1.25 1.25 0 0 0 2.5 0c0-.41.34-.75.75-.75h2.25a2.25 2.25 0 0 0 2.25-2.25v-6.5a2.25 2.25 0 0 0-2.25-2.25H14c-.41 0-.75-.34-.75-.75V5.5A1.25 1.25 0 0 0 12 4.25Z"/>
        <path d="M9.25 10.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm5.5 0a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z"/>
      </symbol>
    `);

    this.registerWorkbenchTab();
    this.createSettingPanel();

    this.addCommand({
      langKey: "openKnowledgeAI",
      hotkey: "",
      callback: () => this.openWorkbench(),
    });

    this.startIndexSchedule();
    if (this.config.autoIndexOnStart) {
      window.setTimeout(() => this.buildIndex(null, { silent: true }), 5000);
    }
  }

  onLayoutReady() {
    if (this.topBarElement) return;
    this.topBarElement = this.addTopBar({
      icon: "iconKnowledgeAI",
      title: "Knowledge AI",
      position: "right",
      callback: () => this.openWorkbench(),
    });
  }

  onunload() {
    if (this.indexTimer) window.clearInterval(this.indexTimer);
    this.activeRoots.clear();
  }

  registerWorkbenchTab() {
    const plugin = this;
    this.workbenchFactory = this.addTab({
      type: TAB_TYPE,
      init() {
        plugin.initWorkbench(this);
      },
      update() {
        plugin.refreshWorkbench(this.data && this.data.root);
      },
      destroy() {
        if (this.data && this.data.root) plugin.activeRoots.delete(this.data.root);
      },
    });
  }

  async openWorkbench() {
    await openTab({
      app: this.app,
      custom: {
        id: `${this.name}${TAB_TYPE}`,
        icon: "iconKnowledgeAI",
        title: "Knowledge AI",
        data: {},
      },
      keepCursor: false,
    });
  }

  initWorkbench(customTab) {
    customTab.element.classList.add("kai-workbench-host");
    customTab.element.innerHTML = this.renderWorkbench();
    const root = customTab.element.querySelector(".kai-root");
    customTab.data = Object.assign({}, customTab.data || {}, { root });
    this.activeRoots.add(root);
    this.bindWorkbench(root);
    this.refreshWorkbench(root);
  }

  createSettingPanel() {
    this.setting = {
      open: () => this.openSetting(),
    };
  }

  openSetting() {
    const dialog = new Dialog({
      title: this.name,
      content: this.renderSettingsDialog(),
      width: "min(760px, 92vw)",
      height: "min(720px, 86vh)",
    });
    const root = dialog.element.querySelector(".kai-settings-dialog");
    this.bindSettingsDialog(root, dialog);
  }

  renderSettingsDialog() {
    return `
      <div class="kai-settings-dialog">
        <div class="kai-settings-scroll">
          ${this.renderSettingField("baseUrl", "接口地址", "OpenAI 或 OpenAI-compatible Base URL，例如 https://api.openai.com/v1。")}
          ${this.renderSettingField("apiKey", "API Key", "本机保存，不写入同步索引；本地 Ollama 可留空。", { password: true, local: true })}
          ${this.renderSettingField("chatModel", "聊天模型", "用于回答、生成草稿和改写笔记。")}
          ${this.renderSettingField("embeddingModel", "Embedding 模型", "用于全库索引和提问检索；换模型后需要重建索引。")}
          ${this.renderSettingField("temperature", "温度", "回答和草稿生成的随机性。", { number: true, step: "0.1", min: "0", max: "2" })}
          ${this.renderSettingField("topK", "引用数量", "每次问答最多送入模型的笔记片段数。", { number: true, min: "1", max: "30" })}
          ${this.renderSettingField("maxIndexedBlocks", "索引块上限", "手动更新索引时最多读取多少个思源块。", { number: true, min: "100" })}
          ${this.renderSettingField("chunkSize", "片段长度", "单个索引片段的最大字符数。", { number: true, min: "200" })}
          ${this.renderSettingField("chunkOverlap", "片段重叠", "相邻片段保留的重叠字符数。", { number: true, min: "0" })}
          ${this.renderSettingField("batchSize", "向量批量", "每次 Embedding 请求包含的片段数。", { number: true, min: "1", max: "128" })}
          ${this.renderSettingField("shardSize", "分片大小", "每个同步索引分片保存的片段数。", { number: true, min: "20", max: "500" })}
          ${this.renderSettingField("modelTimeoutMs", "模型超时毫秒", "通过思源代理调用模型接口的超时时间。", { number: true, min: "1000" })}
          ${this.renderSettingField("defaultNotebook", "默认笔记本 ID", "新增笔记保存到这个笔记本；也可在工作台中读取并选择。")}
          ${this.renderSettingField("defaultPath", "默认保存路径", "新增 AI 笔记的父路径。")}
          ${this.renderSettingField("allowWriteActions", "允许写入笔记", "关闭后只能问答，不能新增、追加或修改笔记。", { checkbox: true })}
          ${this.renderSettingField("autoIndexOnStart", "启动后定期更新", "启用后按下方间隔自动重建索引。", { checkbox: true })}
          ${this.renderSettingField("autoIndexEveryHours", "自动索引间隔小时", "仅在启用定期更新时生效。", { number: true, min: "1" })}
          ${this.renderSettingField("systemPrompt", "系统提示词", "问答时使用的系统提示词。", { textarea: true })}
        </div>
        <div class="kai-settings-actions">
          <button class="b3-button b3-button--cancel" data-kai-settings-cancel>取消</button>
          <button class="b3-button" data-kai-settings-save>保存</button>
        </div>
      </div>
    `;
  }

  renderSettingField(key, title, description, options) {
    const settingOptions = options || {};
    const local = settingOptions.local ? ` data-kai-local="true"` : "";
    const value = settingOptions.local ? this.getApiKey() : this.config[key];
    const common = `data-kai-setting-key="${escapeHtml(key)}"${local}`;
    let control = "";
    if (settingOptions.checkbox) {
      control = `<input class="b3-switch fn__flex-shrink" type="checkbox" ${common} ${value ? "checked" : ""}>`;
    } else if (settingOptions.textarea) {
      control = `<textarea class="b3-text-field kai-setting-textarea" ${common}>${escapeHtml(value == null ? "" : value)}</textarea>`;
    } else {
      const type = settingOptions.password ? "password" : settingOptions.number ? "number" : "text";
      const attrs = [
        `type="${type}"`,
        settingOptions.step ? `step="${escapeHtml(settingOptions.step)}"` : "",
        settingOptions.min ? `min="${escapeHtml(settingOptions.min)}"` : "",
        settingOptions.max ? `max="${escapeHtml(settingOptions.max)}"` : "",
      ]
        .filter(Boolean)
        .join(" ");
      control = `<input class="b3-text-field kai-setting-input" ${attrs} ${common} value="${escapeHtml(value == null ? "" : value)}">`;
    }
    return `
      <label class="kai-setting-row ${settingOptions.checkbox ? "kai-setting-row-check" : ""}">
        <span class="kai-setting-copy">
          <span class="kai-setting-title">${escapeHtml(title)}</span>
          <span class="kai-setting-desc">${escapeHtml(description)}</span>
        </span>
        ${control}
      </label>
    `;
  }

  bindSettingsDialog(root, dialog) {
    if (!root) return;
    root.addEventListener("click", async (event) => {
      const cancel = event.target.closest("[data-kai-settings-cancel]");
      const save = event.target.closest("[data-kai-settings-save]");
      if (!cancel && !save) return;
      event.preventDefault();
      event.stopPropagation();
      if (cancel) {
        dialog.destroy();
        return;
      }
      try {
        await this.saveSettingsFromDialog(root);
        dialog.destroy();
      } catch (error) {
        console.error("Knowledge AI: failed to save settings", error);
        showMessage(`Knowledge AI：${error.message || error}`, 7000, "error");
      }
    });
  }

  async saveSettingsFromDialog(root) {
    const next = Object.assign({}, this.config);
    for (const element of root.querySelectorAll("[data-kai-setting-key]")) {
      const key = element.getAttribute("data-kai-setting-key");
      if (element.dataset.kaiLocal === "true") {
        this.setApiKey(element.value);
      } else if (element.type === "checkbox") {
        next[key] = element.checked;
      } else if (element.type === "number") {
        next[key] = Number(element.value);
      } else {
        next[key] = element.value;
      }
    }
    await this.saveConfig(next);
    this.refreshAllWorkbenches();
    showMessage("Knowledge AI：设置已保存");
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
    merged.modelTimeoutMs = clampNumber(merged.modelTimeoutMs, 1000, 10 * 60 * 1000, DEFAULT_CONFIG.modelTimeoutMs);
    merged.autoIndexEveryHours = clampNumber(
      merged.autoIndexEveryHours,
      1,
      24 * 30,
      DEFAULT_CONFIG.autoIndexEveryHours,
    );
    merged.baseUrl = normalizeBaseUrl(merged.baseUrl);
    merged.allowWriteActions = Boolean(merged.allowWriteActions);
    merged.autoIndexOnStart = Boolean(merged.autoIndexOnStart);
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

  renderWorkbench() {
    const config = this.config || DEFAULT_CONFIG;
    return `
      <div class="kai-root">
        <div class="kai-shell">
          <aside class="kai-sidebar">
            <div class="kai-brand">
              <svg><use xlink:href="#iconKnowledgeAI"></use></svg>
              <div>
                <div class="kai-title">Knowledge AI</div>
                <div class="kai-muted">全库问答与安全写入</div>
              </div>
            </div>

            <section class="kai-section">
              <div class="kai-section-head">索引</div>
              <div class="kai-status" data-kai-index-status>读取中...</div>
              <progress class="kai-progress" data-kai-progress value="0" max="1"></progress>
              <div class="kai-actions kai-actions-stack">
                <button class="b3-button" data-kai-action="build-index">更新全库索引</button>
                <button class="b3-button b3-button--outline" data-kai-action="refresh-index">刷新状态</button>
                <button class="b3-button b3-button--outline" data-kai-action="clear-index">清空索引</button>
              </div>
            </section>

            <section class="kai-section">
              <div class="kai-section-head">写入位置</div>
              <label>笔记本
                <select class="b3-select kai-input" data-kai-config="defaultNotebook">
                  <option value="${escapeHtml(config.defaultNotebook)}">${escapeHtml(config.defaultNotebook || "未选择")}</option>
                </select>
              </label>
              <label>路径
                <input class="b3-text-field kai-input" data-kai-config="defaultPath" value="${escapeHtml(config.defaultPath)}">
              </label>
              <button class="b3-button b3-button--outline" data-kai-action="load-notebooks">读取笔记本</button>
            </section>

            <section class="kai-section">
              <div class="kai-section-head">模型</div>
              <div class="kai-kv"><span>Chat</span><strong>${escapeHtml(config.chatModel)}</strong></div>
              <div class="kai-kv"><span>Embedding</span><strong>${escapeHtml(config.embeddingModel)}</strong></div>
              <div class="kai-kv"><span>Base URL</span><strong>${escapeHtml(config.baseUrl)}</strong></div>
              <button class="b3-button b3-button--outline" data-kai-action="open-settings">插件设置</button>
            </section>
          </aside>

          <main class="kai-main">
            <section class="kai-pane kai-chat-pane">
              <div class="kai-pane-head">
                <div>
                  <h2>全库问答</h2>
                  <p>基于同步索引检索全库笔记，回答会带引用来源。</p>
                </div>
                <button class="b3-button b3-button--outline" data-kai-action="copy-answer">复制回答</button>
              </div>
              <textarea class="b3-text-field kai-question" data-kai-question placeholder="问你的思源全库笔记..."></textarea>
              <div class="kai-actions">
                <button class="b3-button" data-kai-action="ask">提问</button>
                <button class="b3-button b3-button--outline" data-kai-action="save-answer-doc">回答存为新文档</button>
                <button class="b3-button b3-button--outline" data-kai-action="append-answer-doc">追加回答到当前文档</button>
              </div>
              <div class="kai-answer" data-kai-answer></div>
              <div class="kai-sources" data-kai-sources></div>
            </section>

            <section class="kai-pane kai-write-pane">
              <div class="kai-pane-head">
                <div>
                  <h2>添加笔记</h2>
                  <p>先生成草稿，确认后再写入思源。</p>
                </div>
              </div>
              <div class="kai-grid">
                <label>标题
                  <input class="b3-text-field kai-input" data-kai-new-note-title value="AI 笔记">
                </label>
                <label>保存路径
                  <input class="b3-text-field kai-input" data-kai-new-note-path value="${escapeHtml(config.defaultPath)}">
                </label>
              </div>
              <textarea class="b3-text-field kai-prompt" data-kai-new-note-prompt placeholder="描述要新增的笔记，例如：根据刚才回答整理成一份运维检查清单。"></textarea>
              <div class="kai-actions">
                <button class="b3-button" data-kai-action="draft-note">生成新笔记草稿</button>
                <button class="b3-button b3-button--outline" data-kai-action="create-note">确认创建新文档</button>
              </div>
              <textarea class="b3-text-field kai-draft" data-kai-new-note-draft placeholder="新笔记草稿会出现在这里，可手动编辑后再创建。"></textarea>
            </section>

            <section class="kai-pane kai-write-pane">
              <div class="kai-pane-head">
                <div>
                  <h2>修改笔记块</h2>
                  <p>选择块 ID，生成改写草稿，确认后覆盖该块。</p>
                </div>
              </div>
              <div class="kai-grid">
                <label>目标块 ID
                  <input class="b3-text-field kai-input" data-kai-target-block placeholder="可从引用来源选择，也可留空使用当前文档块">
                </label>
                <label>操作
                  <button class="b3-button b3-button--outline kai-inline-button" data-kai-action="use-current-block">使用当前块</button>
                </label>
              </div>
              <textarea class="b3-text-field kai-prompt" data-kai-update-instruction placeholder="说明要怎么修改，例如：补充成正式周报格式，保留原有账号密码，不要删减事实。"></textarea>
              <div class="kai-actions">
                <button class="b3-button" data-kai-action="draft-update">生成修改草稿</button>
                <button class="b3-button b3-button--outline" data-kai-action="apply-update">确认覆盖目标块</button>
              </div>
              <textarea class="b3-text-field kai-draft" data-kai-update-draft placeholder="修改草稿会出现在这里，可手动编辑后再覆盖。"></textarea>
            </section>

            <pre class="kai-log" data-kai-log></pre>
          </main>
        </div>
      </div>
    `;
  }

  bindWorkbench(root) {
    if (!root) return;
    root.addEventListener("click", async (event) => {
      const target = event.target.closest("[data-kai-action], [data-kai-open-block], [data-kai-target-source]");
      if (!target) return;
      event.preventDefault();

      const action = target.getAttribute("data-kai-action");
      const blockId = target.getAttribute("data-kai-open-block");
      const targetSource = target.getAttribute("data-kai-target-source");
      try {
        if (blockId) {
          await this.openBlock(blockId);
        } else if (targetSource) {
          this.setTargetBlock(root, targetSource);
        } else if (action === "open-settings") {
          this.setting.open(this.name);
        } else if (action === "load-notebooks") {
          await this.loadNotebookOptions(root);
        } else if (action === "build-index") {
          await this.readWorkbenchSettings(root);
          await this.buildIndex(root);
        } else if (action === "refresh-index") {
          await this.refreshWorkbench(root);
        } else if (action === "clear-index") {
          await this.clearIndex(root);
        } else if (action === "ask") {
          await this.ask(root);
        } else if (action === "copy-answer") {
          await this.copyAnswer(root);
        } else if (action === "save-answer-doc") {
          await this.saveAnswerAsDocument(root);
        } else if (action === "append-answer-doc") {
          await this.appendAnswerToCurrentDocument(root);
        } else if (action === "draft-note") {
          await this.draftNewNote(root);
        } else if (action === "create-note") {
          await this.createDraftNote(root);
        } else if (action === "use-current-block") {
          await this.useCurrentBlock(root);
        } else if (action === "draft-update") {
          await this.draftBlockUpdate(root);
        } else if (action === "apply-update") {
          await this.applyBlockUpdate(root);
        }
      } catch (error) {
        console.error("Knowledge AI action failed", error);
        this.setLog(root, `错误：${error.message || error}`, true);
        showMessage(`Knowledge AI：${error.message || error}`, 7000, "error");
      }
    });
  }

  async readWorkbenchSettings(root) {
    if (!root) return;
    const next = Object.assign({}, this.config);
    for (const input of root.querySelectorAll("[data-kai-config]")) {
      const key = input.getAttribute("data-kai-config");
      next[key] = input.value;
    }
    await this.saveConfig(next);
  }

  async refreshWorkbench(root) {
    if (!root) return;
    await this.refreshIndexStatus(root);
    this.renderAnswer(root, this.lastAnswer);
    this.renderSources(root, this.lastSources);
  }

  refreshAllWorkbenches() {
    for (const root of this.activeRoots) {
      this.refreshWorkbench(root);
    }
  }

  setLog(root, text, isError) {
    if (!root) return;
    const log = root.querySelector("[data-kai-log]");
    if (!log) return;
    const line = `[${new Date().toLocaleTimeString()}] ${text}`;
    log.textContent = `${line}\n${log.textContent || ""}`.slice(0, 10000);
    log.classList.toggle("kai-log-error", Boolean(isError));
  }

  broadcastLog(text, isError) {
    for (const root of this.activeRoots) this.setLog(root, text, isError);
  }

  setIndexStatus(root, text) {
    const element = root && root.querySelector("[data-kai-index-status]");
    if (element) element.textContent = text;
  }

  setProgress(root, value, max) {
    const progress = root && root.querySelector("[data-kai-progress]");
    if (!progress) return;
    progress.max = Math.max(1, Number(max || 1));
    progress.value = Math.max(0, Number(value || 0));
  }

  async refreshIndexStatus(root) {
    const manifest = await this.readManifest();
    if (!manifest) {
      this.setIndexStatus(root, "未建立索引。其他设备同步完成后点刷新即可读取。");
      this.setProgress(root, 0, 1);
      return;
    }
    const shardCount = Array.isArray(manifest.shards) ? manifest.shards.length : 0;
    this.setIndexStatus(
      root,
      `${manifest.chunkCount || 0} 个片段 / ${shardCount} 个分片 / ${manifest.embeddingModel || ""} / ${manifest.builtAt || ""}`,
    );
    this.setProgress(root, manifest.chunkCount || shardCount || 1, manifest.chunkCount || shardCount || 1);
  }

  async loadNotebookOptions(root) {
    const data = await this.siyuanPost("/api/notebook/lsNotebooks", {});
    const select = root.querySelector('[data-kai-config="defaultNotebook"]');
    if (!select) return;
    const notebooks = (data && data.notebooks ? data.notebooks : []).filter((item) => !item.closed);
    select.innerHTML = [
      `<option value="">未选择</option>`,
      ...notebooks.map((item) => {
        const selected = item.id === this.config.defaultNotebook ? "selected" : "";
        return `<option value="${escapeHtml(item.id)}" ${selected}>${escapeHtml(item.name)} (${escapeHtml(item.id)})</option>`;
      }),
    ].join("");
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
    if (!response.ok) return fallback;
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

  async putDirectory(path) {
    const form = new FormData();
    form.append("path", path);
    form.append("isDir", "true");
    const response = await fetch("/api/file/putFile", {
      method: "POST",
      body: form,
    });
    const data = await response.json();
    if (data && data.code !== 0 && data.code !== 409) {
      console.warn("Knowledge AI: put directory failed", path, data.msg || data);
    }
  }

  async ensureIndexDirs() {
    await this.putDirectory(`/data/storage/petal/${PLUGIN_NAME}`);
    await this.putDirectory(INDEX_ROOT);
    await this.putDirectory(`${INDEX_ROOT}/shards`);
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
    if (data && data.code !== 0 && data.code !== 404) throw new Error(data.msg || `删除 ${path} 失败`);
  }

  async readManifest() {
    return this.readJsonFile(makeManifestPath(PLUGIN_NAME), null);
  }

  async buildIndex(root, options) {
    const silent = options && options.silent;
    if (this.indexing) {
      if (!silent) this.setLog(root, "索引正在更新，请等待当前任务结束");
      return;
    }
    if (!this.config.embeddingModel) {
      if (!silent) throw new Error("请先填写 Embedding 模型");
      return;
    }

    this.indexing = true;
    try {
      this.setProgress(root, 0, 1);
      this.setLog(root, "开始读取思源全库块索引");
      const limit = clampNumber(this.config.maxIndexedBlocks, 100, 100000, DEFAULT_CONFIG.maxIndexedBlocks);
      const sql = [
        "SELECT id, root_id, parent_id, box, path, hpath, type, subtype, content, markdown, updated",
        "FROM blocks",
        "WHERE content IS NOT NULL AND content != ''",
        "AND type IN ('d','h','p','l','i','c','b','m','t','s')",
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
        const done = Math.min(start + batch.length, chunks.length);
        this.setProgress(root, done, chunks.length);
        this.setLog(root, `向量化 ${done} / ${chunks.length}`);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }

      await this.writeIndex(root, rows, chunks);
      await this.refreshIndexStatus(root);
      if (!silent) showMessage("Knowledge AI：索引已更新");
    } finally {
      this.indexing = false;
    }
  }

  async writeIndex(root, rows, chunks) {
    await this.ensureIndexDirs();
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
      this.setLog(root, `写入同步分片 ${shards.length}`);
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
    if (!window.confirm("清空 Knowledge AI 的同步索引分片？不会删除你的笔记。")) return;
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
      throw new Error("索引不存在，请先在任意设备更新索引并等待思源同步");
    }
    if (manifest.version !== CURRENT_INDEX_VERSION) {
      throw new Error("索引版本不兼容，请重新更新索引");
    }
    if (manifest.embeddingModel !== this.config.embeddingModel) {
      throw new Error(`当前 Embedding 模型为 ${this.config.embeddingModel}，索引使用 ${manifest.embeddingModel}，请切回该模型或重新更新索引`);
    }
    const chunks = [];
    for (const shard of manifest.shards) {
      const data = await this.readJsonFile(shard.path, null);
      if (data && Array.isArray(data.chunks)) chunks.push(...data.chunks);
    }
    if (!chunks.length) throw new Error("索引分片为空，请等待同步完成或重新更新索引");
    return chunks;
  }

  async ask(root) {
    await this.readWorkbenchSettings(root);
    const question = root.querySelector("[data-kai-question]").value.trim();
    if (!question) throw new Error("请输入问题");

    this.setLog(root, "读取同步索引并检索相关笔记");
    const chunks = await this.loadIndexedChunks();
    const queryEmbedding = (await this.embedTexts([question]))[0];
    const ranked = rankChunks(chunks, queryEmbedding, this.config.topK);
    this.lastQuestion = question;
    this.lastSources = ranked;
    this.renderSources(root, ranked);

    this.setLog(root, "请求聊天模型");
    const messages = buildMessages(this.config, question, ranked);
    const answer = await this.chat(messages);
    this.lastAnswer = answer;
    this.renderAnswer(root, answer);
    this.setLog(root, "回答完成");
  }

  async modelPost(endpoint, payload, label) {
    const url = `${normalizeBaseUrl(this.config.baseUrl)}/${String(endpoint || "").replace(/^\/+/, "")}`;
    const proxyPayload = buildModelProxyPayload(url, this.getApiKey(), payload, this.config.modelTimeoutMs);
    const data = await this.siyuanPost("/api/network/forwardProxy", proxyPayload);
    return parseModelProxyJson(data, label);
  }

  async embedTexts(texts) {
    const data = await this.modelPost(
      "embeddings",
      {
        model: this.config.embeddingModel,
        input: texts,
      },
      "Embedding",
    );
    const embeddings = extractEmbeddings(data);
    if (embeddings.length !== texts.length) throw new Error("Embedding API 返回数量和请求数量不一致");
    return embeddings;
  }

  async chat(messages) {
    const data = await this.modelPost(
      "chat/completions",
      {
        model: this.config.chatModel,
        messages,
        temperature: this.config.temperature,
      },
      "Chat",
    );
    return extractChatContent(data);
  }

  renderAnswer(root, answer) {
    const element = root && root.querySelector("[data-kai-answer]");
    if (!element) return;
    if (!answer) {
      element.innerHTML = `<div class="kai-empty">回答会显示在这里。</div>`;
      return;
    }
    element.innerHTML = `<pre>${escapeHtml(answer)}</pre>`;
  }

  renderSources(root, ranked) {
    const element = root && root.querySelector("[data-kai-sources]");
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
            <div class="kai-source-index">[${index + 1}]</div>
            <div class="kai-source-body">
              <div class="kai-source-title">${escapeHtml(title)}</div>
              <div class="kai-muted">${escapeHtml(chunk.blockId)} · ${item.score.toFixed(3)}</div>
              <div class="kai-source-text">${escapeHtml(chunk.text.slice(0, 320))}</div>
              <div class="kai-actions">
                <button class="b3-button b3-button--outline" data-kai-open-block="${escapeHtml(chunk.blockId)}">打开引用</button>
                <button class="b3-button b3-button--outline" data-kai-target-source="${escapeHtml(chunk.blockId)}">作为修改目标</button>
              </div>
            </div>
          </div>
        `;
      })
      .join("");
  }

  async openBlock(blockId) {
    try {
      await openTab({
        app: this.app,
        doc: {
          id: blockId,
          action: ["cb-get-focus", "cb-get-hl"],
        },
        keepCursor: false,
        removeCurrentTab: false,
      });
    } catch (error) {
      const rows = await this.siyuanPost("/api/query/sql", {
        stmt: `SELECT id, root_id, type FROM blocks WHERE id='${escapeSql(blockId)}' LIMIT 1`,
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
      });
    }
  }

  async copyAnswer(root) {
    if (!this.lastAnswer) throw new Error("没有可复制的回答");
    await navigator.clipboard.writeText(this.lastAnswer);
    this.setLog(root, "回答已复制");
  }

  ensureWriteAllowed() {
    if (!this.config.allowWriteActions) throw new Error("插件设置中已关闭写入笔记能力");
  }

  async saveAnswerAsDocument(root) {
    this.ensureWriteAllowed();
    if (!this.lastAnswer) throw new Error("没有可保存的回答");
    await this.readWorkbenchSettings(root);
    const notebook = await this.resolveNotebook();
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
    this.ensureWriteAllowed();
    if (!this.lastAnswer) throw new Error("没有可追加的回答");
    const docId = await this.getCurrentBlockId();
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

  async draftNewNote(root) {
    const title = root.querySelector("[data-kai-new-note-title]").value.trim() || "AI 笔记";
    const prompt = root.querySelector("[data-kai-new-note-prompt]").value.trim();
    if (!prompt && !this.lastAnswer) throw new Error("请输入新笔记要求，或先完成一次问答");
    const messages = [
      {
        role: "system",
        content: "你是思源笔记写作助手。请生成可以直接写入思源的 Markdown 正文，只输出正文，不要包裹代码块。",
      },
      {
        role: "user",
        content: [
          `标题：${title}`,
          "",
          "用户要求：",
          prompt || "根据上一轮问答整理成结构化笔记。",
          "",
          "上一轮问题：",
          this.lastQuestion || "无",
          "",
          "上一轮回答：",
          this.lastAnswer || "无",
        ].join("\n"),
      },
    ];
    this.setLog(root, "生成新笔记草稿");
    const draft = await this.chat(messages);
    this.noteDraft = draft;
    root.querySelector("[data-kai-new-note-draft]").value = draft;
    this.setLog(root, "新笔记草稿已生成，请确认后创建");
  }

  async createDraftNote(root) {
    this.ensureWriteAllowed();
    await this.readWorkbenchSettings(root);
    const notebook = await this.resolveNotebook();
    const title = root.querySelector("[data-kai-new-note-title]").value.trim() || "AI 笔记";
    const directory = normalizeDocPath(root.querySelector("[data-kai-new-note-path]").value || this.config.defaultPath);
    const draft = root.querySelector("[data-kai-new-note-draft]").value.trim();
    if (!draft) throw new Error("没有可创建的新笔记草稿");
    const path = `${directory}/${safePathSegment(title)}`;
    if (!window.confirm(`创建新文档：${path}`)) return;
    const id = await this.siyuanPost("/api/filetree/createDocWithMd", {
      notebook,
      path,
      markdown: `# ${title}\n\n${draft}`,
    });
    this.setLog(root, `已创建新笔记 ${id || path}`);
    showMessage("Knowledge AI：新笔记已创建");
  }

  setTargetBlock(root, blockId) {
    const input = root.querySelector("[data-kai-target-block]");
    if (input) input.value = blockId;
    this.setLog(root, `修改目标已设置为 ${blockId}`);
  }

  async useCurrentBlock(root) {
    const blockId = await this.getCurrentBlockId();
    if (!blockId) throw new Error("没有找到当前块");
    this.setTargetBlock(root, blockId);
  }

  async draftBlockUpdate(root) {
    const input = root.querySelector("[data-kai-target-block]");
    const blockId = (input && input.value.trim()) || (await this.getCurrentBlockId());
    if (!blockId) throw new Error("请输入目标块 ID，或先打开一个文档");
    const instruction = root.querySelector("[data-kai-update-instruction]").value.trim();
    if (!instruction) throw new Error("请输入修改要求");
    const data = await this.siyuanPost("/api/block/getBlockKramdown", { id: blockId });
    const original = data && data.kramdown ? data.kramdown : "";
    if (!original) throw new Error("没有读取到目标块内容");
    const messages = [
      {
        role: "system",
        content: "你是思源笔记改写助手。根据用户要求修改给定块内容。只输出修改后的 Markdown/Kramdown，不要解释，不要包裹代码块。",
      },
      {
        role: "user",
        content: [
          "修改要求：",
          instruction,
          "",
          "原始块内容：",
          original,
        ].join("\n"),
      },
    ];
    this.setLog(root, `生成块 ${blockId} 的修改草稿`);
    const draft = await this.chat(messages);
    this.updateDraft = { blockId, original, draft };
    root.querySelector("[data-kai-update-draft]").value = draft;
    this.setLog(root, "修改草稿已生成，请确认后覆盖");
  }

  async applyBlockUpdate(root) {
    this.ensureWriteAllowed();
    const blockId = root.querySelector("[data-kai-target-block]").value.trim() || (this.updateDraft && this.updateDraft.blockId);
    const draft = root.querySelector("[data-kai-update-draft]").value.trim();
    if (!blockId) throw new Error("没有目标块 ID");
    if (!draft) throw new Error("没有可应用的修改草稿");
    if (!window.confirm(`确认覆盖块 ${blockId}？此操作会修改思源笔记内容。`)) return;
    await this.siyuanPost("/api/block/updateBlock", {
      id: blockId,
      dataType: "markdown",
      data: draft,
    });
    this.setLog(root, `已覆盖块 ${blockId}`);
    showMessage("Knowledge AI：目标块已更新");
  }

  async resolveNotebook() {
    if (this.config.defaultNotebook) return this.config.defaultNotebook;
    const data = await this.siyuanPost("/api/notebook/lsNotebooks", {});
    const first = (data.notebooks || []).find((item) => !item.closed);
    if (!first) throw new Error("请先选择默认笔记本");
    return first.id;
  }

  async getCurrentBlockId() {
    if (typeof getActiveEditor === "function") {
      const editor = getActiveEditor(false);
      const blockId =
        editor &&
        editor.protyle &&
        editor.protyle.block &&
        (editor.protyle.block.id || editor.protyle.block.parentID);
      if (blockId) return blockId;
    }
    const selected = document.querySelector(".layout__wnd--active .protyle-wysiwyg--select[data-node-id]");
    const selectedId = selected && selected.getAttribute("data-node-id");
    if (selectedId) return selectedId;
    const activeTitle = document.querySelector(".layout__wnd--active .protyle-title[data-node-id]");
    const domId = activeTitle && activeTitle.getAttribute("data-node-id");
    return domId || "";
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
