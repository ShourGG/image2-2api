"use client";

import { create } from "zustand";
import { toast } from "sonner";

import {
  createCPAPool,
  deleteCPAPool,
  fetchCPAPoolFiles,
  fetchCPAPools,
  fetchRegisterConfig,
  resetRegister as resetRegisterApi,
  fetchSettingsConfig,
  startRegister,
  startCPAImport,
  stopRegister,
  updateCPAPool,
  updateRegisterConfig,
  updateSettingsConfig,
  type CPAPool,
  type CPARemoteFile,
  type ImageApiUpstream,
  type RegisterConfig,
  type SettingsConfig,
} from "@/lib/api";

export const PAGE_SIZE_OPTIONS = ["50", "100", "200"] as const;

export type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number];

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeImageApiUpstream(item: Partial<ImageApiUpstream>, index: number): ImageApiUpstream {
  return {
    id: String(item.id || createId()),
    name: String(item.name || `上游 ${index + 1}`),
    base_url: String(item.base_url || ""),
    api_key: "",
    api_key_set: Boolean(item.api_key_set),
    model: String(item.model || "gpt-image-2"),
    max_concurrency: normalizeInteger(item.max_concurrency, 8, 1),
    enabled: item.enabled !== false,
  };
}

function normalizeInteger(value: unknown, fallback: number, min = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.trunc(numeric));
}

function normalizeConfig(config: SettingsConfig): SettingsConfig {
  const imageGenerationStrategy =
    config.image_generation_strategy === "gpt2api" ||
    config.image_generation_strategy === "codex_responses" ||
    config.image_generation_strategy === "openai_compatible"
      ? config.image_generation_strategy
      : "chatgpt2api";
  const rawUpstreams = Array.isArray(config.image_generation_api_upstreams)
    ? config.image_generation_api_upstreams.map((item, index) => normalizeImageApiUpstream(item, index))
    : [];
  const imageApiUpstreams =
    rawUpstreams.length > 0
      ? rawUpstreams
      : [
          normalizeImageApiUpstream(
            {
              id: "default",
              name: "默认上游",
              base_url: config.image_generation_api_base_url,
              api_key_set: config.image_generation_api_key_set,
              model: config.image_generation_api_model,
              max_concurrency: config.image_generation_api_max_concurrency,
              enabled: true,
            },
            0,
          ),
        ].filter((item) => item.base_url || item.api_key_set);
  return {
    ...config,
    refresh_account_interval_minute: Number(config.refresh_account_interval_minute || 5),
    image_retention_days: Number(config.image_retention_days || 30),
    image_poll_timeout_secs: normalizeInteger(config.image_poll_timeout_secs, 120, 1),
    auth_rate_limit_login_ip_limit: normalizeInteger(config.auth_rate_limit_login_ip_limit, 30, 0),
    auth_rate_limit_login_ip_window_seconds: normalizeInteger(config.auth_rate_limit_login_ip_window_seconds, 300, 1),
    auth_rate_limit_login_ip_email_limit: normalizeInteger(config.auth_rate_limit_login_ip_email_limit, 10, 0),
    auth_rate_limit_login_ip_email_window_seconds: normalizeInteger(config.auth_rate_limit_login_ip_email_window_seconds, 300, 1),
    auth_rate_limit_register_ip_limit: normalizeInteger(config.auth_rate_limit_register_ip_limit, 10, 0),
    auth_rate_limit_register_ip_window_seconds: normalizeInteger(config.auth_rate_limit_register_ip_window_seconds, 1800, 1),
    auth_rate_limit_register_ip_email_limit: normalizeInteger(config.auth_rate_limit_register_ip_email_limit, 3, 0),
    auth_rate_limit_register_ip_email_window_seconds: normalizeInteger(config.auth_rate_limit_register_ip_email_window_seconds, 1800, 1),
    auth_register_ip_account_limit: normalizeInteger(config.auth_register_ip_account_limit, 1, 0),
    image_generation_strategy: imageGenerationStrategy,
    auto_remove_invalid_accounts: Boolean(config.auto_remove_invalid_accounts),
    auto_remove_rate_limited_accounts: Boolean(config.auto_remove_rate_limited_accounts),
    log_levels: Array.isArray(config.log_levels) ? config.log_levels : [],
    proxy: typeof config.proxy === "string" ? config.proxy : "",
    base_url: typeof config.base_url === "string" ? config.base_url : "",
    sensitive_words: Array.isArray(config.sensitive_words) ? config.sensitive_words : [],
    ai_review: {
      enabled: Boolean(config.ai_review?.enabled),
      base_url: String(config.ai_review?.base_url || ""),
      api_key: String(config.ai_review?.api_key || ""),
      model: String(config.ai_review?.model || ""),
      prompt: String(config.ai_review?.prompt || ""),
    },
    image_generation_api_base_url: typeof config.image_generation_api_base_url === "string" ? config.image_generation_api_base_url : "",
    image_generation_api_key: "",
    image_generation_api_key_set: Boolean(config.image_generation_api_key_set),
    image_generation_api_model: typeof config.image_generation_api_model === "string" ? config.image_generation_api_model : "gpt-image-2",
    image_generation_api_max_concurrency: Number(config.image_generation_api_max_concurrency || 8),
    image_generation_api_upstreams: imageApiUpstreams,
  };
}

function normalizeFiles(items: CPARemoteFile[]) {
  const seen = new Set<string>();
  const files: CPARemoteFile[] = [];
  for (const item of items) {
    const name = String(item.name || "").trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    files.push({
      name,
      email: String(item.email || "").trim(),
    });
  }
  return files;
}

type SettingsStore = {
  config: SettingsConfig | null;
  isLoadingConfig: boolean;
  isSavingConfig: boolean;

  registerConfig: RegisterConfig | null;
  isLoadingRegister: boolean;
  isSavingRegister: boolean;

  pools: CPAPool[];
  isLoadingPools: boolean;
  deletingId: string | null;
  loadingFilesId: string | null;

  dialogOpen: boolean;
  editingPool: CPAPool | null;
  formName: string;
  formBaseUrl: string;
  formSecretKey: string;
  showSecret: boolean;
  isSavingPool: boolean;

  browserOpen: boolean;
  browserPool: CPAPool | null;
  remoteFiles: CPARemoteFile[];
  selectedNames: string[];
  fileQuery: string;
  filePage: number;
  pageSize: PageSizeOption;
  isStartingImport: boolean;

  initialize: () => Promise<void>;
  loadConfig: () => Promise<void>;
  saveConfig: () => Promise<void>;
  setRefreshAccountIntervalMinute: (value: string) => void;
  setImageRetentionDays: (value: string) => void;
  setImagePollTimeoutSecs: (value: string) => void;
  setAuthRateLimitField: (
    key:
      | "auth_rate_limit_login_ip_limit"
      | "auth_rate_limit_login_ip_window_seconds"
      | "auth_rate_limit_login_ip_email_limit"
      | "auth_rate_limit_login_ip_email_window_seconds"
      | "auth_rate_limit_register_ip_limit"
      | "auth_rate_limit_register_ip_window_seconds"
      | "auth_rate_limit_register_ip_email_limit"
      | "auth_rate_limit_register_ip_email_window_seconds"
      | "auth_register_ip_account_limit",
    value: string,
  ) => void;
  setAutoRemoveInvalidAccounts: (value: boolean) => void;
  setAutoRemoveRateLimitedAccounts: (value: boolean) => void;
  setLogLevel: (level: string, enabled: boolean) => void;
  setImageGenerationStrategy: (value: "chatgpt2api" | "gpt2api" | "codex_responses" | "openai_compatible") => void;
  setImageGenerationApiBaseUrl: (value: string) => void;
  setImageGenerationApiKey: (value: string) => void;
  setImageGenerationApiModel: (value: string) => void;
  setImageGenerationApiMaxConcurrency: (value: string) => void;
  setSensitiveWordsText: (value: string) => void;
  setAIReviewField: (key: "enabled" | "base_url" | "api_key" | "model" | "prompt", value: string | boolean) => void;
  addImageApiUpstream: () => void;
  updateImageApiUpstream: (id: string, updates: Partial<ImageApiUpstream>) => void;
  deleteImageApiUpstream: (id: string) => void;
  setProxy: (value: string) => void;
  setBaseUrl: (value: string) => void;

  loadRegister: (silent?: boolean) => Promise<void>;
  setRegisterConfig: (config: RegisterConfig) => void;
  setRegisterProxy: (value: string) => void;
  setRegisterTotal: (value: string) => void;
  setRegisterThreads: (value: string) => void;
  setRegisterMode: (value: "total" | "quota" | "available") => void;
  setRegisterTargetQuota: (value: string) => void;
  setRegisterTargetAvailable: (value: string) => void;
  setRegisterCheckInterval: (value: string) => void;
  setRegisterMailField: (key: "request_timeout" | "wait_timeout" | "wait_interval", value: string) => void;
  addRegisterProvider: () => void;
  updateRegisterProvider: (index: number, updates: Record<string, unknown>) => void;
  deleteRegisterProvider: (index: number) => void;
  saveRegister: () => Promise<void>;
  toggleRegister: () => Promise<void>;
  resetRegister: () => Promise<void>;

  loadPools: (silent?: boolean) => Promise<void>;
  openAddDialog: () => void;
  openEditDialog: (pool: CPAPool) => void;
  setDialogOpen: (open: boolean) => void;
  setFormName: (value: string) => void;
  setFormBaseUrl: (value: string) => void;
  setFormSecretKey: (value: string) => void;
  setShowSecret: (checked: boolean) => void;
  savePool: () => Promise<void>;
  deletePool: (pool: CPAPool) => Promise<void>;

  browseFiles: (pool: CPAPool) => Promise<void>;
  setBrowserOpen: (open: boolean) => void;
  toggleFile: (name: string, checked: boolean) => void;
  replaceSelectedNames: (names: string[]) => void;
  setFileQuery: (value: string) => void;
  setFilePage: (page: number) => void;
  setPageSize: (value: PageSizeOption) => void;
  startImport: () => Promise<void>;
};

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  config: null,
  isLoadingConfig: true,
  isSavingConfig: false,

  registerConfig: null,
  isLoadingRegister: true,
  isSavingRegister: false,

  pools: [],
  isLoadingPools: true,
  deletingId: null,
  loadingFilesId: null,

  dialogOpen: false,
  editingPool: null,
  formName: "",
  formBaseUrl: "",
  formSecretKey: "",
  showSecret: false,
  isSavingPool: false,

  browserOpen: false,
  browserPool: null,
  remoteFiles: [],
  selectedNames: [],
  fileQuery: "",
  filePage: 1,
  pageSize: "100",
  isStartingImport: false,

  initialize: async () => {
    await Promise.allSettled([get().loadConfig(), get().loadPools()]);
  },

  loadConfig: async () => {
    set({ isLoadingConfig: true });
    try {
      const data = await fetchSettingsConfig();
      set({
        config: normalizeConfig(data.config),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载系统配置失败");
    } finally {
      set({ isLoadingConfig: false });
    }
  },

  saveConfig: async () => {
    const { config } = get();
    if (!config) {
      return;
    }

    set({ isSavingConfig: true });
    try {
      const data = await updateSettingsConfig({
        ...config,
        refresh_account_interval_minute: Math.max(1, Number(config.refresh_account_interval_minute) || 1),
        image_retention_days: Math.max(1, Number(config.image_retention_days) || 30),
        image_poll_timeout_secs: Math.max(1, Number(config.image_poll_timeout_secs) || 120),
        auth_rate_limit_login_ip_limit: normalizeInteger(config.auth_rate_limit_login_ip_limit, 30, 0),
        auth_rate_limit_login_ip_window_seconds: normalizeInteger(config.auth_rate_limit_login_ip_window_seconds, 300, 1),
        auth_rate_limit_login_ip_email_limit: normalizeInteger(config.auth_rate_limit_login_ip_email_limit, 10, 0),
        auth_rate_limit_login_ip_email_window_seconds: normalizeInteger(config.auth_rate_limit_login_ip_email_window_seconds, 300, 1),
        auth_rate_limit_register_ip_limit: normalizeInteger(config.auth_rate_limit_register_ip_limit, 10, 0),
        auth_rate_limit_register_ip_window_seconds: normalizeInteger(config.auth_rate_limit_register_ip_window_seconds, 1800, 1),
        auth_rate_limit_register_ip_email_limit: normalizeInteger(config.auth_rate_limit_register_ip_email_limit, 3, 0),
        auth_rate_limit_register_ip_email_window_seconds: normalizeInteger(config.auth_rate_limit_register_ip_email_window_seconds, 1800, 1),
        auth_register_ip_account_limit: normalizeInteger(config.auth_register_ip_account_limit, 1, 0),
        image_generation_strategy:
          config.image_generation_strategy === "gpt2api" ||
          config.image_generation_strategy === "codex_responses" ||
          config.image_generation_strategy === "openai_compatible"
            ? config.image_generation_strategy
            : "chatgpt2api",
        image_generation_api_base_url: String(config.image_generation_api_base_url || "").trim(),
        ...(String(config.image_generation_api_key || "").trim()
          ? { image_generation_api_key: String(config.image_generation_api_key || "").trim() }
          : {}),
        image_generation_api_model: String(config.image_generation_api_model || "gpt-image-2").trim() || "gpt-image-2",
        image_generation_api_max_concurrency: Math.max(1, Number(config.image_generation_api_max_concurrency) || 8),
        image_generation_api_upstreams: (config.image_generation_api_upstreams || []).map((item, index) => ({
          id: item.id || createId(),
          name: String(item.name || `上游 ${index + 1}`).trim() || `上游 ${index + 1}`,
          base_url: String(item.base_url || "").trim(),
          ...(String(item.api_key || "").trim() ? { api_key: String(item.api_key || "").trim() } : {}),
          model: String(item.model || "gpt-image-2").trim() || "gpt-image-2",
          max_concurrency: normalizeInteger(item.max_concurrency, 8, 1),
          enabled: item.enabled !== false,
        })),
        auto_remove_invalid_accounts: Boolean(config.auto_remove_invalid_accounts),
        auto_remove_rate_limited_accounts: Boolean(config.auto_remove_rate_limited_accounts),
        proxy: config.proxy.trim(),
        base_url: String(config.base_url || "").trim(),
        sensitive_words: (config.sensitive_words || []).map((item) => String(item).trim()).filter(Boolean),
        ai_review: {
          enabled: Boolean(config.ai_review?.enabled),
          base_url: String(config.ai_review?.base_url || "").trim(),
          api_key: String(config.ai_review?.api_key || "").trim(),
          model: String(config.ai_review?.model || "").trim(),
          prompt: String(config.ai_review?.prompt || "").trim(),
        },
      });
      set({
        config: normalizeConfig(data.config),
      });
      toast.success("配置已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存系统配置失败");
    } finally {
      set({ isSavingConfig: false });
    }
  },

  setRefreshAccountIntervalMinute: (value) => {
    set((state) => {
      if (!state.config) {
        return {};
      }
      return {
        config: {
          ...state.config,
          refresh_account_interval_minute: value,
        },
      };
    });
  },

  setImageRetentionDays: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_retention_days: value } } : {});
  },

  setImagePollTimeoutSecs: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_poll_timeout_secs: value } } : {});
  },

  setAuthRateLimitField: (key, value) => {
    set((state) => state.config ? { config: { ...state.config, [key]: value } } : {});
  },

  setAutoRemoveInvalidAccounts: (value) => {
    set((state) => state.config ? { config: { ...state.config, auto_remove_invalid_accounts: value } } : {});
  },

  setAutoRemoveRateLimitedAccounts: (value) => {
    set((state) => state.config ? { config: { ...state.config, auto_remove_rate_limited_accounts: value } } : {});
  },

  setLogLevel: (level, enabled) => {
    set((state) => {
      if (!state.config) return {};
      const levels = new Set(state.config.log_levels || []);
      if (enabled) levels.add(level);
      else levels.delete(level);
      return { config: { ...state.config, log_levels: Array.from(levels) } };
    });
  },

  setSensitiveWordsText: (value) => {
    set((state) => state.config ? { config: { ...state.config, sensitive_words: value.split("\n") } } : {});
  },

  setAIReviewField: (key, value) => {
    set((state) =>
      state.config
        ? {
            config: {
              ...state.config,
              ai_review: { ...(state.config.ai_review || {}), [key]: value },
            },
          }
        : {},
    );
  },

  setImageGenerationStrategy: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_generation_strategy: value } } : {});
  },

  setImageGenerationApiBaseUrl: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_generation_api_base_url: value } } : {});
  },

  setImageGenerationApiKey: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_generation_api_key: value } } : {});
  },

  setImageGenerationApiModel: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_generation_api_model: value } } : {});
  },

  setImageGenerationApiMaxConcurrency: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_generation_api_max_concurrency: value } } : {});
  },

  addImageApiUpstream: () => {
    set((state) => {
      if (!state.config) return {};
      const items = state.config.image_generation_api_upstreams || [];
      return {
        config: {
          ...state.config,
          image_generation_api_upstreams: [
            ...items,
            {
              id: createId(),
              name: `上游 ${items.length + 1}`,
              base_url: "",
              api_key: "",
              api_key_set: false,
              model: "gpt-image-2",
              max_concurrency: 8,
              enabled: true,
            },
          ],
        },
      };
    });
  },

  updateImageApiUpstream: (id, updates) => {
    set((state) => {
      if (!state.config) return {};
      return {
        config: {
          ...state.config,
          image_generation_api_upstreams: (state.config.image_generation_api_upstreams || []).map((item) =>
            item.id === id ? { ...item, ...updates } : item,
          ),
        },
      };
    });
  },

  deleteImageApiUpstream: (id) => {
    set((state) => {
      if (!state.config) return {};
      return {
        config: {
          ...state.config,
          image_generation_api_upstreams: (state.config.image_generation_api_upstreams || []).filter((item) => item.id !== id),
        },
      };
    });
  },

  setProxy: (value) => {
    set((state) => {
      if (!state.config) {
        return {};
      }
      return {
        config: {
          ...state.config,
          proxy: value,
        },
      };
    });
  },

  setBaseUrl: (value) => {
    set((state) => {
      if (!state.config) {
        return {};
      }
      return {
        config: {
          ...state.config,
          base_url: value,
        },
      };
    });
  },

  loadRegister: async (silent = false) => {
    if (!silent) set({ isLoadingRegister: true });
    try {
      const data = await fetchRegisterConfig();
      set({ registerConfig: data.register });
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "加载注册配置失败");
    } finally {
      if (!silent) set({ isLoadingRegister: false });
    }
  },

  setRegisterConfig: (config) => {
    set({ registerConfig: config, isLoadingRegister: false });
  },

  setRegisterProxy: (value) => {
    set((state) => state.registerConfig ? { registerConfig: { ...state.registerConfig, proxy: value } } : {});
  },

  setRegisterTotal: (value) => {
    set((state) => state.registerConfig ? { registerConfig: { ...state.registerConfig, total: Number(value) || 0 } } : {});
  },

  setRegisterThreads: (value) => {
    set((state) => state.registerConfig ? { registerConfig: { ...state.registerConfig, threads: Number(value) || 0 } } : {});
  },

  setRegisterMode: (value) => {
    set((state) => state.registerConfig ? { registerConfig: { ...state.registerConfig, mode: value } } : {});
  },

  setRegisterTargetQuota: (value) => {
    set((state) => state.registerConfig ? { registerConfig: { ...state.registerConfig, target_quota: Number(value) || 0 } } : {});
  },

  setRegisterTargetAvailable: (value) => {
    set((state) => state.registerConfig ? { registerConfig: { ...state.registerConfig, target_available: Number(value) || 0 } } : {});
  },

  setRegisterCheckInterval: (value) => {
    set((state) => state.registerConfig ? { registerConfig: { ...state.registerConfig, check_interval: Number(value) || 0 } } : {});
  },

  setRegisterMailField: (key, value) => {
    set((state) => state.registerConfig ? {
      registerConfig: {
        ...state.registerConfig,
        mail: { ...state.registerConfig.mail, [key]: Number(value) || 0 },
      },
    } : {});
  },

  addRegisterProvider: () => {
    set((state) => state.registerConfig ? {
      registerConfig: {
        ...state.registerConfig,
        mail: {
          ...state.registerConfig.mail,
          providers: [
            ...(state.registerConfig.mail.providers || []),
            { enable: true, type: "tempmail_lol", api_key: "", domain: [] },
          ],
        },
      },
    } : {});
  },

  updateRegisterProvider: (index, updates) => {
    set((state) => {
      if (!state.registerConfig) return {};
      const providers = [...(state.registerConfig.mail.providers || [])];
      providers[index] = { ...(providers[index] || {}), ...updates };
      return { registerConfig: { ...state.registerConfig, mail: { ...state.registerConfig.mail, providers } } };
    });
  },

  deleteRegisterProvider: (index) => {
    set((state) => state.registerConfig ? {
      registerConfig: {
        ...state.registerConfig,
        mail: {
          ...state.registerConfig.mail,
          providers: (state.registerConfig.mail.providers || []).filter((_, itemIndex) => itemIndex !== index),
        },
      },
    } : {});
  },

  saveRegister: async () => {
    const { registerConfig } = get();
    if (!registerConfig) return;
    try {
      set({ isSavingRegister: true });
      const data = await updateRegisterConfig({
        mail: registerConfig.mail,
        proxy: registerConfig.proxy.trim(),
        total: Math.max(1, Number(registerConfig.total) || 1),
        threads: Math.max(1, Number(registerConfig.threads) || 1),
        mode: registerConfig.mode,
        target_quota: Math.max(1, Number(registerConfig.target_quota) || 1),
        target_available: Math.max(1, Number(registerConfig.target_available) || 1),
        check_interval: Math.max(1, Number(registerConfig.check_interval) || 5),
      });
      set({ registerConfig: data.register });
      toast.success("注册配置已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存注册配置失败");
    } finally {
      set({ isSavingRegister: false });
    }
  },

  toggleRegister: async () => {
    const { registerConfig } = get();
    if (!registerConfig) return;
    set({ isSavingRegister: true });
    try {
      if (!registerConfig.enabled) {
        await updateRegisterConfig({
          mail: registerConfig.mail,
          proxy: registerConfig.proxy.trim(),
          total: Math.max(1, Number(registerConfig.total) || 1),
          threads: Math.max(1, Number(registerConfig.threads) || 1),
          mode: registerConfig.mode,
          target_quota: Math.max(1, Number(registerConfig.target_quota) || 1),
          target_available: Math.max(1, Number(registerConfig.target_available) || 1),
          check_interval: Math.max(1, Number(registerConfig.check_interval) || 5),
        });
      }
      const data = registerConfig.enabled ? await stopRegister() : await startRegister();
      set({ registerConfig: data.register });
      toast.success(registerConfig.enabled ? "注册任务已停止" : "注册任务已启动");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "切换注册状态失败");
    } finally {
      set({ isSavingRegister: false });
    }
  },

  resetRegister: async () => {
    set({ isSavingRegister: true });
    try {
      const data = await resetRegisterApi();
      set({ registerConfig: data.register });
      toast.success("注册统计已重置");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重置注册统计失败");
    } finally {
      set({ isSavingRegister: false });
    }
  },

  loadPools: async (silent = false) => {
    if (!silent) {
      set({ isLoadingPools: true });
    }
    try {
      const data = await fetchCPAPools();
      set({ pools: data.pools });
    } catch (error) {
      if (!silent) {
        toast.error(error instanceof Error ? error.message : "加载 CPA 连接失败");
      }
    } finally {
      if (!silent) {
        set({ isLoadingPools: false });
      }
    }
  },

  openAddDialog: () => {
    set({
      editingPool: null,
      formName: "",
      formBaseUrl: "",
      formSecretKey: "",
      showSecret: false,
      dialogOpen: true,
    });
  },

  openEditDialog: (pool) => {
    set({
      editingPool: pool,
      formName: pool.name,
      formBaseUrl: pool.base_url,
      formSecretKey: "",
      showSecret: false,
      dialogOpen: true,
    });
  },

  setDialogOpen: (open) => {
    set({ dialogOpen: open });
  },

  setFormName: (value) => {
    set({ formName: value });
  },

  setFormBaseUrl: (value) => {
    set({ formBaseUrl: value });
  },

  setFormSecretKey: (value) => {
    set({ formSecretKey: value });
  },

  setShowSecret: (checked) => {
    set({ showSecret: checked });
  },

  savePool: async () => {
    const { editingPool, formName, formBaseUrl, formSecretKey } = get();
    if (!formBaseUrl.trim()) {
      toast.error("请输入 CPA 地址");
      return;
    }
    if (!editingPool && !formSecretKey.trim()) {
      toast.error("请输入 Secret Key");
      return;
    }

    set({ isSavingPool: true });
    try {
      if (editingPool) {
        const data = await updateCPAPool(editingPool.id, {
          name: formName.trim(),
          base_url: formBaseUrl.trim(),
          secret_key: formSecretKey.trim() || undefined,
        });
        set({ pools: data.pools, dialogOpen: false });
        toast.success("连接已更新");
      } else {
        const data = await createCPAPool({
          name: formName.trim(),
          base_url: formBaseUrl.trim(),
          secret_key: formSecretKey.trim(),
        });
        set({ pools: data.pools, dialogOpen: false });
        toast.success("连接已添加");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      set({ isSavingPool: false });
    }
  },

  deletePool: async (pool) => {
    set({ deletingId: pool.id });
    try {
      const data = await deleteCPAPool(pool.id);
      set({ pools: data.pools });
      toast.success("连接已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      set({ deletingId: null });
    }
  },

  browseFiles: async (pool) => {
    set({ loadingFilesId: pool.id });
    try {
      const data = await fetchCPAPoolFiles(pool.id);
      const files = normalizeFiles(data.files);
      set({
        browserPool: pool,
        remoteFiles: files,
        selectedNames: [],
        fileQuery: "",
        filePage: 1,
        browserOpen: true,
      });
      toast.success(`读取成功，共 ${files.length} 个远程账号`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "读取远程账号失败");
    } finally {
      set({ loadingFilesId: null });
    }
  },

  setBrowserOpen: (open) => {
    set({ browserOpen: open });
  },

  toggleFile: (name, checked) => {
    set((state) => {
      if (checked) {
        return {
          selectedNames: Array.from(new Set([...state.selectedNames, name])),
        };
      }
      return {
        selectedNames: state.selectedNames.filter((item) => item !== name),
      };
    });
  },

  replaceSelectedNames: (names) => {
    set({ selectedNames: Array.from(new Set(names)) });
  },

  setFileQuery: (value) => {
    set({ fileQuery: value, filePage: 1 });
  },

  setFilePage: (page) => {
    set({ filePage: page });
  },

  setPageSize: (value) => {
    set({ pageSize: value, filePage: 1 });
  },

  startImport: async () => {
    const { browserPool, selectedNames, pools } = get();
    if (!browserPool) {
      return;
    }
    if (selectedNames.length === 0) {
      toast.error("请先选择要导入的账号");
      return;
    }

    set({ isStartingImport: true });
    try {
      const result = await startCPAImport(browserPool.id, selectedNames);
      set({
        pools: pools.map((pool) =>
          pool.id === browserPool.id ? { ...pool, import_job: result.import_job } : pool,
        ),
        browserOpen: false,
      });
      toast.success("导入任务已启动");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "启动导入失败");
    } finally {
      set({ isStartingImport: false });
    }
  },
}));
