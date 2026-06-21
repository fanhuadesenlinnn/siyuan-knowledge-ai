"use strict";

const siyuan = require("siyuan");
const {
  DEFAULT_CONFIG,
  INDEX_SCHEMA_VERSION,
  PROXY_MODE_OPTIONS,
  PROVIDER_PRESETS,
  applyUnitSummary,
  buildDailyTopicUnits,
  buildGatewayProxyPayload,
  buildKnowledgeUnits,
  buildMessages,
  buildModelProxyPayload,
  buildTimelineContext,
  buildModelRequestHeaders,
  clampNumber,
  computeNotebookQuotas,
  countEmbeddedUnits,
  detectProvider,
  escapeHtml,
  escapeSql,
  extractChatContent,
  extractEmbeddings,
  getIndexManifestError,
  getModelRequestRoutes,
  isFallbackAllowed,
  makeDefaultProfile,
  makeManifestPath,
  makeShardPath,
  markModelRouteError,
  mergeConfig,
  mergeLegacyApiKey,
  modelRouteLabel,
  groupDailyRowsByDate,
  normalizeApiKeys,
  normalizeBaseUrl,
  normalizeDailyNotePath,
  normalizeModelBaseUrlForRequest,
  normalizeProxyMode,
  nowIso,
  parseDailyTopicResponse,
  parseModelProxyJson,
  parseTimeRange,
  rankChunks,
  stableHash,
} = require("./lib/core");

const {
  Dialog,
  Lute,
  Plugin,
  fetchSyncPost,
  getActiveEditor,
  getModelByDockType,
  showMessage,
} = siyuan;

const PLUGIN_NAME = "siyuan-knowledge-ai";
const CONFIG_FILE = "config.json";
const API_KEY_STORAGE = `${PLUGIN_NAME}:api-key`; // 旧版单一全局 key（仅做迁移来源；新版保存后清理）
const API_KEYS_STORAGE = `${PLUGIN_NAME}:api-keys`; // 密钥库：{ [profileId]: "sk-..." }
const DOCK_TYPE = "knowledge-ai-dock";
const CURRENT_INDEX_VERSION = INDEX_SCHEMA_VERSION;
const MAX_EMBEDDING_BATCH_SIZE = 100;
const GEMINI_INDEX_BATCH_DELAY_MS = 800;
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
    this.indexAbortController = null;
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
      width: "min(820px, 94vw)",
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
            ${this.renderProfileRoleSelect("indexingProfileId", "索引配置", "用于更新索引、提问向量化和读取索引一致性校验。")}
            ${this.renderProfileRoleSelect("chatProfileId", "问答配置", "用于日常回答、生成草稿和改写笔记。")}
            ${this.renderProfileEditor()}
            ${this.renderSettingField("systemPrompt", "系统提示词", "问答时使用的系统提示词。", { textarea: true })}
            <div class="kai-setting-row">
              <span class="kai-setting-copy">
                <span class="kai-setting-title">连接测试</span>
                <span class="kai-setting-desc">使用当前表单内容测试问答配置或索引配置，不需要先保存。</span>
              </span>
              <div class="kai-actions kai-actions-model">
                <button class="b3-button b3-button--outline" data-kai-settings-action="test-chat">测试问答</button>
                <button class="b3-button b3-button--outline" data-kai-settings-action="test-embedding">测试索引向量</button>
              </div>
            </div>
            <div class="kai-status" data-kai-model-status>尚未测试。</div>
          </section>

          <section class="kai-settings-page" data-kai-page="retrieval">
            ${this.renderSettingField("topK", "引用数量", "每次问答最多送入模型的知识单元数；越大越慢，也更容易消耗模型上下文。", { number: true, min: "1", max: "120" })}
            ${this.renderSettingField("maxIndexedBlocks", "索引块上限", "更新索引时最多读取多少个思源块。建议 ≥ 全库块数以全量索引；不足时按笔记本配额采样，保证每个笔记本都有内容进入。", { number: true, min: "100" })}
            ${this.renderSettingField("chunkSize", "知识单元长度", "块 fallback 与章节上下文的基础字符长度。", { number: true, min: "200" })}
            ${this.renderSettingField("chunkOverlap", "长块重叠", "长块切分时相邻块单元保留的重叠字符数。", { number: true, min: "0" })}
            ${this.renderSettingField("batchSize", "向量批量", "每次 Embedding 请求包含的知识单元数；Gemini 索引会自动使用 100 一批并节流。", { number: true, min: "1", max: String(MAX_EMBEDDING_BATCH_SIZE) })}
            ${this.renderSettingField("shardSize", "分片大小", "每个同步索引分片保存的知识单元数。", { number: true, min: "20", max: "500" })}
            ${this.renderSettingField("dailyNotePath", "日记路径", "用于时间轴检索和日记 AI 分类的 daily note 根路径。")}
            ${this.renderSettingField("enableDailyAiTopics", "日记 AI 主题分类", "点击“更新索引+摘要”时，为变化过的日记生成主题单元；普通更新索引不会调用聊天模型。", { checkbox: true })}
            ${this.renderSettingField("dailyAiTopicMaxDays", "日记 AI 分类天数", "每次“更新索引+摘要”最多为多少个变化过的日记日期生成主题，优先处理较新的日期。", { number: true, min: "1", max: "1000" })}
          </section>

          <section class="kai-settings-page" data-kai-page="write">
            ${this.renderSettingField("defaultNotebook", "默认笔记本 ID", "新增笔记保存到这个笔记本；也可在工作台中读取并选择。")}
            ${this.renderSettingField("defaultPath", "默认保存路径", "新增 AI 笔记的父路径。")}
            ${this.renderSettingField("allowWriteActions", "允许写入笔记", "关闭后只能问答，不能新增、追加或修改笔记。", { checkbox: true })}
          </section>

          <section class="kai-settings-page" data-kai-page="index">
            ${this.renderSettingField("autoIndexOnStart", "启动后定期更新", "启用后按下方间隔自动重建索引。", { checkbox: true })}
            ${this.renderSettingField("autoIndexEveryHours", "自动索引间隔小时", "仅在启用定期更新时生效。", { number: true, min: "1" })}
            <div class="kai-setting-row kai-setting-row-check">
              <span class="kai-setting-copy">
                <span class="kai-setting-title">结构化索引</span>
                <span class="kai-setting-desc">固定开启：块、章节、文档、笔记本、全库多层知识单元。</span>
              </span>
              <span class="kai-pill">已开启</span>
            </div>
            <div class="kai-setting-row">
              <span class="kai-setting-copy">
                <span class="kai-setting-title">AI 主题摘要</span>
                <span class="kai-setting-desc">普通更新索引不会生成摘要；只有点击“更新索引+摘要”时才会调用聊天模型。</span>
              </span>
            </div>
            ${this.renderSettingField("aiSummaryMaxUnits", "AI 摘要上限", "只给前 N 个章节、文档、笔记本等主题单元生成摘要；本地聊天模型较慢时建议设为 10-30。", { number: true, min: "1", max: "1000" })}
            <div class="kai-setting-row">
              <span class="kai-setting-copy">
                <span class="kai-setting-title">索引管理</span>
                <span class="kai-setting-desc">v3 结构化记忆索引，索引分片随思源同步。其他设备同步完成后读取即可。</span>
              </span>
            </div>
            <div class="kai-status" data-kai-index-status>读取中...</div>
            <progress class="kai-progress" data-kai-progress value="0" max="1"></progress>
            <div class="kai-actions kai-actions-index">
              <button class="b3-button" data-kai-settings-action="build-index">更新索引</button>
              <button class="b3-button b3-button--outline" data-kai-settings-action="build-index-with-summaries">更新索引+摘要</button>
              <button class="b3-button b3-button--cancel" data-kai-settings-action="cancel-index" data-kai-cancel-index hidden>停止索引</button>
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

  profileOptionsHtml(profiles, selectedId) {
    return (profiles || [])
      .map((profile) => {
        const selected = profile.id === selectedId ? "selected" : "";
        return `<option value="${escapeHtml(profile.id)}" ${selected}>${escapeHtml(profile.name || profile.id)}</option>`;
      })
      .join("");
  }

  renderProfileRoleSelect(key, title, description) {
    const profiles = this.config.profiles || [];
    return `
      <label class="kai-setting-row">
        <span class="kai-setting-copy">
          <span class="kai-setting-title">${escapeHtml(title)}</span>
          <span class="kai-setting-desc">${escapeHtml(description)}</span>
        </span>
        <select class="b3-select kai-setting-input" data-kai-setting-key="${escapeHtml(key)}" data-kai-profile-role="${escapeHtml(key)}">
          ${this.profileOptionsHtml(profiles, this.config[key])}
        </select>
      </label>
    `;
  }

  renderProfileEditor() {
    const profile = this.getProfile(this.config.chatProfileId) || this.getProfile(this.config.indexingProfileId) || makeDefaultProfile();
    return `
      <div class="kai-profile-editor">
        <div class="kai-setting-row kai-profile-toolbar">
          <span class="kai-setting-copy">
            <span class="kai-setting-title">编辑模型配置</span>
            <span class="kai-setting-desc">选择当前要编辑的服务商配置。</span>
          </span>
          <div class="kai-profile-tools">
            <select class="b3-select kai-setting-input" data-kai-active-profile>
              ${this.profileOptionsHtml(this.config.profiles || [], profile.id)}
            </select>
            <button class="b3-button b3-button--outline" data-kai-profile-action="add">新增</button>
            <button class="b3-button b3-button--outline" data-kai-profile-action="remove">删除</button>
          </div>
        </div>
        ${this.renderProfileField("name", "配置名称", "例如 OpenAI、Gemini、Ollama 本地。", profile)}
        ${this.renderProviderSelect(profile)}
        ${this.renderProfileField("baseUrl", "接口地址", "OpenAI 或 OpenAI-compatible Base URL。", profile)}
        ${this.renderProfileField("apiKey", "API Key", "按当前模型配置独立保存在本机；本地 Ollama 可留空。", profile, { password: true, local: true })}
        ${this.renderProfileField("chatModel", "聊天模型", "用于该配置的回答、摘要和草稿生成。", profile)}
        ${this.renderProfileField("embeddingModel", "Embedding 模型", "用于该配置的索引和检索；换模型后需要重建索引。", profile)}
        ${this.renderProfileField("temperature", "温度", "回答和草稿生成的随机性。", profile, { number: true, step: "0.1", min: "0", max: "2" })}
        ${this.renderProfileField("modelTimeoutMs", "模型超时毫秒", "模型接口请求超时时间。", profile, { number: true, min: "1000" })}
        ${this.renderProfileField("proxyMode", "AI 请求代理", "仅影响聊天和 Embedding 请求；本地模型自动绕过代理。", profile, { select: PROXY_MODE_OPTIONS })}
        ${this.renderProfileField("proxyGatewayUrl", "转发网关 URL", "gateway 模式使用。网关接收与思源 forwardProxy 相同的 JSON payload。", profile, { rowAttrs: "data-kai-profile-proxy-gateway-row" })}
        ${this.renderProfileField("proxyFallback", "允许代理回退", "系统代理优先模式下，网络/CORS/超时失败时回退到思源转发。", profile, { checkbox: true })}
      </div>
    `;
  }

  // 服务商预设下拉（不写入 config，纯 UI 辅助：选中后自动填 baseUrl/chatModel/embeddingModel）
  renderProviderSelect(profile) {
    const current = detectProvider(profile && profile.baseUrl);
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

  renderProfileField(key, title, description, profile, options) {
    const settingOptions = options || {};
    const local = settingOptions.local ? ` data-kai-profile-local="true"` : "";
    const value = settingOptions.local ? this.getApiKey(profile && profile.id) : profile && profile[key];
    const common = `data-kai-profile-field="${escapeHtml(key)}"${local}`;
    let control = "";
    if (settingOptions.checkbox) {
      control = `<input class="b3-switch fn__flex-shrink" type="checkbox" ${common} ${value ? "checked" : ""}>`;
    } else if (settingOptions.select) {
      const optionsHtml = settingOptions.select
        .map((item) => {
          const selected = item.id === value ? "selected" : "";
          return `<option value="${escapeHtml(item.id)}" ${selected}>${escapeHtml(item.label)}</option>`;
        })
        .join("");
      control = `<select class="b3-select kai-setting-input" ${common}>${optionsHtml}</select>`;
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
    const rowAttrs = settingOptions.rowAttrs ? ` ${settingOptions.rowAttrs}` : "";
    return `
      <label class="kai-setting-row ${settingOptions.checkbox ? "kai-setting-row-check" : ""}"${rowAttrs}>
        <span class="kai-setting-copy">
          <span class="kai-setting-title">${escapeHtml(title)}</span>
          <span class="kai-setting-desc">${escapeHtml(description)}</span>
        </span>
        ${control}
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
    } else if (settingOptions.select) {
      const optionsHtml = settingOptions.select
        .map((item) => {
          const selected = item.id === value ? "selected" : "";
          return `<option value="${escapeHtml(item.id)}" ${selected}>${escapeHtml(item.label)}</option>`;
        })
        .join("");
      control = `<select class="b3-select kai-setting-input" ${common}>${optionsHtml}</select>`;
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
    const rowAttrs = settingOptions.rowAttrs ? ` ${settingOptions.rowAttrs}` : "";
    return `
      <label class="kai-setting-row ${settingOptions.checkbox ? "kai-setting-row-check" : ""}"${rowAttrs}>
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
    this.initSettingsDraft(root);
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
      const profileAction = event.target.closest("[data-kai-profile-action]");
      const settingsAction = event.target.closest("[data-kai-settings-action]");
      if (profileAction) {
        event.preventDefault();
        event.stopPropagation();
        const action = profileAction.getAttribute("data-kai-profile-action");
        if (action === "add") this.addProfileDraft(root);
        else if (action === "remove") this.removeProfileDraft(root);
        return;
      }
      if (settingsAction) {
        event.preventDefault();
        event.stopPropagation();
        const action = settingsAction.getAttribute("data-kai-settings-action");
        if (action === "cancel-index") {
          this.cancelIndex(root);
          return;
        }
        await this.runSettingsAction(settingsAction, async () => {
          if (action === "build-index") await this.buildIndex(root, { includeAiSummaries: false });
          else if (action === "build-index-with-summaries") await this.buildIndex(root, { includeAiSummaries: true });
          else if (action === "refresh-index") await this.refreshIndexStatus(root);
          else if (action === "clear-index") await this.clearIndex(root);
          else if (action === "test-chat") await this.testChatConnection(root);
          else if (action === "test-embedding") await this.testEmbeddingConnection(root);
        });
        return;
      }
      if (!cancel && !save) return;
      event.preventDefault();
      event.stopPropagation();
      if (cancel) {
        if (this.indexing) this.cancelIndex(root);
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
    const activeProfileSelect = root.querySelector("[data-kai-active-profile]");
    if (activeProfileSelect) {
      activeProfileSelect.addEventListener("change", () => {
        this.collectProfileDraft(root);
        this.fillProfileForm(root, activeProfileSelect.value);
      });
    }
    // 服务商预设联动：选中预设后自动填入 baseUrl / chatModel / embeddingModel
    const providerSelect = root.querySelector("[data-kai-provider]");
    if (providerSelect) {
      providerSelect.addEventListener("change", () => {
        const id = providerSelect.value;
        const preset = PROVIDER_PRESETS.find((p) => p.id === id);
        if (!preset) return;
        const setField = (key, value) => {
          const input = root.querySelector(`[data-kai-profile-field="${key}"]`);
          if (input) input.value = value;
        };
        setField("baseUrl", preset.baseUrl);
        setField("chatModel", preset.chatModel);
        setField("embeddingModel", preset.embeddingModel);
      });
    }
    const proxyModeSelect = root.querySelector('[data-kai-profile-field="proxyMode"]');
    const refreshProxyGatewayVisibility = () => {
      const row = root.querySelector("[data-kai-profile-proxy-gateway-row]");
      if (row) row.hidden = !proxyModeSelect || proxyModeSelect.value !== "gateway";
    };
    if (proxyModeSelect) {
      proxyModeSelect.addEventListener("change", refreshProxyGatewayVisibility);
      refreshProxyGatewayVisibility();
    }
  }

  cloneConfig(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }

  initSettingsDraft(root) {
    root._kaiDraftConfig = this.normalizeConfig(this.cloneConfig(this.config));
    root._kaiDraftApiKeys = this.getApiKeys();
    const active = this.getProfile(root._kaiDraftConfig.chatProfileId, root._kaiDraftConfig)
      || this.getProfile(root._kaiDraftConfig.indexingProfileId, root._kaiDraftConfig);
    root._kaiActiveProfileId = active ? active.id : "default";
  }

  collectProfileDraft(root) {
    const draft = root._kaiDraftConfig || this.normalizeConfig(this.cloneConfig(this.config));
    const apiKeys = root._kaiDraftApiKeys || this.getApiKeys();
    const activeSelect = root.querySelector("[data-kai-active-profile]");
    const activeId = root._kaiActiveProfileId || (activeSelect && activeSelect.value) || draft.chatProfileId || draft.indexingProfileId;
    const profile = this.getProfile(activeId, draft);
    if (!profile) return;
    for (const element of root.querySelectorAll("[data-kai-profile-field]")) {
      const key = element.getAttribute("data-kai-profile-field");
      if (element.dataset.kaiProfileLocal === "true") {
        apiKeys[profile.id] = String(element.value || "").trim();
      } else if (element.type === "checkbox") {
        profile[key] = element.checked;
      } else if (element.type === "number") {
        profile[key] = Number(element.value);
      } else {
        profile[key] = element.value;
      }
    }
    for (const element of root.querySelectorAll("[data-kai-setting-key]")) {
      const key = element.getAttribute("data-kai-setting-key");
      if (element.type === "checkbox") {
        draft[key] = element.checked;
      } else if (element.type === "number") {
        draft[key] = Number(element.value);
      } else {
        draft[key] = element.value;
      }
    }
    root._kaiDraftConfig = this.normalizeConfig(draft);
    root._kaiDraftApiKeys = apiKeys;
    root._kaiActiveProfileId = this.getProfile(profile.id, root._kaiDraftConfig).id;
  }

  fillProfileForm(root, profileId) {
    const draft = root._kaiDraftConfig || this.normalizeConfig(this.cloneConfig(this.config));
    const apiKeys = root._kaiDraftApiKeys || this.getApiKeys();
    const profile = this.getProfile(profileId, draft) || this.getProfile(draft.chatProfileId, draft);
    if (!profile) return;
    root._kaiActiveProfileId = profile.id;
    const activeSelect = root.querySelector("[data-kai-active-profile]");
    if (activeSelect) activeSelect.value = profile.id;
    const providerSelect = root.querySelector("[data-kai-provider]");
    if (providerSelect) providerSelect.value = detectProvider(profile.baseUrl);
    for (const element of root.querySelectorAll("[data-kai-profile-field]")) {
      const key = element.getAttribute("data-kai-profile-field");
      if (element.dataset.kaiProfileLocal === "true") {
        element.value = apiKeys[profile.id] || "";
      } else if (element.type === "checkbox") {
        element.checked = Boolean(profile[key]);
      } else {
        element.value = profile[key] == null ? "" : profile[key];
      }
    }
    this.refreshProfileSelectorOptions(root);
    this.refreshProfileProxyGatewayVisibility(root);
  }

  refreshProfileSelectorOptions(root) {
    const draft = root._kaiDraftConfig || this.config;
    const profiles = draft.profiles || [];
    const activeSelect = root.querySelector("[data-kai-active-profile]");
    if (activeSelect) {
      const selected = root._kaiActiveProfileId || activeSelect.value;
      activeSelect.innerHTML = this.profileOptionsHtml(profiles, selected);
      activeSelect.value = selected;
    }
    for (const select of root.querySelectorAll("[data-kai-profile-role]")) {
      const key = select.getAttribute("data-kai-profile-role");
      const selected = draft[key] || (profiles[0] && profiles[0].id) || "";
      select.innerHTML = this.profileOptionsHtml(profiles, selected);
      select.value = selected;
    }
  }

  refreshProfileProxyGatewayVisibility(root) {
    const proxyModeSelect = root.querySelector('[data-kai-profile-field="proxyMode"]');
    const row = root.querySelector("[data-kai-profile-proxy-gateway-row]");
    if (row) row.hidden = !proxyModeSelect || proxyModeSelect.value !== "gateway";
  }

  addProfileDraft(root) {
    this.collectProfileDraft(root);
    const draft = root._kaiDraftConfig;
    const profiles = draft.profiles || [];
    const used = new Set(profiles.map((profile) => profile.id));
    let index = profiles.length + 1;
    let id = `profile-${index}`;
    while (used.has(id)) {
      index += 1;
      id = `profile-${index}`;
    }
    const current = this.getProfile(root._kaiActiveProfileId, draft) || makeDefaultProfile();
    const next = makeDefaultProfile(Object.assign({}, current, {
      id,
      name: `配置 ${index}`,
    }));
    profiles.push(next);
    draft.profiles = profiles;
    root._kaiDraftConfig = this.normalizeConfig(draft);
    root._kaiActiveProfileId = id;
    this.fillProfileForm(root, id);
  }

  removeProfileDraft(root) {
    this.collectProfileDraft(root);
    const draft = root._kaiDraftConfig;
    const profiles = draft.profiles || [];
    if (profiles.length <= 1) {
      showMessage("Knowledge AI：至少保留一个模型配置", 4000, "error");
      return;
    }
    const activeId = root._kaiActiveProfileId;
    const nextProfiles = profiles.filter((profile) => profile.id !== activeId);
    const nextId = (nextProfiles[0] && nextProfiles[0].id) || "";
    draft.profiles = nextProfiles;
    if (draft.indexingProfileId === activeId) draft.indexingProfileId = nextId;
    if (draft.chatProfileId === activeId) draft.chatProfileId = nextId;
    if (root._kaiDraftApiKeys) delete root._kaiDraftApiKeys[activeId];
    root._kaiDraftConfig = this.normalizeConfig(draft);
    root._kaiActiveProfileId = nextId;
    this.fillProfileForm(root, nextId);
  }

  async saveSettingsFromDialog(root) {
    const draft = this.readSettingsDraft(root);
    this.setApiKeys(draft.apiKeys);
    await this.saveConfig(draft.config);
    this.refreshAllDockHeads();
    showMessage("Knowledge AI：设置已保存");
  }

  readSettingsDraft(root) {
    this.collectProfileDraft(root);
    const next = Object.assign({}, root._kaiDraftConfig || this.config);
    for (const element of root.querySelectorAll("[data-kai-setting-key]")) {
      const key = element.getAttribute("data-kai-setting-key");
      if (element.type === "checkbox") {
        next[key] = element.checked;
      } else if (element.type === "number") {
        next[key] = Number(element.value);
      } else {
        next[key] = element.value;
      }
    }
    return {
      config: this.normalizeConfig(next),
      apiKeys: root._kaiDraftApiKeys || this.getApiKeys(),
    };
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
    const merged = this.normalizeConfig(nextConfig);
    this.config = merged;
    await this.saveData(CONFIG_FILE, merged);
    this.startIndexSchedule();
  }

  normalizeConfig(nextConfig) {
    const merged = mergeConfig(nextConfig);
    merged.profiles = (merged.profiles || []).map((profile) => {
      const next = makeDefaultProfile(profile);
      next.baseUrl = normalizeModelBaseUrlForRequest(next.baseUrl);
      next.proxyMode = normalizeProxyMode(next.proxyMode);
      next.proxyGatewayUrl = String(next.proxyGatewayUrl || "").trim().replace(/\/+$/, "");
      next.proxyFallback = next.proxyFallback !== false;
      next.temperature = clampNumber(next.temperature, 0, 2, DEFAULT_CONFIG.temperature);
      next.modelTimeoutMs = clampNumber(next.modelTimeoutMs, 1000, 10 * 60 * 1000, DEFAULT_CONFIG.modelTimeoutMs);
      next.chatModel = String(next.chatModel || DEFAULT_CONFIG.chatModel).trim();
      next.embeddingModel = String(next.embeddingModel || DEFAULT_CONFIG.embeddingModel).trim();
      next.name = String(next.name || next.id || "默认").trim();
      return next;
    });
    const hasProfile = (id) => merged.profiles.some((profile) => profile.id === id);
    const firstProfileId = merged.profiles[0] ? merged.profiles[0].id : "";
    if (!hasProfile(merged.indexingProfileId)) merged.indexingProfileId = firstProfileId;
    if (!hasProfile(merged.chatProfileId)) merged.chatProfileId = firstProfileId;
    merged.temperature = clampNumber(merged.temperature, 0, 2, DEFAULT_CONFIG.temperature);
    merged.topK = clampNumber(merged.topK, 1, 120, DEFAULT_CONFIG.topK);
    merged.maxIndexedBlocks = clampNumber(
      merged.maxIndexedBlocks,
      100,
      100000,
      DEFAULT_CONFIG.maxIndexedBlocks,
    );
    merged.chunkSize = clampNumber(merged.chunkSize, 200, 4000, DEFAULT_CONFIG.chunkSize);
    merged.chunkOverlap = clampNumber(merged.chunkOverlap, 0, Math.floor(merged.chunkSize / 2), DEFAULT_CONFIG.chunkOverlap);
    merged.batchSize = clampNumber(merged.batchSize, 1, MAX_EMBEDDING_BATCH_SIZE, DEFAULT_CONFIG.batchSize);
    merged.shardSize = clampNumber(merged.shardSize, 20, 500, DEFAULT_CONFIG.shardSize);
    merged.modelTimeoutMs = clampNumber(merged.modelTimeoutMs, 1000, 10 * 60 * 1000, DEFAULT_CONFIG.modelTimeoutMs);
    merged.aiSummaryMaxUnits = clampNumber(
      merged.aiSummaryMaxUnits,
      1,
      1000,
      DEFAULT_CONFIG.aiSummaryMaxUnits,
    );
    merged.autoIndexEveryHours = clampNumber(
      merged.autoIndexEveryHours,
      1,
      24 * 30,
      DEFAULT_CONFIG.autoIndexEveryHours,
    );
    merged.baseUrl = normalizeModelBaseUrlForRequest(merged.baseUrl);
    merged.proxyMode = normalizeProxyMode(merged.proxyMode);
    merged.proxyGatewayUrl = String(merged.proxyGatewayUrl || "").trim().replace(/\/+$/, "");
    merged.dailyNotePath = normalizeDailyNotePath(merged.dailyNotePath);
    merged.dailyAiTopicMaxDays = clampNumber(
      merged.dailyAiTopicMaxDays,
      1,
      1000,
      DEFAULT_CONFIG.dailyAiTopicMaxDays,
    );
    merged.allowWriteActions = Boolean(merged.allowWriteActions);
    merged.autoIndexOnStart = Boolean(merged.autoIndexOnStart);
    merged.enableAiSummaries = Boolean(merged.enableAiSummaries);
    merged.enableDailyAiTopics = merged.enableDailyAiTopics !== false;
    merged.proxyFallback = Boolean(merged.proxyFallback);
    const mirror = this.getProfile(merged.chatProfileId, merged) || this.getProfile(merged.indexingProfileId, merged);
    if (mirror) {
      merged.baseUrl = mirror.baseUrl;
      merged.chatModel = mirror.chatModel;
      merged.embeddingModel = mirror.embeddingModel;
      merged.temperature = mirror.temperature;
      merged.modelTimeoutMs = mirror.modelTimeoutMs;
      merged.proxyMode = mirror.proxyMode;
      merged.proxyGatewayUrl = mirror.proxyGatewayUrl;
      merged.proxyFallback = mirror.proxyFallback;
    }
    return merged;
  }

  getProfile(id, config) {
    const source = config || this.config || {};
    const profiles = Array.isArray(source.profiles) ? source.profiles : [];
    return profiles.find((profile) => profile.id === id) || profiles[0] || null;
  }

  getIndexingProfile(config) {
    const source = config || this.config;
    return this.getProfile(source && source.indexingProfileId, source);
  }

  getChatProfile(config) {
    const source = config || this.config;
    return this.getProfile(source && source.chatProfileId, source);
  }

  getApiKeys() {
    let parsed = {};
    try {
      parsed = JSON.parse(window.localStorage.getItem(API_KEYS_STORAGE) || "{}") || {};
    } catch (error) {
      parsed = {};
    }
    const legacy = window.localStorage.getItem(API_KEY_STORAGE) || "";
    return mergeLegacyApiKey(parsed, legacy, "default");
  }

  setApiKeys(values) {
    const keys = normalizeApiKeys(values);
    if (Object.keys(keys).length) window.localStorage.setItem(API_KEYS_STORAGE, JSON.stringify(keys));
    else window.localStorage.removeItem(API_KEYS_STORAGE);
    window.localStorage.removeItem(API_KEY_STORAGE);
  }

  getApiKey(profileId) {
    const id = profileId || (this.getChatProfile() && this.getChatProfile().id) || "default";
    const keys = this.getApiKeys();
    return keys[id] || "";
  }

  setApiKey(value, profileId) {
    const keys = this.getApiKeys();
    const id = profileId || "default";
    const key = String(value || "").trim();
    if (key) keys[id] = key;
    else delete keys[id];
    this.setApiKeys(keys);
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
        "[data-kai-action], [data-kai-open-block], [data-kai-target-source], [data-kai-msg-copy], [data-kai-msg-more], [data-kai-msg-action]",
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
          } else if (target.hasAttribute("data-kai-msg-action")) {
            await this.runMessageAction(root, target);
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

  isTimelineOnlyQuestion(question) {
    const text = String(question || "");
    const asksActivity = /(干了啥|干了什么|做了啥|做了什么|发生了什么|有什么记录|进展|进度|回顾|总结|忙了什么)/.test(text);
    const asksTechnical = /(怎么|如何|方案|配置|部署|报错|错误|原因|迁移|代码|接口|模型|插件|API|api|VMware|win-server|服务器)/i.test(text);
    return asksActivity && !asksTechnical;
  }

  parseYmd(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  formatYmd(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  monthPrefixesForRange(timeRange, dailyPath) {
    const start = this.parseYmd(timeRange && timeRange.start);
    const end = this.parseYmd(timeRange && timeRange.end);
    if (!start || !end || start > end) return [];
    const prefixes = [];
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);
    while (cursor <= endMonth && prefixes.length < 24) {
      const yyyy = cursor.getFullYear();
      const mm = String(cursor.getMonth() + 1).padStart(2, "0");
      prefixes.push(`${dailyPath}/${yyyy}/${mm}/`);
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return prefixes;
  }

  dailyRangeSqlFilter(timeRange, dailyPath) {
    const prefixes = this.monthPrefixesForRange(timeRange, dailyPath);
    if (!prefixes.length) return `hpath LIKE '${escapeSql(dailyPath)}/%'`;
    return `(${prefixes.map((prefix) => `hpath LIKE '${escapeSql(prefix)}%'`).join(" OR ")})`;
  }

  async fetchDailyRowsForRange(timeRange) {
    const SELECT_COLS = "id, root_id, parent_id, box, path, hpath, type, subtype, content, markdown, updated";
    const BASE_WHERE = "content IS NOT NULL AND content != '' AND type IN ('d','h','p','l','i','c','b','m','t','s')";
    const dailyPath = normalizeDailyNotePath(this.config.dailyNotePath);
    const limit = clampNumber(this.config.maxIndexedBlocks, 100, 100000, DEFAULT_CONFIG.maxIndexedBlocks);
    const sql = [
      `SELECT ${SELECT_COLS} FROM blocks`,
      `WHERE ${BASE_WHERE}`,
      `AND ${this.dailyRangeSqlFilter(timeRange, dailyPath)}`,
      "ORDER BY hpath, id",
      `LIMIT ${limit}`,
    ].join(" ");
    const rows = (await this.siyuanPost("/api/query/sql", { stmt: sql })) || [];
    const groups = groupDailyRowsByDate(rows, timeRange, dailyPath);
    return {
      rows,
      groups,
      context: buildTimelineContext(groups, { perDayBlockLimit: 80, maxChars: 12000 }),
      truncatedByLimit: rows.length >= limit,
    };
  }

  async loadTimelineForQuestion(question) {
    const range = parseTimeRange(question, new Date());
    if (!range) return null;
    const timeline = await this.fetchDailyRowsForRange(range);
    return Object.assign({ range }, timeline);
  }

  detectNotebookScope(question, chunks) {
    const text = String(question || "").toLowerCase();
    if (!text) return null;
    const byBox = new Map();
    for (const unit of chunks || []) {
      const box = String(unit && unit.box || "").trim();
      if (!box) continue;
      if (!byBox.has(box)) byBox.set(box, { box, names: new Set() });
      const entry = byBox.get(box);
      if (unit.notebookName) entry.names.add(String(unit.notebookName));
      if (unit.type === "notebook" && unit.title) entry.names.add(String(unit.title));
    }
    const intentAliases = [
      { terms: ["工作", "上班", "公司"], names: ["工作"] },
      { terms: ["技术", "文档", "vmware", "迁移", "服务器", "win-server"], names: ["技术", "文档"] },
      { terms: ["哲思", "思考", "探索", "想法"], names: ["哲思", "探索", "想法"] },
      { terms: ["日记", "每日", "今天", "昨天", "本周", "上周"], names: ["daily", "日记", "每日"] },
    ];
    const scored = [];
    for (const entry of byBox.values()) {
      const names = Array.from(entry.names).filter(Boolean);
      let score = 0;
      for (const name of names) {
        const normalized = name.toLowerCase();
        if (normalized && text.includes(normalized)) score += 3;
      }
      for (const alias of intentAliases) {
        if (!alias.terms.some((term) => text.includes(term.toLowerCase()))) continue;
        if (alias.names.some((name) => names.some((candidate) => candidate.toLowerCase().includes(name.toLowerCase())))) score += 2;
      }
      if (score > 0) scored.push({ box: entry.box, score, label: names[0] || entry.box });
    }
    scored.sort((a, b) => b.score - a.score);
    if (!scored.length) return null;
    const best = scored[0].score;
    return {
      boxes: scored.filter((item) => item.score === best).map((item) => item.box),
      label: scored.filter((item) => item.score === best).map((item) => item.label).join("、"),
    };
  }

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

      let timeline = null;
      let timelineWarning = "";
      try {
        timeline = await this.loadTimelineForQuestion(question);
        if (timeline && !timeline.context) {
          timelineWarning = `⚠️ 已识别时间范围 ${timeline.range.label}（${timeline.range.start} 至 ${timeline.range.end}），但没有读取到对应 daily note 记录。`;
        } else if (timeline && timeline.truncatedByLimit) {
          timelineWarning = `⚠️ 时间轴记录达到读取上限 ${this.config.maxIndexedBlocks} 条，回答可能遗漏该时间段的部分 daily note 内容。`;
        }
      } catch (error) {
        console.warn("Knowledge AI: timeline retrieval skipped", error);
        timelineWarning = `⚠️ 时间轴读取失败：${error.message || error}`;
      }

      // 检索全库索引（与是否打开笔记无关）。纯时间线问题可直接使用 daily note 记录。
      let ranked = [];
      let retrievalWarning = "";
      const timelineOnly = timeline && timeline.context && this.isTimelineOnlyQuestion(question);
      if (!timelineOnly) {
        try {
          const chunks = await this.loadIndexedChunks();
          const notebookScope = this.detectNotebookScope(question, chunks);
          let searchChunks = chunks;
          if (notebookScope && notebookScope.boxes && notebookScope.boxes.length) {
            const boxes = new Set(notebookScope.boxes);
            searchChunks = chunks.map((chunk) => (boxes.has(chunk.box) ? Object.assign({}, chunk, { rankBoost: 0.08 }) : chunk));
          }
          const embeddedCount = countEmbeddedUnits(searchChunks);
          if (!embeddedCount) {
            throw new Error(`索引分片已读取 ${searchChunks.length} 个知识单元，但没有可用向量。请重新更新索引，并确认 Embedding 模型可用。`);
          }
          const queryEmbedding = (await this.embedTexts([question]))[0];
          if (!Array.isArray(queryEmbedding) || !queryEmbedding.length) {
            throw new Error("问题向量为空，请测试 Embedding 模型连接。");
          }
          ranked = rankChunks(searchChunks, queryEmbedding, this.config.topK, question);
          if (!ranked.length) {
            retrievalWarning = `⚠️ 已读取 ${searchChunks.length} 个知识单元，其中 ${embeddedCount} 个有向量，但本次没有返回引用。请尝试更具体的问题，或重新更新索引。`;
          } else if (notebookScope && notebookScope.label) {
            retrievalWarning = `已按笔记本轴加权：${notebookScope.label}`;
          }
        } catch (error) {
          // 索引不可用时降级为纯聊天/时间轴回答，但必须把原因展示给用户，避免看起来像 AI 读了笔记却一无所知。
          console.warn("Knowledge AI: retrieval skipped", error);
          retrievalWarning = `⚠️ 笔记检索失败：${error.message || error}\n\n当前回答会暂时按普通聊天${timeline && timeline.context ? "和时间段记录" : ""}生成，不能代表完整的思源笔记内容。`;
        }
      }

      // 占位助手气泡，流式感
      const placeholder = this.renderMessage(root, "assistant", "思考中...", []);
      const messages = buildMessages(this.config, question, ranked, this.conversation.slice(0, -1), {
        timeline,
      });
      const answer = await this.chat(messages);
      const warnings = [timelineWarning, retrievalWarning].filter(Boolean).join("\n\n");
      const visibleAnswer = warnings ? `${warnings}\n\n${answer}` : answer;

      this.conversation.push({ role: "assistant", content: visibleAnswer });
      this.lastAnswer = visibleAnswer;
      this.lastSources = ranked;
      this.updateAssistantMessage(placeholder, visibleAnswer, ranked);
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

  getMarkdownRenderer() {
    if (this.markdownRenderer) return this.markdownRenderer;
    try {
      if (Lute && typeof Lute.New === "function") {
        const lute = Lute.New();
        if (typeof lute.SetSanitize === "function") lute.SetSanitize(true);
        if (typeof lute.SetGFMStrikethrough === "function") lute.SetGFMStrikethrough(true);
        if (typeof lute.SetInlineMath === "function") lute.SetInlineMath(true);
        if (typeof lute.SetHeadingID === "function") lute.SetHeadingID(false);
        this.markdownRenderer = lute;
      }
    } catch (error) {
      console.warn("Knowledge AI: failed to initialize markdown renderer", error);
    }
    return this.markdownRenderer || null;
  }

  renderMarkdownHtml(content) {
    const markdown = String(content == null ? "" : content);
    try {
      const lute = this.getMarkdownRenderer();
      if (lute && typeof lute.MarkdownStr === "function") {
        return lute.MarkdownStr("", markdown);
      }
    } catch (error) {
      console.warn("Knowledge AI: markdown render failed", error);
    }
    return `<p>${escapeHtml(markdown).replace(/\n/g, "<br>")}</p>`;
  }

  setBubbleContent(bubble, content) {
    if (!bubble) return;
    const raw = String(content == null ? "" : content);
    bubble.dataset.kaiRaw = raw;
    bubble.innerHTML = `<div class="kai-markdown">${this.renderMarkdownHtml(raw)}</div>`;
  }

  messageRawContent(message) {
    const bubble = message && message.querySelector(".kai-bubble");
    return bubble ? bubble.dataset.kaiRaw || bubble.textContent || "" : "";
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
    this.setBubbleContent(bubble, content);
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
    this.setBubbleContent(bubble, answer);
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
            const typeLabel = this.sourceTypeLabel(chunk);
            const blockId = chunk.blockId || "";
            const openButton = blockId
              ? `<button class="b3-button b3-button--outline" data-kai-open-block="${escapeHtml(blockId)}">打开引用</button>`
              : "";
            const updateButton = blockId && (!chunk.type || chunk.type === "block")
              ? `<button class="b3-button b3-button--outline" data-kai-target-source="${escapeHtml(blockId)}">改写此引用</button>`
              : "";
            return `
              <div class="kai-source">
                <div class="kai-source-index">[${index + 1}]</div>
                <div class="kai-source-body">
                  <div class="kai-source-title">${escapeHtml(typeLabel)} · ${escapeHtml(title)}</div>
                  <div class="kai-muted">${escapeHtml(blockId || chunk.id || "")} · ${item.score.toFixed(3)}</div>
                  <div class="kai-source-text">${escapeHtml((chunk.summary || chunk.text || chunk.contextText || "").slice(0, 320))}</div>
                  <div class="kai-actions">
                    ${openButton}
                    ${updateButton}
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

  sourceTypeLabel(source) {
    return (
      {
        block: "块",
        section: "章节",
        document: "文档",
        daily_event: "日记事件",
        daily_item: "日记事项",
        daily_detail: "日记明细",
        notebook: "笔记本",
        vault: "全库",
      }[source && source.type] || "片段"
    );
  }

  openMessageMenu(root, index, anchor) {
    const message = root.querySelectorAll(".kai-msg")[index];
    if (!message) return;
    const existing = message.querySelector(".kai-msg-menu-inline");
    if (existing) {
      existing.remove();
      anchor.setAttribute("aria-expanded", "false");
      return;
    }
    for (const panel of root.querySelectorAll(".kai-msg-menu-inline")) panel.remove();
    for (const button of root.querySelectorAll("[data-kai-msg-more]")) button.setAttribute("aria-expanded", "false");
    const panel = document.createElement("div");
    panel.className = "kai-msg-menu-inline";
    panel.innerHTML = `
      <button class="kai-msg-menu-item" data-kai-msg-action="save">存为文档</button>
      <button class="kai-msg-menu-item" data-kai-msg-action="append">追加到当前文档</button>
      <button class="kai-msg-menu-item" data-kai-msg-action="new-note">生成新笔记</button>
      <button class="kai-msg-menu-item" data-kai-msg-action="update-block">改写当前块</button>
    `;
    message.appendChild(panel);
    anchor.setAttribute("aria-expanded", "true");
  }

  async runMessageAction(root, target) {
    const message = target.closest(".kai-msg");
    const raw = this.messageRawContent(message);
    if (raw) this.lastAnswer = raw;
    const action = target.getAttribute("data-kai-msg-action");
    if (action === "save") await this.saveAnswerAsDocument(root);
    else if (action === "append") await this.appendAnswerToCurrentDocument(root);
    else if (action === "new-note") this.openNewNoteDialog(root);
    else if (action === "update-block") this.openUpdateBlockDialog(root);
    const panel = message && message.querySelector(".kai-msg-menu-inline");
    if (panel) panel.remove();
  }

  async copyMessage(root, index) {
    const message = root.querySelectorAll(".kai-msg")[index];
    const value = this.messageRawContent(message);
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

  setIndexStatus(root, text, summaryText) {
    const status = root && root.querySelector("[data-kai-index-status]");
    if (status) status.textContent = text;
    const summary = root && root.querySelector("[data-kai-index-summary]");
    if (summary) {
      summary.textContent = summaryText || text;
      summary.setAttribute("title", text);
    }
  }

  setProgress(root, value, max) {
    const progress = root && root.querySelector("[data-kai-progress]");
    if (!progress) return;
    progress.max = Math.max(1, Number(max || 1));
    progress.value = Math.max(0, Number(value || 0));
  }

  setIndexingUi(root, indexing) {
    if (!root) return;
    const build = root.querySelector('[data-kai-settings-action="build-index"]');
    const buildWithSummaries = root.querySelector('[data-kai-settings-action="build-index-with-summaries"]');
    const cancel = root.querySelector("[data-kai-cancel-index]");
    if (build) build.disabled = Boolean(indexing);
    if (buildWithSummaries) buildWithSummaries.disabled = Boolean(indexing);
    if (cancel) cancel.hidden = !indexing;
  }

  makeCancelledError(label) {
    const error = new Error(`${label || "请求"}已取消`);
    error.cancelled = true;
    error.isNetworkError = false;
    return error;
  }

  isCancelledError(error) {
    return Boolean(
      error
        && (error.cancelled
          || error.name === "AbortError"
          || String(error.message || "").toLowerCase().includes("abort")
          || String(error.message || "").includes("取消")),
    );
  }

  throwIfCancelled(signal) {
    if (signal && signal.aborted) throw this.makeCancelledError("索引");
  }

  sleep(ms, signal) {
    const delay = Math.max(0, Number(ms || 0));
    if (!delay) {
      this.throwIfCancelled(signal);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let abortHandler = null;
      const timeoutId = window.setTimeout(() => {
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
        resolve();
      }, delay);
      abortHandler = () => {
        window.clearTimeout(timeoutId);
        if (signal) signal.removeEventListener("abort", abortHandler);
        reject(this.makeCancelledError("索引"));
      };
      if (signal) {
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
    });
  }

  makeRequestSignal(timeout, externalSignal) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    if (!controller) return { signal: externalSignal || undefined, cleanup: () => {} };
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      clampNumber(timeout, 1000, 10 * 60 * 1000, DEFAULT_CONFIG.modelTimeoutMs),
    );
    let externalAbort = null;
    if (externalSignal) {
      externalAbort = () => controller.abort();
      if (externalSignal.aborted) externalAbort();
      else externalSignal.addEventListener("abort", externalAbort, { once: true });
    }
    return {
      signal: controller.signal,
      cleanup: () => {
        window.clearTimeout(timeoutId);
        if (externalSignal && externalAbort) externalSignal.removeEventListener("abort", externalAbort);
      },
    };
  }

  setModelStatus(root, text, isError) {
    const status = root && root.querySelector("[data-kai-model-status]");
    if (!status) return;
    status.textContent = text;
    status.classList.toggle("kai-status-error", Boolean(isError));
  }

  async runSettingsAction(button, callback) {
    const previousDisabled = button.disabled;
    button.disabled = true;
    try {
      await callback();
    } catch (error) {
      console.error("Knowledge AI settings action failed", error);
      showMessage(`Knowledge AI：${error.message || error}`, 7000, "error");
      const root = button.closest(".kai-settings-dialog");
      if (root) this.setModelStatus(root, error.message || String(error), true);
    } finally {
      button.disabled = previousDisabled;
    }
  }

  async testChatConnection(root) {
    const draft = this.readSettingsDraft(root);
    this.setModelStatus(root, "正在测试聊天模型...");
    const answer = await this.chat(
      [
        {
          role: "user",
          content: "只回复 OK，不要解释。",
        },
      ],
      draft,
    );
    this.setModelStatus(root, `聊天测试通过（${this.formatLastModelRoute()}）：${answer.slice(0, 120)}`);
    showMessage("Knowledge AI：聊天测试通过");
  }

  async testEmbeddingConnection(root) {
    const draft = this.readSettingsDraft(root);
    this.setModelStatus(root, "正在测试 Embedding 模型...");
    const embeddings = await this.embedTexts(["Knowledge AI embedding connection test"], draft);
    const dimension = embeddings[0] && embeddings[0].length ? embeddings[0].length : 0;
    this.setModelStatus(root, `向量测试通过（${this.formatLastModelRoute()}）：维度 ${dimension}`);
    showMessage("Knowledge AI：向量测试通过");
  }

  async refreshIndexStatus(root) {
    const manifest = await this.readManifest();
    if (!manifest) {
      this.setIndexStatus(root, "未建立索引。其他设备同步完成后点刷新即可读取。", "未建立索引");
      this.setProgress(root, 0, 1);
      return;
    }
    const shardCount = Array.isArray(manifest.shards) ? manifest.shards.length : 0;
    const counts = manifest.unitCounts || {};
    const structured = Number(manifest.schemaVersion || manifest.version || 0) >= 2;
    const unitText = structured
      ? `${manifest.unitCount || 0} 单元（块 ${counts.block || 0} / 章节 ${counts.section || 0} / 文档 ${counts.document || 0} / 日记主题 ${counts.daily_topic || 0} / 笔记本 ${counts.notebook || 0} / 全库 ${counts.vault || 0}）`
      : `${manifest.chunkCount || 0} 片段`;
    const detail = `${unitText} / ${shardCount} 分片 / ${manifest.embeddingModel || ""}`;
    const compact = structured
      ? `索引 ${manifest.unitCount || 0} 单元 · ${shardCount} 分片`
      : `索引 ${manifest.chunkCount || 0} 片段 · ${shardCount} 分片`;
    this.setIndexStatus(root, detail, compact);
    this.setProgress(root, manifest.unitCount || manifest.chunkCount || shardCount || 1, manifest.unitCount || manifest.chunkCount || shardCount || 1);
  }

  async siyuanPost(path, payload, options) {
    const signal = options && options.signal;
    const response = signal
      ? await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload || {}),
          signal,
        }).then((item) => item.json())
      : await fetchSyncPost(path, payload || {});
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

  indexUnitKey(unit) {
    if (!unit || !unit.id || !unit.hash) return "";
    return `${unit.id}\n${unit.hash}`;
  }

  indexSourceKey(unit) {
    if (!unit || !unit.id) return "";
    const sourceHash = unit.sourceHash || unit.hash;
    if (!sourceHash) return "";
    return `${unit.id}\n${sourceHash}`;
  }

  async loadReusableIndexData(root, embeddingModel) {
    const manifest = await this.readManifest();
    const reusable = { embeddings: new Map(), summaries: new Map(), dailyTopics: new Map(), canReuseEmbeddings: false };
    if (!manifest || !Array.isArray(manifest.shards) || !manifest.shards.length) return reusable;
    const version = Number(manifest.schemaVersion || manifest.version || 0);
    if (version !== CURRENT_INDEX_VERSION) {
      this.setLog(root, "旧索引版本不兼容，无法复用旧向量");
      return reusable;
    }
    const canReuseEmbeddings = !embeddingModel || manifest.embeddingModel === embeddingModel;
    reusable.canReuseEmbeddings = canReuseEmbeddings;
    if (!canReuseEmbeddings) {
      this.setLog(root, `Embedding 模型已变化（旧：${manifest.embeddingModel || "未知"}，新：${embeddingModel}），不复用旧向量`);
    }
    for (const shard of manifest.shards) {
      if (!shard || !shard.path) continue;
      const data = await this.readJsonFile(shard.path, null);
      const units = data && (Array.isArray(data.units) ? data.units : data.chunks);
      if (!Array.isArray(units)) continue;
      for (const unit of units) {
        const sourceKey = this.indexSourceKey(unit);
        if (sourceKey && unit.summary) reusable.summaries.set(sourceKey, unit.summary);
        if (unit && unit.type === "daily_topic" && unit.dailySourceKey) {
          const dailyTopic = Object.assign({}, unit);
          if (!canReuseEmbeddings) delete dailyTopic.embedding;
          if (!reusable.dailyTopics.has(unit.dailySourceKey)) reusable.dailyTopics.set(unit.dailySourceKey, []);
          reusable.dailyTopics.get(unit.dailySourceKey).push(dailyTopic);
        }
        const key = this.indexUnitKey(unit);
        if (canReuseEmbeddings && key && Array.isArray(unit.embedding) && unit.embedding.length) {
          reusable.embeddings.set(key, unit.embedding);
        }
      }
    }
    if (reusable.summaries.size) this.setLog(root, `读取到可复用旧摘要 ${reusable.summaries.size} 个`);
    if (reusable.dailyTopics.size) this.setLog(root, `读取到可复用日记主题 ${Array.from(reusable.dailyTopics.values()).reduce((sum, items) => sum + items.length, 0)} 个`);
    if (reusable.embeddings.size) this.setLog(root, `读取到可复用旧向量 ${reusable.embeddings.size} 个`);
    return reusable;
  }

  applyReusableSummaries(units, reusable) {
    const summaries = reusable && reusable.summaries;
    if (!summaries || !summaries.size) return 0;
    const targets = (units || []).filter((unit) => unit && unit.type && unit.type !== "block");
    const limit = clampNumber(this.config.aiSummaryMaxUnits, 1, 1000, DEFAULT_CONFIG.aiSummaryMaxUnits);
    const planned = targets.slice(0, limit);
    let reused = 0;
    for (const unit of planned) {
      const summary = summaries.get(this.indexSourceKey(unit));
      if (applyUnitSummary(unit, summary)) reused += 1;
    }
    return reused;
  }

  applyReusableEmbeddings(units, reusable) {
    const embeddings = reusable && reusable.embeddings ? reusable.embeddings : reusable;
    if (!embeddings || !embeddings.size) return 0;
    let reused = 0;
    for (const unit of units || []) {
      const embedding = embeddings.get(this.indexUnitKey(unit));
      if (Array.isArray(embedding) && embedding.length) {
        unit.embedding = embedding;
        reused += 1;
      }
    }
    return reused;
  }

  async classifyDailyDetail(unit, options) {
    const messages = [
      {
        role: "system",
        content: [
          "你是思源 daily note 主题分类助手。请把一天的日记拆成少量主题。",
          "只输出 JSON，不要解释。格式：{\"topics\":[{\"category\":\"工作|技术|学习|想法|生活|其他\",\"title\":\"主题标题\",\"summary\":\"一句话说明\"}]}",
          "category 要短，title 要像可检索标题，summary 不要编造。",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `日期：${unit.dailyDate || unit.title || ""}`,
          `路径：${unit.hpath || ""}`,
          unit.tags && unit.tags.length ? `标签：${unit.tags.join("，")}` : "",
          "",
          "日记内容：",
          String(unit.text || unit.contextText || "").slice(0, 7000),
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ];
    const response = await this.chat(messages, { role: "indexing", signal: options && options.signal });
    return parseDailyTopicResponse(response);
  }

  async addDailyAiTopics(root, units, reusable, options) {
    if (this.config.enableDailyAiTopics === false) {
      this.setLog(root, "日记 AI 主题分类已关闭，跳过旧主题复用和新主题生成");
      return 0;
    }
    const details = (units || [])
      .filter((unit) => unit && unit.type === "daily_detail" && unit.dailyScope === "day")
      .sort((a, b) => String(b.dailyDate || b.updated || "").localeCompare(String(a.dailyDate || a.updated || "")));
    if (!details.length) return 0;
    const cached = reusable && reusable.dailyTopics ? reusable.dailyTopics : new Map();
    const includeAiTopics = Boolean(options && options.includeAiSummaries);
    const generationLimit = clampNumber(this.config.dailyAiTopicMaxDays, 1, 1000, DEFAULT_CONFIG.dailyAiTopicMaxDays);
    const additions = [];
    let reused = 0;
    let generated = 0;
    let generatedDays = 0;
    let skippedByBudget = 0;
    for (const detail of details) {
      this.throwIfCancelled(options && options.signal);
      const sourceKey = this.indexSourceKey(detail);
      const cachedTopics = sourceKey ? cached.get(sourceKey) : null;
      if (cachedTopics && cachedTopics.length) {
        additions.push(...cachedTopics.map((unit) => Object.assign({}, unit)));
        reused += cachedTopics.length;
        continue;
      }
      if (!includeAiTopics) continue;
      if (generatedDays >= generationLimit) {
        skippedByBudget += 1;
        continue;
      }
      const topics = await this.classifyDailyDetail(detail, options);
      const topicUnits = buildDailyTopicUnits(detail, topics, this.config);
      generatedDays += 1;
      if (topicUnits.length) {
        additions.push(...topicUnits);
        generated += topicUnits.length;
      }
      this.setLog(root, `日记 AI 分类 ${generatedDays} / ${generationLimit} 天，生成 ${generated} 个主题，当前日期：${detail.dailyDate || detail.title}`);
      await this.sleep(0, options && options.signal);
    }
    if (additions.length) units.push(...additions);
    if (reused) this.setLog(root, `复用日记 AI 主题 ${reused} 个`);
    if (generated) this.setLog(root, `生成日记 AI 主题 ${generated} 个`);
    if (skippedByBudget) this.setLog(root, `日记 AI 分类达到预算，跳过 ${skippedByBudget} 个变化日期`, true);
    return additions.length;
  }

  async buildIndex(root, options) {
    const silent = options && options.silent;
    const includeAiSummaries = Boolean(options && options.includeAiSummaries);
    if (this.indexing) {
      if (!silent) this.setLog(root, "索引正在更新，请等待当前任务结束");
      return;
    }
    const indexingProfile = this.getIndexingProfile();
    if (!indexingProfile || !indexingProfile.embeddingModel) {
      if (!silent) throw new Error("请先填写 Embedding 模型");
      return;
    }

    this.indexing = true;
    this.indexAbortController = typeof AbortController === "function" ? new AbortController() : null;
    const signal = this.indexAbortController ? this.indexAbortController.signal : null;
    this.setIndexingUi(root, true);
    try {
      this.setProgress(root, 0, 1);
      this.setLog(root, "开始读取思源全库块索引");
      const limit = clampNumber(this.config.maxIndexedBlocks, 100, 100000, DEFAULT_CONFIG.maxIndexedBlocks);
      const rows = await this.fetchIndexRows(root, limit);
      this.throwIfCancelled(signal);
      this.setLog(root, `读取到 ${rows.length} 个块，开始提取属性和引用关系`);
      const metadata = await this.loadIndexMetadata(rows, root);
      this.throwIfCancelled(signal);
      const units = buildKnowledgeUnits(rows, metadata.attrs, metadata.refs, Object.assign({}, this.config, {
        notebooks: metadata.notebooks,
      }));
      if (!units.length) throw new Error("没有可索引的知识单元");

      const reusable = await this.loadReusableIndexData(root, indexingProfile.embeddingModel);
      await this.addDailyAiTopics(root, units, reusable, { signal, includeAiSummaries });
      if (includeAiSummaries) {
        this.applyReusableSummaries(units, reusable);
      }
      await this.addOptionalSummaries(root, units, { signal, includeAiSummaries });
      this.throwIfCancelled(signal);
      const reusedCount = this.applyReusableEmbeddings(units, reusable);
      const pendingUnits = units.filter((unit) => !Array.isArray(unit.embedding) || !unit.embedding.length);
      if (reusedCount) {
        this.setLog(root, `复用旧向量 ${reusedCount} / ${units.length}，待向量化 ${pendingUnits.length} 个知识单元`);
      } else {
        this.setLog(root, `没有可复用旧向量，准备向量化 ${pendingUnits.length} 个知识单元`);
      }
      const isGeminiIndexing = detectProvider(indexingProfile.baseUrl) === "gemini";
      const configuredBatchSize = clampNumber(this.config.batchSize, 1, MAX_EMBEDDING_BATCH_SIZE, DEFAULT_CONFIG.batchSize);
      const batchSize = isGeminiIndexing ? MAX_EMBEDDING_BATCH_SIZE : configuredBatchSize;
      const batchDelayMs = isGeminiIndexing ? GEMINI_INDEX_BATCH_DELAY_MS : 0;
      if (isGeminiIndexing) {
        this.setLog(root, `Gemini 免费层按请求数限流，自动使用 ${batchSize} 一批并每批间隔 ${batchDelayMs}ms`);
      }
      this.setProgress(root, reusedCount, units.length);
      for (let start = 0; start < pendingUnits.length; start += batchSize) {
        this.throwIfCancelled(signal);
        const batch = pendingUnits.slice(start, start + batchSize);
        const embeddings = await this.embedTexts(batch.map((item) => item.contextText || item.text), {
          role: "indexing",
          signal,
          onRateLimit: (waitMs, attempt) => {
            this.setLog(root, `Embedding 触发服务商限流，等待 ${Math.ceil(waitMs / 1000)} 秒后自动继续（第 ${attempt} 次）`);
          },
        });
        embeddings.forEach((embedding, index) => {
          batch[index].embedding = embedding;
        });
        const embedded = Math.min(start + batch.length, pendingUnits.length);
        const done = reusedCount + embedded;
        this.setProgress(root, done, units.length);
        this.setLog(root, `向量化新增/变化 ${embedded} / ${pendingUnits.length}，总进度 ${done} / ${units.length}`);
        if (batchDelayMs && embedded < pendingUnits.length) await this.sleep(batchDelayMs, signal);
        else await this.sleep(0, signal);
      }

      await this.writeIndex(root, rows, units, metadata, {
        reusedEmbeddingCount: reusedCount,
        newEmbeddingCount: pendingUnits.length,
        aiSummaries: includeAiSummaries,
      });
      await this.refreshIndexStatus(root);
      if (!silent) showMessage("Knowledge AI：索引已更新");
    } catch (error) {
      if (this.isCancelledError(error)) {
        this.setLog(root, "索引已停止");
        if (!silent) showMessage("Knowledge AI：索引已停止");
        return;
      }
      throw error;
    } finally {
      this.indexing = false;
      this.indexAbortController = null;
      this.setIndexingUi(root, false);
    }
  }

  cancelIndex(root) {
    if (!this.indexing) {
      this.setLog(root, "当前没有正在更新的索引");
      return;
    }
    this.setLog(root, "正在停止索引...");
    if (this.indexAbortController) this.indexAbortController.abort();
  }

  // 读取索引块。先统计每个笔记本的块数，再按配额采样：
  // 总量未超上限时全量索引；超上限时按笔记本「保底 + 按规模加权」配额，
  // 每个笔记本各自 ORDER BY updated DESC，保证最新内容（含新增）进入索引。
  async fetchIndexRows(root, limit) {
    const SELECT_COLS = "id, root_id, parent_id, box, path, hpath, type, subtype, content, markdown, updated";
    const BASE_WHERE = "content IS NOT NULL AND content != '' AND type IN ('d','h','p','l','i','c','b','m','t','s')";

    let perBox = {};
    try {
      const counts = (await this.siyuanPost("/api/query/sql", {
        stmt: `SELECT box, COUNT(*) AS c FROM blocks WHERE ${BASE_WHERE} GROUP BY box`,
      })) || [];
      for (const row of counts) {
        const box = String((row && (row.box || row.BOX)) || "").trim();
        const count = Number(row && (row.c || row.C) || 0);
        if (box && count > 0) perBox[box] = count;
      }
    } catch (error) {
      console.warn("Knowledge AI: per-notebook count unavailable, fallback to global limit", error);
      perBox = {};
    }

    const boxes = Object.keys(perBox);
    // 无法分笔记本统计（旧版思源等）：回退为全局 ORDER BY updated DESC LIMIT
    if (!boxes.length) {
      const fallbackSql = `SELECT ${SELECT_COLS} FROM blocks WHERE ${BASE_WHERE} ORDER BY updated DESC LIMIT ${limit}`;
      return (await this.siyuanPost("/api/query/sql", { stmt: fallbackSql })) || [];
    }

    const quotas = computeNotebookQuotas(perBox, limit);
    this.setLog(root, `按笔记本配额采样：${boxes.map((box) => `${box}=${quotas[box] || 0}`).join(", ")}`);

    const rows = [];
    for (const box of boxes) {
      const quota = clampNumber(quotas[box], 0, limit, 0);
      if (quota <= 0) continue;
      const sql = `SELECT ${SELECT_COLS} FROM blocks WHERE ${BASE_WHERE} AND box='${escapeSql(box)}' ORDER BY updated DESC LIMIT ${quota}`;
      try {
        const batch = (await this.siyuanPost("/api/query/sql", { stmt: sql })) || [];
        rows.push(...batch);
      } catch (error) {
        console.warn("Knowledge AI: failed to read notebook", box, error);
        this.setLog(root, `读取笔记本 ${box} 失败，已跳过`, true);
      }
    }
    // 合并后按 box/path/id 排序，便于后续聚合构建章节/文档/笔记本单元
    rows.sort((a, b) => {
      const left = a || {};
      const right = b || {};
      return (
        String(left.box || "").localeCompare(String(right.box || "")) ||
        String(left.root_id || "").localeCompare(String(right.root_id || "")) ||
        String(left.path || "").localeCompare(String(right.path || "")) ||
        String(left.id || "").localeCompare(String(right.id || ""))
      );
    });
    return rows;
  }

  blockIdList(rows) {
    return Array.from(
      new Set(
        (rows || [])
          .map((row) => String((row && (row.id || row.block_id || row.blockId)) || "").trim())
          .filter(Boolean),
      ),
    );
  }

  async sqlInChunks(ids, makeSql, chunkSize) {
    const size = clampNumber(chunkSize, 50, 800, 400);
    const rows = [];
    for (let start = 0; start < ids.length; start += size) {
      const batch = ids.slice(start, start + size);
      const quoted = batch.map((id) => `'${escapeSql(id)}'`).join(",");
      const data = await this.siyuanPost("/api/query/sql", { stmt: makeSql(quoted) });
      if (Array.isArray(data)) rows.push(...data);
    }
    return rows;
  }

  async loadIndexMetadata(rows, root) {
    const ids = this.blockIdList(rows);
    const notebooks = await this.loadNotebookNames(root);
    const attrs = await this.loadBlockAttrsForIndex(ids, rows, root);
    const refs = await this.loadRefsForIndex(ids, root);
    return { attrs, refs, notebooks };
  }

  async loadNotebookNames(root) {
    try {
      const data = await this.siyuanPost("/api/notebook/lsNotebooks", {});
      const names = {};
      for (const notebook of data && data.notebooks ? data.notebooks : []) {
        if (notebook && notebook.id) names[notebook.id] = notebook.name || notebook.id;
      }
      return names;
    } catch (error) {
      console.warn("Knowledge AI: failed to load notebooks", error);
      this.setLog(root, "读取笔记本名称失败，索引将使用笔记本 ID", true);
      return {};
    }
  }

  async loadBlockAttrsForIndex(ids, rows, root) {
    const attrs = {};
    try {
      const attrRows = await this.sqlInChunks(
        ids,
        (quoted) => `SELECT block_id, name, value FROM attributes WHERE block_id IN (${quoted})`,
        400,
      );
      for (const row of attrRows) {
        const blockId = String(row.block_id || row.blockId || "").trim();
        const name = String(row.name || "").trim();
        if (!blockId || !name) continue;
        if (!attrs[blockId]) attrs[blockId] = {};
        attrs[blockId][name] = row.value == null ? "" : String(row.value);
      }
      this.setLog(root, `读取属性 ${attrRows.length} 条`);
      return attrs;
    } catch (error) {
      console.warn("Knowledge AI: attributes SQL unavailable", error);
      this.setLog(root, "属性表读取失败，尝试读取文档和标题块属性", true);
    }

    const selectedRows = (rows || []).filter((row) => row && (row.type === "d" || row.type === "h")).slice(0, 300);
    for (const row of selectedRows) {
      try {
        const data = await this.siyuanPost("/api/attr/getBlockAttrs", { id: row.id });
        if (data && typeof data === "object") attrs[row.id] = data;
      } catch (error) {
        console.warn("Knowledge AI: failed to load block attrs", row.id, error);
      }
    }
    this.setLog(root, `读取属性 ${Object.keys(attrs).length} 个块`);
    return attrs;
  }

  async loadRefsForIndex(ids, root) {
    const seen = new Set();
    const refs = [];
    try {
      const refRows = await this.sqlInChunks(
        ids,
        (quoted) => `SELECT * FROM refs WHERE block_id IN (${quoted}) OR def_block_id IN (${quoted})`,
        300,
      );
      for (const row of refRows) {
        const source = row.block_id || row.blockID || row.blockId;
        const target = row.def_block_id || row.defBlockId || row.def_id || row.target_id;
        const key = `${source || ""}->${target || ""}`;
        if (!source || !target || seen.has(key)) continue;
        seen.add(key);
        refs.push(row);
      }
      this.setLog(root, `读取块引用 ${refs.length} 条`);
    } catch (error) {
      console.warn("Knowledge AI: refs SQL unavailable", error);
      this.setLog(root, "引用表读取失败，将从 Markdown 文本中解析块引用", true);
    }
    return refs;
  }

  async addOptionalSummaries(root, units, options) {
    if (!options || !options.includeAiSummaries) return;
    const signal = options && options.signal;
    const targets = (units || []).filter((unit) => unit.type && unit.type !== "block" && unit.type !== "daily_detail");
    const limit = clampNumber(this.config.aiSummaryMaxUnits, 1, 1000, DEFAULT_CONFIG.aiSummaryMaxUnits);
    const planned = targets.slice(0, limit);
    const selected = planned.filter((unit) => !unit.summary);
    if (!planned.length) return;
    if (targets.length > planned.length) {
      this.setLog(root, `AI 摘要仅覆盖前 ${planned.length} / ${targets.length} 个主题单元`);
    }
    const reused = planned.length - selected.length;
    if (reused) {
      this.setLog(root, `复用旧主题摘要 ${reused} / ${planned.length}，待生成 ${selected.length} 个`);
    }
    if (!selected.length) return;
    if (!reused && targets.length <= planned.length) {
      this.setLog(root, `AI 摘要处理 ${selected.length} 个主题单元`);
    } else {
      this.setLog(root, `AI 摘要待生成 ${selected.length} 个主题单元`);
    }
    for (let index = 0; index < selected.length; index += 1) {
      this.throwIfCancelled(signal);
      const unit = selected[index];
      const summary = await this.summarizeUnit(unit, { signal });
      applyUnitSummary(unit, summary);
      this.setProgress(root, index + 1, selected.length);
      this.setLog(root, `生成主题摘要 ${index + 1} / ${selected.length}`);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  }

  async summarizeUnit(unit, options) {
    const messages = [
      {
        role: "system",
        content: "你是思源笔记知识库索引助手。请根据给定知识单元生成中文主题摘要，只输出摘要，不要写入笔记，不要编造。",
      },
      {
        role: "user",
        content: [
          `层级：${unit.type}`,
          `标题：${unit.title || unit.hpath || unit.id}`,
          unit.tags && unit.tags.length ? `标签：${unit.tags.join("，")}` : "",
          "",
          "内容：",
          String(unit.text || unit.contextText || "").slice(0, 5000),
          "",
          "请用 120 字以内概括主题、关键事实和用途。",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ];
    return (await this.chat(messages, { role: "indexing", signal: options && options.signal })).trim().slice(0, 600);
  }

  async writeIndex(root, rows, units, metadata, stats) {
    await this.ensureIndexDirs();
    const oldManifest = await this.readManifest();
    const oldShardPaths = new Set(
      oldManifest && Array.isArray(oldManifest.shards)
        ? oldManifest.shards.map((shard) => shard && shard.path).filter(Boolean)
        : [],
    );
    const buildId = `build-${Date.now().toString(36)}`;
    await this.putDirectory(`${INDEX_ROOT}/shards/${buildId}`);

    const shardSize = clampNumber(this.config.shardSize, 20, 500, DEFAULT_CONFIG.shardSize);
    const shards = [];
    for (let start = 0; start < units.length; start += shardSize) {
      const shardUnits = units.slice(start, start + shardSize);
      const shardId = `shard-${String(shards.length + 1).padStart(5, "0")}`;
      const path = makeShardPath(PLUGIN_NAME, `${buildId}/${shardId}`);
      await this.putJsonFile(path, {
        id: shardId,
        buildId,
        createdAt: nowIso(),
        schemaVersion: CURRENT_INDEX_VERSION,
        units: shardUnits,
      });
      shards.push({ id: shardId, path, count: shardUnits.length });
      this.setLog(root, `写入同步分片 ${shards.length}`);
    }

    const unitCounts = {};
    for (const unit of units) unitCounts[unit.type] = (unitCounts[unit.type] || 0) + 1;
    const indexingRuntime = this.resolveModelRuntime("indexing");
    const manifest = {
      version: CURRENT_INDEX_VERSION,
      schemaVersion: CURRENT_INDEX_VERSION,
      plugin: PLUGIN_NAME,
      buildId,
      builtAt: nowIso(),
      baseUrl: normalizeBaseUrl(indexingRuntime.config.baseUrl),
      embeddingModel: indexingRuntime.config.embeddingModel,
      embeddingProfileId: indexingRuntime.profile.id,
      embeddingProfileName: indexingRuntime.profile.name,
      chunkSize: this.config.chunkSize,
      chunkOverlap: this.config.chunkOverlap,
      structuredIndex: true,
      aiSummaries: Boolean(stats && stats.aiSummaries),
      blockCount: rows.length,
      chunkCount: units.length,
      unitCount: units.length,
      unitCounts,
      notebookCount: metadata && metadata.notebooks ? Object.keys(metadata.notebooks).length : 0,
      reusedEmbeddingCount: stats && Number(stats.reusedEmbeddingCount || 0) || 0,
      newEmbeddingCount: stats && Number(stats.newEmbeddingCount || 0) || 0,
      shards,
      hash: stableHash(units.map((item) => item.hash).join("\n")),
    };
    await this.putJsonFile(makeManifestPath(PLUGIN_NAME), manifest);

    const newShardPaths = new Set(shards.map((shard) => shard.path));
    for (const path of oldShardPaths) {
      if (!path || newShardPaths.has(path)) continue;
      try {
        await this.removeFile(path);
      } catch (error) {
        console.warn("Knowledge AI: failed to remove old shard", path, error);
      }
    }
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
    const indexingRuntime = this.resolveModelRuntime("indexing");
    const manifestError = getIndexManifestError(manifest, indexingRuntime.config.embeddingModel, CURRENT_INDEX_VERSION);
    if (manifestError) throw new Error(manifestError);
    const units = [];
    for (const shard of manifest.shards) {
      const data = await this.readJsonFile(shard.path, null);
      if (data && Array.isArray(data.units)) units.push(...data.units);
      else if (data && Array.isArray(data.chunks)) units.push(...data.chunks);
    }
    if (!units.length) throw new Error("索引分片为空，请等待同步完成或重新更新索引");
    return units;
  }

  profileRuntimeConfig(config, profile) {
    const source = config || this.config || {};
    const selected = profile || this.getChatProfile(source) || makeDefaultProfile();
    return Object.assign({}, source, {
      baseUrl: normalizeModelBaseUrlForRequest(selected.baseUrl),
      chatModel: selected.chatModel,
      embeddingModel: selected.embeddingModel,
      temperature: clampNumber(selected.temperature, 0, 2, DEFAULT_CONFIG.temperature),
      modelTimeoutMs: clampNumber(selected.modelTimeoutMs, 1000, 10 * 60 * 1000, DEFAULT_CONFIG.modelTimeoutMs),
      proxyMode: normalizeProxyMode(selected.proxyMode),
      proxyGatewayUrl: String(selected.proxyGatewayUrl || "").trim().replace(/\/+$/, ""),
      proxyFallback: selected.proxyFallback !== false,
    });
  }

  resolveModelRuntime(role, options) {
    const runtime = options || {};
    const sourceConfig = runtime.config ? this.normalizeConfig(runtime.config) : this.config;
    const requestedRole = runtime.role || role || "chat";
    const profile = requestedRole === "indexing" ? this.getIndexingProfile(sourceConfig) : this.getChatProfile(sourceConfig);
    const selected = profile || this.getProfile("", sourceConfig) || makeDefaultProfile();
    const apiKeys = runtime.apiKeys || this.getApiKeys();
    const apiKey = runtime.apiKey == null ? (apiKeys[selected.id] || "") : runtime.apiKey;
    return {
      profile: selected,
      apiKey,
      config: this.profileRuntimeConfig(sourceConfig, selected),
      signal: runtime.signal,
    };
  }

  async modelPost(endpoint, payload, label, options) {
    const runtime = options || {};
    const config = runtime.config || this.config;
    const apiKey = runtime.apiKey == null ? this.getApiKey() : runtime.apiKey;
    const signal = runtime.signal;
    const baseUrl = normalizeModelBaseUrlForRequest(config.baseUrl);
    const url = `${baseUrl}/${String(endpoint || "").replace(/^\/+/, "")}`;
    const routes = getModelRequestRoutes(config, baseUrl);
    const errors = [];

    for (let index = 0; index < routes.length; index += 1) {
      const route = routes[index];
      try {
        const data = await this.requestModelByRoute(route, url, apiKey, payload, label, config, signal);
        this.lastModelRoute = {
          route,
          fallbackFrom: index > 0 ? routes[index - 1] : "",
          attempts: routes.slice(0, index + 1),
        };
        return data;
      } catch (error) {
        const tagged = markModelRouteError(error, route);
        if (tagged.cancelled) throw tagged;
        errors.push(tagged);
        if (!isFallbackAllowed(tagged, config, routes.slice(index + 1))) {
          throw this.composeModelRouteError(label, errors);
        }
        console.warn("Knowledge AI: model route failed, trying fallback", route, tagged);
      }
    }

    throw this.composeModelRouteError(label, errors);
  }

  async requestModelByRoute(route, url, apiKey, payload, label, config, signal) {
    if (route === "direct") return this.modelPostViaDirect(url, apiKey, payload, label, config.modelTimeoutMs, signal);
    if (route === "siyuan") return this.modelPostViaSiyuanProxy(url, apiKey, payload, label, config.modelTimeoutMs, signal);
    if (route === "gateway") return this.modelPostViaGateway(url, apiKey, payload, label, config, signal);
    throw new Error(`未知模型请求路由：${route}`);
  }

  async modelPostViaSiyuanProxy(url, apiKey, payload, label, timeout, signal) {
    const proxyPayload = buildModelProxyPayload(url, apiKey, payload, timeout);
    try {
      const data = await this.siyuanPost("/api/network/forwardProxy", proxyPayload, { signal });
      return parseModelProxyJson(data, label);
    } catch (error) {
      if (this.isCancelledError(error)) throw markModelRouteError(this.makeCancelledError(label), "siyuan", false);
      throw markModelRouteError(error, "siyuan", false);
    }
  }

  async modelPostViaDirect(url, apiKey, payload, label, timeout, signal) {
    let response;
    let body = "";
    const requestSignal = this.makeRequestSignal(timeout, signal);
    try {
      response = await fetch(url, {
        method: "POST",
        headers: buildModelRequestHeaders(apiKey),
        body: JSON.stringify(payload || {}),
        signal: requestSignal.signal,
      });
      body = await response.text();
    } catch (error) {
      if (this.isCancelledError(error)) throw markModelRouteError(this.makeCancelledError(label), "direct", false);
      throw markModelRouteError(
        new Error(
          `${label} API 浏览器直连失败：${error.message || error}。本地模型请确认服务已启动；远程模型可切换到思源转发或自定义转发网关。`,
        ),
        "direct",
        true,
      );
    } finally {
      requestSignal.cleanup();
    }
    try {
      return parseModelProxyJson({ status: response.status, body, url }, label);
    } catch (error) {
      throw markModelRouteError(error, "direct", false);
    }
  }

  async modelPostViaGateway(url, apiKey, payload, label, config, signal) {
    let gateway;
    let proxyPayload;
    try {
      const built = buildGatewayProxyPayload(config.proxyGatewayUrl, url, apiKey, payload, config.modelTimeoutMs);
      gateway = built.gatewayUrl;
      proxyPayload = built.payload;
    } catch (error) {
      throw markModelRouteError(error, "gateway", false);
    }

    let response;
    let body = "";
    const requestSignal = this.makeRequestSignal(config.modelTimeoutMs, signal);
    try {
      response = await fetch(gateway, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(proxyPayload),
        signal: requestSignal.signal,
      });
      body = await response.text();
    } catch (error) {
      if (this.isCancelledError(error)) throw markModelRouteError(this.makeCancelledError(label), "gateway", false);
      throw markModelRouteError(new Error(`${label} API 自定义转发网关失败：${error.message || error}`), "gateway", true);
    } finally {
      requestSignal.cleanup();
    }

    let parsedGateway = null;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.status !== "undefined" && typeof parsed.body !== "undefined") parsedGateway = parsed;
    } catch (error) {
      // 非 forwardProxy 响应时按普通 HTTP 响应解析。
    }
    if (parsedGateway) {
      try {
        return parseModelProxyJson(parsedGateway, label);
      } catch (error) {
        throw markModelRouteError(error, "gateway", false);
      }
    }

    try {
      return parseModelProxyJson({ status: response.status, body, url: gateway }, label);
    } catch (error) {
      throw markModelRouteError(error, "gateway", false);
    }
  }

  formatLastModelRoute() {
    const info = this.lastModelRoute || {};
    const current = modelRouteLabel(info.route);
    if (info.fallbackFrom) return `${current}，由 ${modelRouteLabel(info.fallbackFrom)} 回退`;
    return current || "未知路由";
  }

  composeModelRouteError(label, errors) {
    const list = (errors || []).filter(Boolean);
    if (list.length === 1) return list[0];
    const detail = list.map((error) => `${modelRouteLabel(error.route)}：${error.message || error}`).join("；");
    const message = detail || "无详细错误";
    const composed = new Error(`${label} API 请求失败，已尝试 ${list.map((error) => modelRouteLabel(error.route)).join(" -> ")}：${message}`);
    const last = list[list.length - 1] || {};
    composed.status = last.status || 0;
    composed.retryDelayMs = last.retryDelayMs || 0;
    composed.routes = list.map((error) => error.route);
    composed.isNetworkError = list.some((error) => error.isNetworkError);
    return composed;
  }

  async embedTexts(texts, options) {
    const runtime = this.resolveModelRuntime("indexing", Object.assign({}, options || {}, { role: (options && options.role) || "indexing" }));
    const opts = options || {};
    const maxAttempts = opts.role === "indexing" ? 5 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const data = await this.modelPost(
          "embeddings",
          {
            model: runtime.config.embeddingModel,
            input: texts,
          },
          "Embedding",
          runtime,
        );
        const embeddings = extractEmbeddings(data);
        if (embeddings.length !== texts.length) throw new Error("Embedding API 返回数量和请求数量不一致");
        return embeddings;
      } catch (error) {
        if (Number(error && error.status) !== 429 || attempt >= maxAttempts) throw error;
        const waitMs = clampNumber(error.retryDelayMs || 60000, 1000, 5 * 60 * 1000, 60000);
        if (typeof opts.onRateLimit === "function") opts.onRateLimit(waitMs, attempt);
        await this.sleep(waitMs, opts.signal);
      }
    }
    throw new Error("Embedding API 请求失败");
  }

  async chat(messages, options) {
    const runtime = this.resolveModelRuntime("chat", options);
    const data = await this.modelPost(
      "chat/completions",
      {
        model: runtime.config.chatModel,
        messages,
        temperature: runtime.config.temperature,
      },
      "Chat",
      runtime,
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
        const blockRef = chunk.blockId ? ` \`${chunk.blockId}\`` : "";
        lines.push(`${index + 1}. [${this.sourceTypeLabel(chunk)}] ${sourceTitle}${blockRef}`);
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
