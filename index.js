"use strict";

const siyuan = require("siyuan");
const {
  DEFAULT_CONFIG,
  PROVIDER_PRESETS,
  blockToChunks,
  buildMessages,
  buildModelProxyPayload,
  clampNumber,
  detectProvider,
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
  Menu,
  Plugin,
  fetchSyncPost,
  getActiveEditor,
  getModelByDockType,
  showMessage,
} = siyuan;

const PLUGIN_NAME = "siyuan-knowledge-ai";
const CONFIG_FILE = "config.json";
const API_KEY_STORAGE = `${PLUGIN_NAME}:api-key`;
const DOCK_TYPE = "knowledge-ai-dock";
const CURRENT_INDEX_VERSION = 1;
const INDEX_ROOT = `/data/storage/petal/${PLUGIN_NAME}/index`;

class SiyuanKnowledgeAI extends Plugin {
  async onload() {
    this.config = await this.loadConfig();
    // 多轮对话历史：[{role:"user"|"assistant", content}]
    this.conversation = [];
    // 最近一条助手回答与引用，供消息菜单的写入动作复用
    this.lastAnswer = "";
    this.lastQuestion = "";
    this.lastSources = [];
    this.indexing = false;
    this.indexTimer = null;

    this.addIcons(`
      <symbol id="iconKnowledgeAI" viewBox="0 0 24 24">
        <path d="M12 2.75a2.75 2.75 0 0 1 2.7 2.25h1.55A3.75 3.75 0 0 1 20 8.75v6.5A3.75 3.75 0 0 1 16.25 19h-.52a3.25 3.25 0 0 1-6.46 0h-.52A3.75 3.75 0 0 1 5 15.25v-6.5A3.75 3.75 0 0 1 8.75 5h1.55A2.75 2.75 0 0 1 12 2.75Zm0 1.5a1.25 1.25 0 0 0-1.25 1.25v.25c0 .41-.34.75-.75.75H8.75A2.25 2.25 0 0 0 6.5 8.75v6.5a2.25 2.25 0 0 0 2.25 2.25H10c.41 0 .75.34.75.75a1.25 1.25 0 0 0 2.5 0c0-.41.34-.75.75-.75h2.25a2.25 2.25 0 0 0 2.25-2.25v-6.5a2.25 2.25 0 0 0-2.25-2.25H14c-.41 0-.75-.34-.75-.75V5.5A1.25 1.25 0 0 0 12 4.25Z"/>
        <path d="M9.25 10.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm5.5 0a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z"/>
      </symbol>
    `);

    // dock 必须在同步阶段注册，不能放到 onLayoutReady
    this.registerDock();
    this.createSettingPanel();

    this.addCommand({
      langKey: "openKnowledgeAI",
      hotkey: "",
      callback: () => this.toggleDock(),
    });

    this.startIndexSchedule();
    if (this.config.autoIndexOnStart) {
      window.setTimeout(() => this.buildIndex(null, { silent: true }), 5000);
    }
  }

  onunload() {
    if (this.indexTimer) window.clearInterval(this.indexTimer);
  }

  registerDock() {
    const plugin = this;
    this.addDock({
      config: {
        position: "RightBottom",
        size: { width: 420, height: null },
        icon: "iconKnowledgeAI",
        title: "Knowledge AI",
      },
      data: {},
      type: DOCK_TYPE,
      init() {
        plugin.initDock(this);
      },
      update() {
        plugin.refreshDockHead(this.data && this.data.root);
      },
      destroy() {
        plugin.activeRoots.delete(this.data && this.data.root);
      },
    });
  }

  // 命令入口：聚焦/展开右侧 dock 面板。dock 天然单例，不会重复弹出
  toggleDock() {
    const model = getModelByDockType(DOCK_TYPE);
    if (model && model.data && model.data.root) {
      // dock 已存在，确保其可见（思源内部通过点击图标位展开）
      const iconElement = document.querySelector(`.dock__item[data-type="${DOCK_TYPE}"]`);
      if (iconElement) iconElement.click();
      return;
    }
    const iconElement = document.querySelector(`.dock__item[data-type="${DOCK_TYPE}"]`);
    if (iconElement) iconElement.click();
  }

  initDock(custom) {
    this.activeRoots = this.activeRoots || new Set();
    custom.element.classList.add("kai-dock-host");
    custom.element.innerHTML = this.renderDock();
    const root = custom.element.querySelector(".kai-dock");
    custom.data = Object.assign({}, custom.data || {}, { root });
    this.activeRoots.add(root);
    this.bindDock(root);
    this.refreshDockHead(root);
    this.renderEmpty(root);
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
    this.refreshIndexStatus(root);
  }

  renderSettingsDialog() {
    return `
      <div class="kai-settings-dialog">
        <nav class="kai-settings-tabs" data-kai-settings-tabs>
          <button class="kai-settings-tab kai-settings-tab--active" data-kai-tab="model">模型</button>
          <button class="kai-settings-tab" data-kai-tab="retrieval">检索</button>
          <button class="kai-settings-tab" data-kai-tab="write">写入</button>
          <button class="kai-settings-tab" data-kai-tab="index">索引</button>
        </nav>
        <div class="kai-settings-body">
          <section class="kai-settings-page kai-settings-page--active" data-kai-page="model">
            ${this.renderProviderSelect()}
            ${this.renderSettingField("baseUrl", "接口地址", "OpenAI 或 OpenAI-compatible Base URL。")}
            ${this.renderSettingField("apiKey", "API Key", "本机保存，不写入同步索引；本地 Ollama 可留空。", { password: true, local: true })}
            ${this.renderSettingField("chatModel", "聊天模型", "用于回答、生成草稿和改写笔记。")}
            ${this.renderSettingField("embeddingModel", "Embedding 模型", "用于全库索引和提问检索；换模型后需要重建索引。")}
            ${this.renderSettingField("temperature", "温度", "回答和草稿生成的随机性。", { number: true, step: "0.1", min: "0", max: "2" })}
            ${this.renderSettingField("modelTimeoutMs", "模型超时毫秒", "通过思源代理调用模型接口的超时时间。", { number: true, min: "1000" })}
            ${this.renderSettingField("systemPrompt", "系统提示词", "问答时使用的系统提示词。", { textarea: true })}
          </section>

          <section class="kai-settings-page" data-kai-page="retrieval">
            ${this.renderSettingField("topK", "引用数量", "每次问答最多送入模型的笔记片段数。", { number: true, min: "1", max: "30" })}
            ${this.renderSettingField("maxIndexedBlocks", "索引块上限", "手动更新索引时最多读取多少个思源块。", { number: true, min: "100" })}
            ${this.renderSettingField("chunkSize", "片段长度", "单个索引片段的最大字符数。", { number: true, min: "200" })}
            ${this.renderSettingField("chunkOverlap", "片段重叠", "相邻片段保留的重叠字符数。", { number: true, min: "0" })}
            ${this.renderSettingField("batchSize", "向量批量", "每次 Embedding 请求包含的片段数。", { number: true, min: "1", max: "128" })}
            ${this.renderSettingField("shardSize", "分片大小", "每个同步索引分片保存的片段数。", { number: true, min: "20", max: "500" })}
          </section>

          <section class="kai-settings-page" data-kai-page="write">
            ${this.renderSettingField("defaultNotebook", "默认笔记本 ID", "新增笔记保存到这个笔记本；也可在工作台中读取并选择。")}
            ${this.renderSettingField("defaultPath", "默认保存路径", "新增 AI 笔记的父路径。")}
            ${this.renderSettingField("allowWriteActions", "允许写入笔记", "关闭后只能问答，不能新增、追加或修改笔记。", { checkbox: true })}
          </section>

          <section class="kai-settings-page" data-kai-page="index">
            ${this.renderSettingField("autoIndexOnStart", "启动后定期更新", "启用后按下方间隔自动重建索引。", { checkbox: true })}
            ${this.renderSettingField("autoIndexEveryHours", "自动索引间隔小时", "仅在启用定期更新时生效。", { number: true, min: "1" })}
            <div class="kai-setting-row">
              <span class="kai-setting-copy">
                <span class="kai-setting-title">索引管理</span>
                <span class="kai-setting-desc">全库向量索引，索引分片随思源同步。其他设备同步完成后读取即可。</span>
              </span>
            </div>
            <div class="kai-status" data-kai-index-status>读取中...</div>
            <progress class="kai-progress" data-kai-progress value="0" max="1"></progress>
            <div class="kai-actions kai-actions-index">
              <button class="b3-button" data-kai-settings-action="build-index">更新索引</button>
              <button class="b3-button b3-button--outline" data-kai-settings-action="refresh-index">刷新状态</button>
              <button class="b3-button b3-button--outline" data-kai-settings-action="clear-index">清空索引</button>
            </div>
            <pre class="kai-log" data-kai-log></pre>
          </section>
        </div>
        <div class="kai-settings-actions">
          <button class="b3-button b3-button--cancel" data-kai-settings-cancel>取消</button>
          <button class="b3-button" data-kai-settings-save>保存</button>
        </div>
      </div>
    `;
  }

  // 服务商预设下拉（不写入 config，纯 UI 辅助：选中后自动填 baseUrl/chatModel/embeddingModel）
  renderProviderSelect() {
    const current = detectProvider(this.config.baseUrl);
    const options = PROVIDER_PRESETS.map((p) => {
      const selected = p.id === current ? "selected" : "";
      return `<option value="${escapeHtml(p.id)}" ${selected}>${escapeHtml(p.label)}</option>`;
    }).join("");
    return `
      <label class="kai-setting-row">
        <span class="kai-setting-copy">
          <span class="kai-setting-title">服务商</span>
          <span class="kai-setting-desc">选择预设自动填入地址和模型，也可手动修改。</span>
        </span>
        <select class="b3-select kai-setting-input" data-kai-provider>
          ${options}
          <option value="custom" ${current === "custom" ? "selected" : ""}>自定义</option>
        </select>
      </label>
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
      // Tab 切换
      const tab = event.target.closest("[data-kai-tab]");
      if (tab) {
        const name = tab.getAttribute("data-kai-tab");
        for (const el of root.querySelectorAll("[data-kai-tab]")) {
          el.classList.toggle("kai-settings-tab--active", el === tab);
        }
        for (const page of root.querySelectorAll("[data-kai-page]")) {
          page.classList.toggle("kai-settings-page--active", page.getAttribute("data-kai-page") === name);
        }
        return;
      }
      const cancel = event.target.closest("[data-kai-settings-cancel]");
      const save = event.target.closest("[data-kai-settings-save]");
      const settingsAction = event.target.closest("[data-kai-settings-action]");
      if (settingsAction) {
        event.preventDefault();
        event.stopPropagation();
        const action = settingsAction.getAttribute("data-kai-settings-action");
        try {
          if (action === "build-index") await this.buildIndex(root);
          else if (action === "refresh-index") await this.refreshIndexStatus(root);
          else if (action === "clear-index") await this.clearIndex(root);
        } catch (error) {
          console.error("Knowledge AI settings action failed", error);
          showMessage(`Knowledge AI：${error.message || error}`, 7000, "error");
        }
        return;
      }
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
    // 服务商预设联动：选中预设后自动填入 baseUrl / chatModel / embeddingModel
    const providerSelect = root.querySelector("[data-kai-provider]");
    if (providerSelect) {
      providerSelect.addEventListener("change", () => {
        const id = providerSelect.value;
        const preset = PROVIDER_PRESETS.find((p) => p.id === id);
        if (!preset) return;
        const setField = (key, value) => {
          const input = root.querySelector(`[data-kai-setting-key="${key}"]`);
          if (input) input.value = value;
        };
        setField("baseUrl", preset.baseUrl);
        setField("chatModel", preset.chatModel);
        setField("embeddingModel", preset.embeddingModel);
      });
    }
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
    this.refreshAllDockHeads();
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

  // ===== Dock 面板布局 =====

  renderDock() {
    return `
      <div class="kai-dock">
        <header class="kai-dock-head">
          <div class="kai-brand">
            <svg><use xlink:href="#iconKnowledgeAI"></use></svg>
            <div class="kai-brand-text">
              <div class="kai-title">Knowledge AI</div>
              <div class="kai-muted" data-kai-index-summary>读取索引状态...</div>
            </div>
          </div>
          <button class="b3-button b3-button--outline kai-icon-btn" data-kai-action="open-settings" title="设置">⚙</button>
        </header>

        <div class="kai-messages" data-kai-messages></div>

        <footer class="kai-composer">
          <textarea class="b3-text-field kai-input" data-kai-input placeholder="问你的思源全库笔记，或直接聊天..."></textarea>
          <div class="kai-composer-actions">
            <button class="b3-button b3-button--outline" data-kai-action="clear-conversation" title="清空对话">清空</button>
            <button class="b3-button" data-kai-action="send">发送</button>
          </div>
        </footer>
      </div>
    `;
  }

  bindDock(root) {
    if (!root) return;
    // 回车发送（Shift+Enter 换行）
    const input = root.querySelector("[data-kai-input]");
    if (input) {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          this.ask(root).catch((error) => this.handleAskError(root, error));
        }
      });
    }
    root.addEventListener("click", (event) => {
      const target = event.target.closest(
        "[data-kai-action], [data-kai-open-block], [data-kai-target-source], [data-kai-msg-copy], [data-kai-msg-more]",
      );
      if (!target) return;
      event.preventDefault();

      const action = target.getAttribute("data-kai-action");
      const blockId = target.getAttribute("data-kai-open-block");
      const targetSource = target.getAttribute("data-kai-target-source");
      const msgIndex = Number(target.getAttribute("data-kai-msg-index"));
      Promise.resolve()
        .then(async () => {
          if (blockId) {
            await this.openBlock(blockId);
          } else if (targetSource) {
            this.openUpdateBlockDialog(root, targetSource);
          } else if (target.hasAttribute("data-kai-msg-copy")) {
            await this.copyMessage(root, msgIndex);
          } else if (target.hasAttribute("data-kai-msg-more")) {
            this.openMessageMenu(root, msgIndex, target);
          } else if (action === "send") {
            await this.ask(root);
          } else if (action === "clear-conversation") {
            this.clearConversation(root);
          } else if (action === "open-settings") {
            this.setting.open(this.name);
          }
        })
        .catch((error) => this.handleAskError(root, error));
    });
  }

  handleAskError(root, error) {
    console.error("Knowledge AI action failed", error);
    this.renderMessage(root, "assistant", `⚠️ ${error.message || error}`, []);
    showMessage(`Knowledge AI：${error.message || error}`, 7000, "error");
  }

  renderEmpty(root) {
    const container = root && root.querySelector("[data-kai-messages]");
    if (!container) return;
    container.innerHTML = `<div class="kai-empty-tip">基于全库笔记问答，也可以在没有笔记时直接提问。回答下方有复制、存文档等操作。</div>`;
  }

  refreshDockHead(root) {
    if (!root) return;
    this.refreshIndexStatus(root);
  }

  refreshAllDockHeads() {
    for (const root of this.activeRoots || []) this.refreshDockHead(root);
  }

  // ===== 多轮对话 =====

  async ask(root) {
    const input = root.querySelector("[data-kai-input]");
    const question = (input && input.value.trim()) || "";
    if (!question) throw new Error("请输入问题");
    if (input) {
      input.value = "";
      input.disabled = true;
    }
    const sendButton = root.querySelector('[data-kai-action="send"]');
    if (sendButton) sendButton.disabled = true;

    try {
      // 渲染用户气泡
      this.renderMessage(root, "user", question, []);
      // 记录到历史（用纯文本，不携带引用上下文，引用每次实时检索）
      this.conversation.push({ role: "user", content: question });
      this.lastQuestion = question;

      // 检索全库索引（与是否打开笔记无关）
      let ranked = [];
      try {
        const chunks = await this.loadIndexedChunks();
        const queryEmbedding = (await this.embedTexts([question]))[0];
        ranked = rankChunks(chunks, queryEmbedding, this.config.topK);
      } catch (error) {
        // 索引不可用时降级为纯聊天，不阻断对话
        console.warn("Knowledge AI: retrieval skipped", error);
      }

      // 占位助手气泡，流式感
      const placeholder = this.renderMessage(root, "assistant", "思考中...", []);
      const messages = buildMessages(this.config, question, ranked, this.conversation.slice(0, -1));
      const answer = await this.chat(messages);

      this.conversation.push({ role: "assistant", content: answer });
      this.lastAnswer = answer;
      this.lastSources = ranked;
      this.updateAssistantMessage(placeholder, answer, ranked);
    } finally {
      if (input) input.disabled = false;
      if (sendButton) sendButton.disabled = false;
    }
  }

  clearConversation(root) {
    this.conversation = [];
    this.lastAnswer = "";
    this.lastSources = [];
    this.renderEmpty(root);
  }

  // 渲染一条消息气泡，返回消息容器元素（助手消息供后续更新）
  renderMessage(root, role, content, sources) {
    const container = root && root.querySelector("[data-kai-messages]");
    if (!container) return null;
    // 首次提问时清掉空提示
    const emptyTip = container.querySelector(".kai-empty-tip");
    if (emptyTip) emptyTip.remove();

    const isAssistant = role === "assistant";
    const index = container.querySelectorAll(".kai-msg").length;
    const wrap = document.createElement("div");
    wrap.className = `kai-msg kai-msg-${isAssistant ? "assistant" : "user"}`;
    wrap.setAttribute("data-kai-msg", String(index));

    const bubble = document.createElement("div");
    bubble.className = "kai-bubble";
    bubble.innerHTML = `<pre>${escapeHtml(content)}</pre>`;
    wrap.appendChild(bubble);

    if (isAssistant) {
      // 引用来源（可折叠）
      if (sources && sources.length) {
        wrap.appendChild(this.buildSourcesElement(sources));
      }
      // 操作图标行：复制 + 更多
      const actions = document.createElement("div");
      actions.className = "kai-msg-actions";
      actions.innerHTML = `
        <button class="kai-msg-btn" data-kai-msg-copy data-kai-msg-index="${index}" title="复制">📋 复制</button>
        <button class="kai-msg-btn" data-kai-msg-more data-kai-msg-index="${index}" title="更多操作">⋯ 更多</button>
      `;
      wrap.appendChild(actions);
    }

    container.appendChild(wrap);
    container.scrollTop = container.scrollHeight;
    return wrap;
  }

  updateAssistantMessage(element, answer, sources) {
    if (!element) return;
    const bubble = element.querySelector(".kai-bubble");
    if (bubble) bubble.innerHTML = `<pre>${escapeHtml(answer)}</pre>`;
    // 移除旧的来源与操作行后重建
    const oldSources = element.querySelector(".kai-sources");
    if (oldSources) oldSources.remove();
    if (sources && sources.length) {
      const sourcesEl = this.buildSourcesElement(sources);
      element.insertBefore(sourcesEl, element.querySelector(".kai-msg-actions"));
    }
    const messages = element.closest("[data-kai-messages]");
    if (messages) messages.scrollTop = messages.scrollHeight;
  }

  buildSourcesElement(ranked) {
    const sources = document.createElement("div");
    sources.className = "kai-sources kai-collapsible";
    sources.innerHTML = `
      <div class="kai-sources-toggle" data-kai-sources-toggle>引用来源 (${ranked.length})</div>
      <div class="kai-sources-body">
        ${ranked
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
                    <button class="b3-button b3-button--outline" data-kai-target-source="${escapeHtml(chunk.blockId)}">改写此引用</button>
                  </div>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
    sources.querySelector("[data-kai-sources-toggle]").addEventListener("click", () => {
      sources.classList.toggle("kai-sources-open");
    });
    return sources;
  }

  openMessageMenu(root, index, anchor) {
    const menu = new Menu("kai-msg-menu");
    const message = root.querySelectorAll(".kai-msg")[index];
    // 找到本条助手回答对应的引用来源：优先用 message 内的来源，否则用最近一次
    const sources = this.lastSources;
    menu.addItem({
      iconHTML: "💾",
      label: "回答存为新文档",
      click: () => this.saveAnswerAsDocument(root),
    });
    menu.addItem({
      iconHTML: "➕",
      label: "追加回答到当前文档",
      click: () => this.appendAnswerToCurrentDocument(root),
    });
    menu.addItem({
      iconHTML: "📝",
      label: "生成新笔记",
      click: () => this.openNewNoteDialog(root),
    });
    menu.addItem({
      iconHTML: "✏️",
      label: "改写当前块",
      click: () => this.openUpdateBlockDialog(root),
    });
    const rect = anchor.getBoundingClientRect();
    menu.open({ x: rect.left, y: rect.bottom, w: rect.width, h: rect.height });
  }

  async copyMessage(root, index) {
    const message = root.querySelectorAll(".kai-msg")[index];
    const text = message && message.querySelector(".kai-bubble pre");
    const value = text ? text.textContent : "";
    if (!value) throw new Error("没有可复制的内容");
    await navigator.clipboard.writeText(value);
    showMessage("Knowledge AI：已复制");
  }

  // ===== 索引相关：状态、构建、清空（被 dock 与设置页共用） =====

  setLog(root, text, isError) {
    if (!root) return;
    const log = root.querySelector("[data-kai-log]");
    if (!log) return;
    const line = `[${new Date().toLocaleTimeString()}] ${text}`;
    log.textContent = `${line}\n${log.textContent || ""}`.slice(0, 10000);
    log.classList.toggle("kai-log-error", Boolean(isError));
  }

  setIndexStatus(root, text) {
    const status = root && root.querySelector("[data-kai-index-status]");
    if (status) status.textContent = text;
    const summary = root && root.querySelector("[data-kai-index-summary]");
    if (summary) summary.textContent = text;
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
      `${manifest.chunkCount || 0} 片段 / ${shardCount} 分片 / ${manifest.embeddingModel || ""}`,
    );
    this.setProgress(root, manifest.chunkCount || shardCount || 1, manifest.chunkCount || shardCount || 1);
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
      throw new Error("索引不存在，请先在设置中更新索引并等待思源同步");
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

  async openBlock(blockId) {
    try {
      await this.openDoc(blockId);
    } catch (error) {
      const rows = await this.siyuanPost("/api/query/sql", {
        stmt: `SELECT id, root_id, type FROM blocks WHERE id='${escapeSql(blockId)}' LIMIT 1`,
      });
      const row = rows && rows[0];
      const docId = row && row.type === "d" ? row.id : row && row.root_id ? row.root_id : blockId;
      await this.openDoc(docId);
    }
  }

  openDoc(blockId) {
    const siyuanNS = require("siyuan");
    return siyuanNS.openTab({
      app: this.app,
      doc: {
        id: blockId,
        action: ["cb-get-focus", "cb-get-hl"],
      },
      keepCursor: false,
      removeCurrentTab: false,
    });
  }

  // ===== 写入动作（从主区按钮移到消息菜单，逻辑不变） =====

  async copyAnswer(root) {
    if (!this.lastAnswer) throw new Error("没有可复制的回答");
    await navigator.clipboard.writeText(this.lastAnswer);
    showMessage("Knowledge AI：回答已复制");
  }

  ensureWriteAllowed() {
    if (!this.config.allowWriteActions) throw new Error("插件设置中已关闭写入笔记能力");
  }

  async saveAnswerAsDocument(root) {
    this.ensureWriteAllowed();
    if (!this.lastAnswer) throw new Error("没有可保存的回答");
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

  openNewNoteDialog(logRoot) {
    const dialog = new Dialog({
      title: "生成新笔记",
      content: this.renderNewNoteDialog(),
      width: "min(760px, 92vw)",
      height: "min(680px, 86vh)",
    });
    const root = dialog.element.querySelector(".kai-compose-dialog");
    this.bindNewNoteDialog(root, dialog, logRoot);
  }

  renderNewNoteDialog() {
    return `
      <div class="kai-compose-dialog">
        <div class="kai-compose-body">
          <div class="kai-grid">
            <label>标题
              <input class="b3-text-field kai-input" data-kai-new-note-title value="AI 笔记">
            </label>
            <label>保存路径
              <input class="b3-text-field kai-input" data-kai-new-note-path value="${escapeHtml(this.config.defaultPath)}">
            </label>
          </div>
          <label>要求
            <textarea class="b3-text-field kai-prompt" data-kai-new-note-prompt placeholder="描述要新增的笔记，例如：根据刚才回答整理成一份运维检查清单。"></textarea>
          </label>
          <label>草稿
            <textarea class="b3-text-field kai-draft" data-kai-new-note-draft placeholder="先生成草稿，确认后再创建新文档。"></textarea>
          </label>
        </div>
        <div class="kai-compose-actions">
          <button class="b3-button b3-button--cancel" data-kai-dialog-action="cancel">取消</button>
          <button class="b3-button b3-button--outline" data-kai-dialog-action="draft-note">生成草稿</button>
          <button class="b3-button" data-kai-dialog-action="create-note">创建新文档</button>
        </div>
      </div>
    `;
  }

  bindNewNoteDialog(root, dialog, logRoot) {
    if (!root) return;
    root.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-kai-dialog-action]");
      if (!button) return;
      event.preventDefault();
      const action = button.getAttribute("data-kai-dialog-action");
      if (action === "cancel") {
        dialog.destroy();
        return;
      }
      await this.runDialogAction(button, async () => {
        if (action === "draft-note") {
          await this.draftNewNote(root, logRoot);
        } else if (action === "create-note") {
          const created = await this.createDraftNote(root, logRoot);
          if (created) dialog.destroy();
        }
      });
    });
  }

  openUpdateBlockDialog(logRoot, blockId) {
    const dialog = new Dialog({
      title: "改写笔记块",
      content: this.renderUpdateBlockDialog(blockId),
      width: "min(760px, 92vw)",
      height: "min(700px, 86vh)",
    });
    const root = dialog.element.querySelector(".kai-compose-dialog");
    this.bindUpdateBlockDialog(root, dialog, logRoot);
  }

  renderUpdateBlockDialog(blockId) {
    return `
      <div class="kai-compose-dialog">
        <div class="kai-compose-body">
          <div class="kai-grid kai-target-grid">
            <label>目标块 ID
              <input class="b3-text-field kai-input" data-kai-target-block value="${escapeHtml(blockId || "")}" placeholder="可从引用来源进入，也可使用当前块">
            </label>
            <label>操作
              <button class="b3-button b3-button--outline kai-inline-button" data-kai-dialog-action="use-current-block">使用当前块</button>
            </label>
          </div>
          <label>修改要求
            <textarea class="b3-text-field kai-prompt" data-kai-update-instruction placeholder="说明要怎么修改，例如：整理成正式周报格式，保留事实，不要删减关键信息。"></textarea>
          </label>
          <label>修改草稿
            <textarea class="b3-text-field kai-draft" data-kai-update-draft placeholder="先生成修改草稿，确认后再覆盖目标块。"></textarea>
          </label>
        </div>
        <div class="kai-compose-actions">
          <button class="b3-button b3-button--cancel" data-kai-dialog-action="cancel">取消</button>
          <button class="b3-button b3-button--outline" data-kai-dialog-action="draft-update">生成草稿</button>
          <button class="b3-button" data-kai-dialog-action="apply-update">覆盖目标块</button>
        </div>
      </div>
    `;
  }

  bindUpdateBlockDialog(root, dialog, logRoot) {
    if (!root) return;
    root.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-kai-dialog-action]");
      if (!button) return;
      event.preventDefault();
      const action = button.getAttribute("data-kai-dialog-action");
      if (action === "cancel") {
        dialog.destroy();
        return;
      }
      await this.runDialogAction(button, async () => {
        if (action === "use-current-block") {
          await this.useCurrentBlock(root, logRoot);
        } else if (action === "draft-update") {
          await this.draftBlockUpdate(root, logRoot);
        } else if (action === "apply-update") {
          const updated = await this.applyBlockUpdate(root, logRoot);
          if (updated) dialog.destroy();
        }
      });
    });
  }

  async runDialogAction(button, callback) {
    const previousDisabled = button.disabled;
    button.disabled = true;
    try {
      await callback();
    } catch (error) {
      console.error("Knowledge AI dialog action failed", error);
      showMessage(`Knowledge AI：${error.message || error}`, 7000, "error");
    } finally {
      button.disabled = previousDisabled;
    }
  }

  async draftNewNote(formRoot, logRoot) {
    const title = formRoot.querySelector("[data-kai-new-note-title]").value.trim() || "AI 笔记";
    const prompt = formRoot.querySelector("[data-kai-new-note-prompt]").value.trim();
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
    this.setLog(logRoot || formRoot, "生成新笔记草稿");
    const draft = await this.chat(messages);
    this.noteDraft = draft;
    formRoot.querySelector("[data-kai-new-note-draft]").value = draft;
    this.setLog(logRoot || formRoot, "新笔记草稿已生成，请确认后创建");
  }

  async createDraftNote(formRoot, logRoot) {
    this.ensureWriteAllowed();
    const notebook = await this.resolveNotebook();
    const title = formRoot.querySelector("[data-kai-new-note-title]").value.trim() || "AI 笔记";
    const directory = normalizeDocPath(formRoot.querySelector("[data-kai-new-note-path]").value || this.config.defaultPath);
    const draft = formRoot.querySelector("[data-kai-new-note-draft]").value.trim();
    if (!draft) throw new Error("没有可创建的新笔记草稿");
    const path = `${directory}/${safePathSegment(title)}`;
    if (!window.confirm(`创建新文档：${path}`)) return false;
    const id = await this.siyuanPost("/api/filetree/createDocWithMd", {
      notebook,
      path,
      markdown: `# ${title}\n\n${draft}`,
    });
    this.setLog(logRoot || formRoot, `已创建新笔记 ${id || path}`);
    showMessage("Knowledge AI：新笔记已创建");
    return true;
  }

  setTargetBlock(formRoot, blockId, logRoot) {
    const input = formRoot.querySelector("[data-kai-target-block]");
    if (input) input.value = blockId;
    this.setLog(logRoot || formRoot, `修改目标已设置为 ${blockId}`);
  }

  async useCurrentBlock(formRoot, logRoot) {
    const blockId = await this.getCurrentBlockId();
    if (!blockId) throw new Error("没有找到当前块");
    this.setTargetBlock(formRoot, blockId, logRoot);
  }

  async draftBlockUpdate(formRoot, logRoot) {
    const input = formRoot.querySelector("[data-kai-target-block]");
    const blockId = (input && input.value.trim()) || (await this.getCurrentBlockId());
    if (!blockId) throw new Error("请输入目标块 ID，或先打开一个文档");
    const instruction = formRoot.querySelector("[data-kai-update-instruction]").value.trim();
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
        content: ["修改要求：", instruction, "", "原始块内容：", original].join("\n"),
      },
    ];
    this.setLog(logRoot || formRoot, `生成块 ${blockId} 的修改草稿`);
    const draft = await this.chat(messages);
    this.updateDraft = { blockId, original, draft };
    formRoot.querySelector("[data-kai-update-draft]").value = draft;
    this.setLog(logRoot || formRoot, "修改草稿已生成，请确认后覆盖");
  }

  async applyBlockUpdate(formRoot, logRoot) {
    this.ensureWriteAllowed();
    const blockId = formRoot.querySelector("[data-kai-target-block]").value.trim() || (this.updateDraft && this.updateDraft.blockId);
    const draft = formRoot.querySelector("[data-kai-update-draft]").value.trim();
    if (!blockId) throw new Error("没有目标块 ID");
    if (!draft) throw new Error("没有可应用的修改草稿");
    if (!window.confirm(`确认覆盖块 ${blockId}？此操作会修改思源笔记内容。`)) return false;
    await this.siyuanPost("/api/block/updateBlock", {
      id: blockId,
      dataType: "markdown",
      data: draft,
    });
    this.setLog(logRoot || formRoot, `已覆盖块 ${blockId}`);
    showMessage("Knowledge AI：目标块已更新");
    return true;
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
