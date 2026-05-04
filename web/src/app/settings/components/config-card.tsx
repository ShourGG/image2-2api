"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ImageIcon, LoaderCircle, PlugZap, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  bindAdminAccount,
  fetchImageApiUpstreamStatuses,
  fetchImageApiUpstreamUsage,
  testImageApiUpstreamGeneration,
  testProxy,
  type ImageApiUpstreamRuntimeStatus,
  type ProxyTestResult,
} from "@/lib/api";

import { useSettingsStore } from "../store";

const DEFAULT_UPSTREAM_TEST_PROMPT = "一张简洁的测试图片：白色背景上有一个蓝色圆形和清晰的 TEST 字样。";

function formatNumber(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "";
  }
  return numeric.toFixed(4).replace(/\.?0+$/, "");
}

function textareaListValue(value: unknown) {
  return Array.isArray(value) ? value.join("\n") : String(value || "");
}

function formatUpstreamUsageResult(result: { ok: boolean; status: number; usage?: unknown; error?: unknown }) {
  if (!result.ok) {
    const error =
      typeof result.error === "string"
        ? result.error
        : result.error
          ? JSON.stringify(result.error)
          : "上游不支持 /v1/usage 或 key 不可用";
    return `查询失败：${error}`;
  }
  const usage = result.usage;
  if (!usage || typeof usage !== "object") {
    return "查询成功，但上游没有返回额度明细";
  }
  const data = usage as Record<string, unknown>;
  const quota = data.quota && typeof data.quota === "object" ? (data.quota as Record<string, unknown>) : null;
  const parts: string[] = [];
  if (typeof data.mode === "string") {
    parts.push(`模式 ${data.mode}`);
  }
  if (quota) {
    const remaining = formatNumber(quota.remaining);
    const used = formatNumber(quota.used);
    const limit = formatNumber(quota.limit);
    if (remaining) parts.push(`剩余 ${remaining} ${quota.unit || data.unit || ""}`.trim());
    if (used || limit) parts.push(`已用/总额 ${used || "-"} / ${limit || "-"} ${quota.unit || data.unit || ""}`.trim());
  } else {
    const remaining = formatNumber(data.remaining);
    const balance = formatNumber(data.balance);
    if (remaining) parts.push(`剩余 ${remaining} ${data.unit || ""}`.trim());
    if (balance) parts.push(`余额 ${balance} ${data.unit || ""}`.trim());
  }
  const usageSummary = data.usage && typeof data.usage === "object" ? (data.usage as Record<string, unknown>) : null;
  const total = usageSummary?.total && typeof usageSummary.total === "object" ? (usageSummary.total as Record<string, unknown>) : null;
  if (total) {
    const cost = formatNumber(total.actual_cost ?? total.cost);
    if (cost) parts.push(`历史消耗 ${cost} ${data.unit || "USD"}`.trim());
  }
  return parts.length > 0 ? parts.join("；") : `查询成功：${JSON.stringify(usage)}`;
}

function formatUpstreamRuntimeStatus(status: ImageApiUpstreamRuntimeStatus | undefined) {
  if (!status) {
    return "运行状态读取中...";
  }
  if (status.status === "disabled") {
    return "运行状态：已停用";
  }
  if (status.status === "cooldown") {
    return `运行状态：冷却中，约 ${status.cooldown_remaining_seconds} 秒后重试；本地占用 ${status.active_count}/${status.max_concurrency}`;
  }
  if (status.status === "busy") {
    return `运行状态：本地槽位已满；本地占用 ${status.active_count}/${status.max_concurrency}`;
  }
  return `运行状态：可用；本地占用 ${status.active_count}/${status.max_concurrency}，剩余槽位 ${status.available_slots}`;
}

function runtimeBadgeTone(status: ImageApiUpstreamRuntimeStatus | undefined) {
  if (!status) return "bg-stone-100 text-stone-600";
  if (status.status === "cooldown") return "bg-amber-50 text-amber-700";
  if (status.status === "busy") return "bg-rose-50 text-rose-700";
  if (status.status === "disabled") return "bg-stone-100 text-stone-600";
  return "bg-emerald-50 text-emerald-700";
}

function runtimeBadgeLabel(status: ImageApiUpstreamRuntimeStatus | undefined) {
  if (!status) return "读取中";
  if (status.status === "cooldown") return `冷却中 ${status.cooldown_remaining_seconds}s`;
  if (status.status === "busy") return "本地满载";
  if (status.status === "disabled") return "已停用";
  return "可用";
}

type UpstreamImageTestResult = {
  ok: boolean;
  message: string;
  imageUrl?: string;
};

type SettingsSectionProps = {
  title: string;
  description: string;
  isOpen: boolean;
  onToggle: () => void;
  children: ReactNode;
};

function SettingsSection({ title, description, isOpen, onToggle, children }: SettingsSectionProps) {
  return (
    <section className="overflow-hidden rounded-2xl border border-stone-200 bg-white">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-4 px-4 py-4 text-left transition hover:bg-stone-50"
        onClick={onToggle}
      >
        <div>
          <div className="text-sm font-medium text-stone-800">{title}</div>
          <p className="mt-1 text-xs leading-5 text-stone-500">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-600">
          <span>{isOpen ? "收起" : "展开"}</span>
          <ChevronDown className={`size-4 transition ${isOpen ? "rotate-180" : ""}`} />
        </div>
      </button>
      {isOpen ? <div className="border-t border-stone-100 px-4 py-4">{children}</div> : null}
    </section>
  );
}

export function ConfigCard() {
  const [isTestingProxy, setIsTestingProxy] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<ProxyTestResult | null>(null);
  const [testingUpstreamId, setTestingUpstreamId] = useState("");
  const [upstreamUsageResults, setUpstreamUsageResults] = useState<Record<string, string>>({});
  const [testingImageUpstreamId, setTestingImageUpstreamId] = useState("");
  const [upstreamTestPrompts, setUpstreamTestPrompts] = useState<Record<string, string>>({});
  const [upstreamImageTestResults, setUpstreamImageTestResults] = useState<Record<string, UpstreamImageTestResult>>({});
  const [upstreamRuntimeStatuses, setUpstreamRuntimeStatuses] = useState<Record<string, ImageApiUpstreamRuntimeStatus>>({});
  const [adminBindName, setAdminBindName] = useState("");
  const [adminBindEmail, setAdminBindEmail] = useState("");
  const [adminBindPassword, setAdminBindPassword] = useState("");
  const [isBindingAdmin, setIsBindingAdmin] = useState(false);
  const [activeTab, setActiveTab] = useState<"basic" | "image" | "registration" | "security">("basic");
  const [openSections, setOpenSections] = useState({
    admin: true,
    basic: true,
    userRegistration: true,
    rateLimit: false,
    image: true,
    cleanup: false,
    filter: false,
    logs: false,
  });
  const logLevelOptions = ["debug", "info", "warning", "error"];
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const setRefreshAccountIntervalMinute = useSettingsStore((state) => state.setRefreshAccountIntervalMinute);
  const setImageRetentionDays = useSettingsStore((state) => state.setImageRetentionDays);
  const setImagePollTimeoutSecs = useSettingsStore((state) => state.setImagePollTimeoutSecs);
  const setUserRegistrationEnabled = useSettingsStore((state) => state.setUserRegistrationEnabled);
  const setUserRegistrationBooleanField = useSettingsStore((state) => state.setUserRegistrationBooleanField);
  const setUserRegistrationField = useSettingsStore((state) => state.setUserRegistrationField);
  const setAuthRateLimitField = useSettingsStore((state) => state.setAuthRateLimitField);
  const setAutoRemoveInvalidAccounts = useSettingsStore((state) => state.setAutoRemoveInvalidAccounts);
  const setAutoRemoveRateLimitedAccounts = useSettingsStore((state) => state.setAutoRemoveRateLimitedAccounts);
  const setLogLevel = useSettingsStore((state) => state.setLogLevel);
  const setSensitiveWordsText = useSettingsStore((state) => state.setSensitiveWordsText);
  const setAIReviewField = useSettingsStore((state) => state.setAIReviewField);
  const setImageGenerationStrategy = useSettingsStore((state) => state.setImageGenerationStrategy);
  const addImageApiUpstream = useSettingsStore((state) => state.addImageApiUpstream);
  const updateImageApiUpstream = useSettingsStore((state) => state.updateImageApiUpstream);
  const deleteImageApiUpstream = useSettingsStore((state) => state.deleteImageApiUpstream);
  const setProxy = useSettingsStore((state) => state.setProxy);
  const setBaseUrl = useSettingsStore((state) => state.setBaseUrl);
  const saveConfig = useSettingsStore((state) => state.saveConfig);
  const upstreamStatusKey = useMemo(
    () =>
      (config?.image_generation_api_upstreams || [])
        .map((item) => `${item.id}:${item.enabled !== false}:${item.max_concurrency || ""}`)
        .join("|"),
    [config?.image_generation_api_upstreams],
  );
  const authRateLimitGroups = [
    {
      title: "登录限流",
      hint: "建议保守一些，防撞库。填 0 可关闭某条规则。",
      fields: [
        {
          key: "auth_rate_limit_login_ip_limit" as const,
          label: "同 IP 次数",
          placeholder: "30",
        },
        {
          key: "auth_rate_limit_login_ip_window_seconds" as const,
          label: "同 IP 窗口秒数",
          placeholder: "300",
        },
        {
          key: "auth_rate_limit_login_ip_email_limit" as const,
          label: "同 IP + 同邮箱 次数",
          placeholder: "10",
        },
        {
          key: "auth_rate_limit_login_ip_email_window_seconds" as const,
          label: "同 IP + 同邮箱 窗口秒数",
          placeholder: "300",
        },
      ],
    },
    {
      title: "注册限流",
      hint: "注册建议比登录更严，避免批量刷号。填 0 可关闭某条规则。",
      fields: [
        {
          key: "auth_register_ip_account_limit" as const,
          label: "同 IP 成功注册账号数",
          placeholder: "1",
        },
        {
          key: "auth_rate_limit_register_ip_limit" as const,
          label: "同 IP 次数",
          placeholder: "10",
        },
        {
          key: "auth_rate_limit_register_ip_window_seconds" as const,
          label: "同 IP 窗口秒数",
          placeholder: "1800",
        },
        {
          key: "auth_rate_limit_register_ip_email_limit" as const,
          label: "同 IP + 同邮箱 次数",
          placeholder: "3",
        },
        {
          key: "auth_rate_limit_register_ip_email_window_seconds" as const,
          label: "同 IP + 同邮箱 窗口秒数",
          placeholder: "1800",
        },
      ],
    },
  ];

  const handleTestProxy = async () => {
    const candidate = String(config?.proxy || "").trim();
    if (!candidate) {
      toast.error("请先填写代理地址");
      return;
    }
    setIsTestingProxy(true);
    setProxyTestResult(null);
    try {
      const data = await testProxy(candidate);
      setProxyTestResult(data.result);
      if (data.result.ok) {
        toast.success(`代理可用（${data.result.latency_ms} ms，HTTP ${data.result.status}）`);
      } else {
        toast.error(`代理不可用：${data.result.error ?? "未知错误"}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "测试代理失败");
    } finally {
      setIsTestingProxy(false);
    }
  };

  const handleTestUpstreamUsage = async (upstreamId: string) => {
    setTestingUpstreamId(upstreamId);
    setUpstreamUsageResults((current) => ({ ...current, [upstreamId]: "查询中..." }));
    try {
      const data = await fetchImageApiUpstreamUsage(upstreamId);
      setUpstreamRuntimeStatuses((current) => ({
        ...current,
        [upstreamId]: data.runtime,
      }));
      setUpstreamUsageResults((current) => ({
        ...current,
        [upstreamId]: formatUpstreamUsageResult(data.result),
      }));
    } catch (error) {
      setUpstreamUsageResults((current) => ({
        ...current,
        [upstreamId]: error instanceof Error ? error.message : "查询失败",
      }));
    } finally {
      setTestingUpstreamId("");
    }
  };

  const handleTestUpstreamImage = async (upstreamId: string) => {
    const prompt = String(upstreamTestPrompts[upstreamId] || DEFAULT_UPSTREAM_TEST_PROMPT).trim() || DEFAULT_UPSTREAM_TEST_PROMPT;
    setTestingImageUpstreamId(upstreamId);
    setUpstreamImageTestResults((current) => ({
      ...current,
      [upstreamId]: { ok: false, message: "测试出图中..." },
    }));
    try {
      const data = await testImageApiUpstreamGeneration(upstreamId, { prompt, size: "1024x1024" });
      setUpstreamRuntimeStatuses((current) => ({
        ...current,
        [upstreamId]: data.runtime,
      }));
      if (!data.result.ok) {
        const error =
          typeof data.result.error === "string"
            ? data.result.error
            : data.result.error
              ? JSON.stringify(data.result.error)
              : "测试出图失败";
        setUpstreamImageTestResults((current) => ({
          ...current,
          [upstreamId]: { ok: false, message: error },
        }));
        toast.error(`测试出图失败：${error}`);
        return;
      }
      const firstImage = data.result.data?.[0];
      const imageUrl = firstImage?.url || (firstImage?.b64_json ? `data:image/png;base64,${firstImage.b64_json}` : "");
      setUpstreamImageTestResults((current) => ({
        ...current,
        [upstreamId]: {
          ok: Boolean(imageUrl),
          message: imageUrl ? "测试出图成功" : "测试成功，但响应里没有图片地址",
          imageUrl,
        },
      }));
      if (imageUrl) {
        toast.success("测试出图成功");
      } else {
        toast.warning("测试成功，但响应里没有图片地址");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "测试出图失败";
      setUpstreamImageTestResults((current) => ({
        ...current,
        [upstreamId]: { ok: false, message },
      }));
      toast.error(message);
    } finally {
      setTestingImageUpstreamId("");
    }
  };

  useEffect(() => {
    if (config?.image_generation_strategy !== "openai_compatible") {
      setUpstreamRuntimeStatuses({});
      return;
    }
    let cancelled = false;
    const loadStatuses = async () => {
      try {
        const data = await fetchImageApiUpstreamStatuses();
        if (cancelled) return;
        setUpstreamRuntimeStatuses(
          Object.fromEntries(data.items.map((item) => [item.id, item])),
        );
      } catch {
        if (cancelled) return;
      }
    };
    void loadStatuses();
    const timer = window.setInterval(() => {
      void loadStatuses();
    }, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [config?.image_generation_strategy, upstreamStatusKey]);

  const handleBindAdminAccount = async () => {
    const normalizedEmail = adminBindEmail.trim();
    if (!normalizedEmail || !adminBindPassword) {
      toast.error("请填写管理员邮箱和密码");
      return;
    }
    setIsBindingAdmin(true);
    try {
      const data = await bindAdminAccount({
        email: normalizedEmail,
        password: adminBindPassword,
        name: adminBindName.trim(),
      });
      setAdminBindPassword("");
      toast.success(`管理员账号已绑定：${data.item.email}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "绑定管理员账号失败");
    } finally {
      setIsBindingAdmin(false);
    }
  };

  if (isLoadingConfig) {
    return (
      <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="flex items-center justify-center p-10">
          <LoaderCircle className="size-5 animate-spin text-stone-400" />
        </CardContent>
      </Card>
    );
  }

  const toggleSection = (key: keyof typeof openSections) => {
    setOpenSections((current) => ({ ...current, [key]: !current[key] }));
  };

  const setAllSections = (nextOpen: boolean) => {
    setOpenSections({
      admin: nextOpen,
      basic: nextOpen,
      rateLimit: nextOpen,
      image: nextOpen,
      cleanup: nextOpen,
      filter: nextOpen,
      logs: nextOpen,
    });
  };

  const tabButtonClass = (tab: "basic" | "image" | "registration" | "security") =>
    `rounded-full px-4 py-2 text-sm transition ${
      activeTab === tab
        ? "bg-stone-950 text-white shadow-sm"
        : "bg-white text-stone-600 hover:bg-stone-100 hover:text-stone-900"
    }`;

  return (
    <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
      <CardContent className="space-y-4 p-6">
        <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm leading-6 text-stone-600">
          登录入口已经合并：普通用户和管理员都使用邮箱密码登录；后台密钥只在首次部署初始化时使用。
        </div>
        <div className="overflow-x-auto">
          <div className="inline-flex min-w-full gap-2 rounded-2xl bg-stone-100 p-2 sm:min-w-0">
            <button type="button" className={tabButtonClass("basic")} onClick={() => setActiveTab("basic")}>
              基础设置
            </button>
            <button type="button" className={tabButtonClass("image")} onClick={() => setActiveTab("image")}>
              生图配置
            </button>
            <button type="button" className={tabButtonClass("registration")} onClick={() => setActiveTab("registration")}>
              用户注册
            </button>
            <button type="button" className={tabButtonClass("security")} onClick={() => setActiveTab("security")}>
              安全与日志
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-9 rounded-xl border-stone-200 bg-white px-4 text-stone-700"
            onClick={() => setAllSections(true)}
          >
            全部展开
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-9 rounded-xl border-stone-200 bg-white px-4 text-stone-700"
            onClick={() => setAllSections(false)}
          >
            全部收起
          </Button>
        </div>
        <div className="space-y-4">
          {activeTab === "basic" ? (
            <>
              <SettingsSection
                title="管理员账号绑定"
                description="当前已登录管理员可以绑定或更新后台邮箱密码。以后登录页直接填这个邮箱密码即可进后台。"
                isOpen={openSections.admin}
                onToggle={() => toggleSection("admin")}
              >
                <div className="mb-4 flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-stone-100">
                    <ShieldCheck className="size-5 text-stone-600" />
                  </div>
                  <div className="text-xs leading-6 text-stone-500">管理员入口已合并到普通登录页，不再单独找后台入口。</div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="text-sm text-stone-700">管理员名称</label>
                    <Input
                      value={adminBindName}
                      onChange={(event) => setAdminBindName(event.target.value)}
                      placeholder="可选，例如 Shour"
                      className="mt-2 h-10 rounded-xl border-stone-200 bg-white"
                    />
                  </div>
                  <div>
                    <label className="text-sm text-stone-700">管理员邮箱</label>
                    <Input
                      type="email"
                      value={adminBindEmail}
                      onChange={(event) => setAdminBindEmail(event.target.value)}
                      placeholder="admin@example.com"
                      className="mt-2 h-10 rounded-xl border-stone-200 bg-white"
                    />
                  </div>
                  <div>
                    <label className="text-sm text-stone-700">登录密码</label>
                    <Input
                      type="password"
                      value={adminBindPassword}
                      onChange={(event) => setAdminBindPassword(event.target.value)}
                      placeholder="至少 6 位"
                      className="mt-2 h-10 rounded-xl border-stone-200 bg-white"
                      autoComplete="new-password"
                    />
                  </div>
                </div>
                <div className="mt-4 flex justify-end">
                  <Button
                    type="button"
                    className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
                    onClick={() => void handleBindAdminAccount()}
                    disabled={isBindingAdmin}
                  >
                    {isBindingAdmin ? <LoaderCircle className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
                    绑定管理员身份
                  </Button>
                </div>
              </SettingsSection>

              <SettingsSection
                title="基础配置"
                description="常用基础项放这里，默认展开，先改这里最省事。"
                isOpen={openSections.basic}
                onToggle={() => toggleSection("basic")}
              >
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm text-stone-700">账号刷新间隔</label>
                    <Input
                      value={String(config?.refresh_account_interval_minute || "")}
                      onChange={(event) => setRefreshAccountIntervalMinute(event.target.value)}
                      placeholder="分钟"
                      className="h-10 rounded-xl border-stone-200 bg-white"
                    />
                    <p className="text-xs text-stone-500">单位分钟，控制账号自动刷新频率。</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm text-stone-700">全局代理</label>
                    <Input
                      value={String(config?.proxy || "")}
                      onChange={(event) => {
                        setProxy(event.target.value);
                        setProxyTestResult(null);
                      }}
                      placeholder="http://127.0.0.1:7890"
                      className="h-10 rounded-xl border-stone-200 bg-white"
                    />
                    <p className="text-xs text-stone-500">留空表示不使用代理。</p>
                    {proxyTestResult ? (
                      <div
                        className={`rounded-xl border px-3 py-2 text-xs leading-6 ${
                          proxyTestResult.ok
                            ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                            : "border-rose-200 bg-rose-50 text-rose-800"
                        }`}
                      >
                        {proxyTestResult.ok
                          ? `代理可用：HTTP ${proxyTestResult.status}，用时 ${proxyTestResult.latency_ms} ms`
                          : `代理不可用：${proxyTestResult.error ?? "未知错误"}（用时 ${proxyTestResult.latency_ms} ms）`}
                      </div>
                    ) : null}
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-xl border-stone-200 bg-white px-4 text-stone-700"
                        onClick={() => void handleTestProxy()}
                        disabled={isTestingProxy}
                      >
                        {isTestingProxy ? <LoaderCircle className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                        测试代理
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm text-stone-700">图片访问地址</label>
                    <Input
                      value={String(config?.base_url || "")}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      placeholder="https://example.com"
                      className="h-10 rounded-xl border-stone-200 bg-white"
                    />
                    <p className="text-xs text-stone-500">用于生成图片结果的访问前缀地址。</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm text-stone-700">图片自动清理</label>
                    <Input
                      value={String(config?.image_retention_days || "")}
                      onChange={(event) => setImageRetentionDays(event.target.value)}
                      placeholder="30"
                      className="h-10 rounded-xl border-stone-200 bg-white"
                    />
                    <p className="text-xs text-stone-500">自动删除多少天前的本地图片。</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm text-stone-700">图片轮询超时</label>
                    <Input
                      value={String(config?.image_poll_timeout_secs || "")}
                      onChange={(event) => setImagePollTimeoutSecs(event.target.value)}
                      placeholder="120"
                      className="h-10 rounded-xl border-stone-200 bg-white"
                    />
                    <p className="text-xs text-stone-500">单位秒，等待 ChatGPT 图片结果的最长时间。</p>
                  </div>
                </div>
              </SettingsSection>
            </>
          ) : null}

          {activeTab === "image" ? (
            <SettingsSection
              title="生图方法与上游"
              description="切换出图方式、管理兼容上游、查看上游运行状态和额度。"
              isOpen={openSections.image}
              onToggle={() => toggleSection("image")}
            >
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm text-stone-700">生图方法</label>
                  <Select
                    value={String(config?.image_generation_strategy || "chatgpt2api")}
                    onValueChange={(value) =>
                      setImageGenerationStrategy(
                        value === "gpt2api" || value === "codex_responses" || value === "openai_compatible"
                          ? value
                          : "chatgpt2api",
                      )
                    }
                  >
                    <SelectTrigger className="h-10 rounded-xl border-stone-200 bg-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="chatgpt2api">当前项目方式：gpt-image-2 固定走 gpt-5-3</SelectItem>
                      <SelectItem value="gpt2api">432539/gpt2api 方式：Free 号走 auto，付费号走 gpt-5-3</SelectItem>
                      <SelectItem value="codex_responses">Codex Responses：走 gpt-image-2 图片工具链</SelectItem>
                      <SelectItem value="openai_compatible">OpenAI兼容 API 上游：直接请求自定义 base_url</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-stone-500">
                    选择 OpenAI兼容 API 上游后，图片请求会直接转发到自定义 base_url；其他方式继续走本地 ChatGPT 账号池。
                  </p>
                </div>

                {config?.image_generation_strategy === "openai_compatible" ? (
                  <div className="space-y-4 rounded-xl border border-stone-200 bg-white p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-stone-800">OpenAI兼容图片上游</div>
                        <p className="mt-1 text-xs text-stone-500">按列表顺序尝试；每个上游单独设置并发上限，某个 key 失败会自动切到下一个。</p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-xl border-stone-200 bg-white px-4 text-stone-700"
                        onClick={addImageApiUpstream}
                      >
                        <Plus className="size-4" />
                        添加上游
                      </Button>
                    </div>
                    {(config?.image_generation_api_upstreams || []).map((upstream, index) => (
                      <div key={upstream.id} className="space-y-3 rounded-2xl border border-stone-100 bg-stone-50 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <label className="flex items-center gap-2 text-sm font-medium text-stone-800">
                            <Checkbox
                              checked={upstream.enabled !== false}
                              onCheckedChange={(checked) => updateImageApiUpstream(upstream.id, { enabled: Boolean(checked) })}
                            />
                            启用上游 {index + 1}
                          </label>
                          <Button
                            type="button"
                            variant="outline"
                            className="h-8 rounded-xl border-rose-200 bg-white px-3 text-rose-600 hover:bg-rose-50"
                            onClick={() => deleteImageApiUpstream(upstream.id)}
                          >
                            <Trash2 className="size-4" />
                            删除
                          </Button>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className={`rounded-full px-3 py-1 ${runtimeBadgeTone(upstreamRuntimeStatuses[upstream.id])}`}>
                            {runtimeBadgeLabel(upstreamRuntimeStatuses[upstream.id])}
                          </span>
                          <span className="rounded-full bg-stone-100 px-3 py-1 text-stone-600">
                            配置上限 {Number(upstream.max_concurrency || 0) > 0 ? upstream.max_concurrency : 8}
                          </span>
                        </div>
                        <div className="grid gap-3 md:grid-cols-2">
                          <div>
                            <label className="text-sm text-stone-700">名称</label>
                            <Input
                              value={upstream.name}
                              onChange={(event) => updateImageApiUpstream(upstream.id, { name: event.target.value })}
                              placeholder={`上游 ${index + 1}`}
                              className="mt-2 h-10 rounded-xl border-stone-200 bg-white"
                            />
                          </div>
                          <div>
                            <label className="text-sm text-stone-700">上游图片模型</label>
                            <Input
                              value={upstream.model}
                              onChange={(event) => updateImageApiUpstream(upstream.id, { model: event.target.value })}
                              placeholder="gpt-image-2"
                              className="mt-2 h-10 rounded-xl border-stone-200 bg-white"
                            />
                          </div>
                          <div>
                            <label className="text-sm text-stone-700">并发上限</label>
                            <Input
                              value={String(upstream.max_concurrency || "")}
                              onChange={(event) => updateImageApiUpstream(upstream.id, { max_concurrency: event.target.value })}
                              placeholder="8"
                              className="mt-2 h-10 rounded-xl border-stone-200 bg-white"
                            />
                          </div>
                        </div>
                        <div>
                          <label className="text-sm text-stone-700">Base URL</label>
                          <Input
                            value={upstream.base_url}
                            onChange={(event) => updateImageApiUpstream(upstream.id, { base_url: event.target.value })}
                            placeholder="http://your-sub2api-host:8010"
                            className="mt-2 h-10 rounded-xl border-stone-200 bg-white"
                          />
                          <p className="mt-1 text-xs text-stone-500">系统会请求 /v1/images/generations、/v1/images/edits、/v1/usage。</p>
                        </div>
                        <div>
                          <label className="text-sm text-stone-700">API Key</label>
                          <Input
                            type="password"
                            value={String(upstream.api_key || "")}
                            onChange={(event) => updateImageApiUpstream(upstream.id, { api_key: event.target.value })}
                            placeholder={upstream.api_key_set ? "已保存，留空不修改" : "sk-..."}
                            className="mt-2 h-10 rounded-xl border-stone-200 bg-white"
                            autoComplete="off"
                          />
                          <p className="mt-1 text-xs text-stone-500">保存后不会回显；留空会保留旧 key。新填/修改 key 后请先保存再查额度。</p>
                        </div>
                        <div className="space-y-1 text-xs text-stone-500">
                          <div>这个上游自己能抗多少并发就填多少；满了以后会自动排队，也会优先尝试其他还有空位的上游。</div>
                          <div>{formatUpstreamRuntimeStatus(upstreamRuntimeStatuses[upstream.id])}</div>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="text-xs leading-6 text-stone-500">
                            {upstreamUsageResults[upstream.id] || (upstream.api_key_set ? "可查询 /v1/usage 额度" : "未保存 key")}
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            className="h-9 rounded-xl border-stone-200 bg-white px-4 text-stone-700"
                            onClick={() => void handleTestUpstreamUsage(upstream.id)}
                            disabled={testingUpstreamId === upstream.id || !upstream.api_key_set || Boolean(upstream.api_key)}
                          >
                            {testingUpstreamId === upstream.id ? <LoaderCircle className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                            查额度
                          </Button>
                        </div>
                        <div className="space-y-3 rounded-xl border border-stone-200 bg-white p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <label className="text-sm text-stone-700">测试出图提示词</label>
                            <span className="text-xs text-stone-500">只测试当前上游，不走自动切换。</span>
                          </div>
                          <Textarea
                            value={upstreamTestPrompts[upstream.id] ?? DEFAULT_UPSTREAM_TEST_PROMPT}
                            onChange={(event) =>
                              setUpstreamTestPrompts((current) => ({
                                ...current,
                                [upstream.id]: event.target.value,
                              }))
                            }
                            className="min-h-24 rounded-xl border-stone-200 bg-stone-50"
                          />
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="text-xs leading-6 text-stone-500">
                              {upstream.api_key_set && !upstream.api_key ? "可测试 /v1/images/generations 出图" : "保存 key 后可测试出图"}
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              className="h-9 rounded-xl border-stone-200 bg-white px-4 text-stone-700"
                              onClick={() => void handleTestUpstreamImage(upstream.id)}
                              disabled={testingImageUpstreamId === upstream.id || !upstream.api_key_set || Boolean(upstream.api_key)}
                            >
                              {testingImageUpstreamId === upstream.id ? <LoaderCircle className="size-4 animate-spin" /> : <ImageIcon className="size-4" />}
                              测试出图
                            </Button>
                          </div>
                          {upstreamImageTestResults[upstream.id] ? (
                            <div
                              className={`rounded-xl border px-3 py-3 text-xs leading-6 ${
                                upstreamImageTestResults[upstream.id].ok
                                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                                  : "border-rose-200 bg-rose-50 text-rose-800"
                              }`}
                            >
                              <div>{upstreamImageTestResults[upstream.id].message}</div>
                              {upstreamImageTestResults[upstream.id].imageUrl ? (
                                <div className="mt-2 space-y-2">
                                  <a
                                    className="font-medium underline"
                                    href={upstreamImageTestResults[upstream.id].imageUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    打开测试图片
                                  </a>
                                  <img
                                    src={upstreamImageTestResults[upstream.id].imageUrl}
                                    alt="上游测试出图结果"
                                    className="max-h-64 rounded-xl border border-emerald-200 bg-white object-contain"
                                  />
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                    {(config?.image_generation_api_upstreams || []).length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-stone-200 bg-stone-50 px-4 py-6 text-center text-sm text-stone-500">
                        还没有上游，先点“添加上游”。
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </SettingsSection>
          ) : null}

          {activeTab === "registration" ? (
            <SettingsSection
              title="用户注册设置"
              description="这里控制 `/signup` 普通用户自助注册，不影响 `/register` 注册机。"
              isOpen={openSections.userRegistration}
              onToggle={() => toggleSection("userRegistration")}
            >
              <div className="space-y-5">
                <div className="grid gap-3 lg:grid-cols-[1.05fr_0.95fr]">
                  <label className="flex items-start gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700">
                    <Checkbox
                      checked={config?.user_registration_enabled !== false}
                      onCheckedChange={(checked) => setUserRegistrationEnabled(Boolean(checked))}
                    />
                    <span>
                      <span className="block font-medium text-stone-800">允许普通用户注册</span>
                      <span className="mt-1 block text-xs text-stone-500">关闭后 `/auth/register` 会拒绝新用户；管理员和已有用户登录不受影响。</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700">
                    <Checkbox
                      checked={Boolean(config?.user_registration_name_required)}
                      onCheckedChange={(checked) => setUserRegistrationBooleanField("user_registration_name_required", Boolean(checked))}
                    />
                    <span>
                      <span className="block font-medium text-stone-800">注册时必须填写昵称</span>
                      <span className="mt-1 block text-xs text-stone-500">关闭时昵称可为空，系统会使用邮箱前缀。</span>
                    </span>
                  </label>
                </div>

                <div className="grid gap-3 md:grid-cols-3">
                  <div className="space-y-2">
                    <label className="text-sm text-stone-700">邀请码</label>
                    <Input
                      value={String(config?.user_registration_invite_code ?? "")}
                      onChange={(event) => setUserRegistrationField("user_registration_invite_code", event.target.value)}
                      placeholder="留空则不需要邀请码"
                      className="h-10 rounded-xl border-stone-200 bg-white"
                    />
                    <p className="text-xs text-stone-500">填写后，用户注册页必须输入一致的邀请码。</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm text-stone-700">注册用户总上限</label>
                    <Input
                      value={String(config?.user_registration_total_user_limit ?? "")}
                      onChange={(event) => setUserRegistrationField("user_registration_total_user_limit", event.target.value)}
                      placeholder="0 表示不限"
                      className="h-10 rounded-xl border-stone-200 bg-white"
                    />
                    <p className="text-xs text-stone-500">只统计普通用户，不统计管理员。</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm text-stone-700">密码最小长度</label>
                    <Input
                      value={String(config?.user_registration_password_min_length ?? "")}
                      onChange={(event) => setUserRegistrationField("user_registration_password_min_length", event.target.value)}
                      placeholder="6"
                      className="h-10 rounded-xl border-stone-200 bg-white"
                    />
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm text-stone-700">允许注册邮箱域名</label>
                    <Textarea
                      value={textareaListValue(config?.user_registration_allowed_email_domains)}
                      onChange={(event) => setUserRegistrationField("user_registration_allowed_email_domains", event.target.value)}
                      placeholder={"留空表示不限\nexample.com\n*.example.com"}
                      className="min-h-28 rounded-xl border-stone-200 bg-white font-mono text-xs shadow-none"
                    />
                    <p className="text-xs text-stone-500">一行一个。填写后，只允许这些域名注册。</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm text-stone-700">禁止注册邮箱域名</label>
                    <Textarea
                      value={textareaListValue(config?.user_registration_blocked_email_domains)}
                      onChange={(event) => setUserRegistrationField("user_registration_blocked_email_domains", event.target.value)}
                      placeholder={"例如临时邮箱域名\nmailinator.com\n*.trashmail.com"}
                      className="min-h-28 rounded-xl border-stone-200 bg-white font-mono text-xs shadow-none"
                    />
                    <p className="text-xs text-stone-500">一行一个。禁止列表优先于允许列表。</p>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-4">
                  <div className="space-y-2">
                    <label className="text-sm text-stone-700">新用户初始积分</label>
                    <Input
                      value={String(config?.user_registration_default_points ?? "")}
                      onChange={(event) => setUserRegistrationField("user_registration_default_points", event.target.value)}
                      placeholder="50"
                      className="h-10 rounded-xl border-stone-200 bg-white"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm text-stone-700">新用户初始图币</label>
                    <Input
                      value={String(config?.user_registration_default_paid_coins ?? "")}
                      onChange={(event) => setUserRegistrationField("user_registration_default_paid_coins", event.target.value)}
                      placeholder="0"
                      className="h-10 rounded-xl border-stone-200 bg-white"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm text-stone-700">高清体验次数</label>
                    <Input
                      value={String(config?.user_registration_default_paid_bonus_uses ?? "")}
                      onChange={(event) => setUserRegistrationField("user_registration_default_paid_bonus_uses", event.target.value)}
                      placeholder="1"
                      className="h-10 rounded-xl border-stone-200 bg-white"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm text-stone-700">默认生图模式</label>
                    <Select
                      value={String(config?.user_registration_default_preferred_image_mode || "free")}
                      onValueChange={(value) => setUserRegistrationField("user_registration_default_preferred_image_mode", value)}
                    >
                      <SelectTrigger className="h-10 rounded-xl border-stone-200 bg-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="free">免费模式</SelectItem>
                        <SelectItem value="paid">高清模式</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </SettingsSection>
          ) : null}

          {activeTab === "security" ? (
            <>
              <SettingsSection
                title="登录 / 注册限流"
                description="命中后返回 429，并附带重试秒数。默认收起，只有需要调限流时再展开。"
                isOpen={openSections.rateLimit}
                onToggle={() => toggleSection("rateLimit")}
              >
                <div className="grid gap-4 lg:grid-cols-2">
                  {authRateLimitGroups.map((group) => (
                    <div key={group.title} className="space-y-3 rounded-2xl border border-stone-100 bg-stone-50 p-4">
                      <div>
                        <div className="text-sm font-medium text-stone-800">{group.title}</div>
                        <p className="mt-1 text-xs text-stone-500">{group.hint}</p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {group.fields.map((field) => (
                          <div key={field.key} className="space-y-2">
                            <label className="text-sm text-stone-700">{field.label}</label>
                            <Input
                              value={String(config?.[field.key] ?? "")}
                              onChange={(event) => setAuthRateLimitField(field.key, event.target.value)}
                              placeholder={field.placeholder}
                              className="h-10 rounded-xl border-stone-200 bg-white"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </SettingsSection>

              <SettingsSection
                title="账号清理策略"
                description="清理异常号、限流号这类开关统一放这里，默认收起。"
                isOpen={openSections.cleanup}
                onToggle={() => toggleSection("cleanup")}
              >
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex items-center gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700">
                    <Checkbox
                      checked={Boolean(config?.auto_remove_invalid_accounts)}
                      onCheckedChange={(checked) => setAutoRemoveInvalidAccounts(Boolean(checked))}
                    />
                    自动移除异常账号
                  </label>
                  <label className="flex items-center gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700">
                    <Checkbox
                      checked={Boolean(config?.auto_remove_rate_limited_accounts)}
                      onCheckedChange={(checked) => setAutoRemoveRateLimitedAccounts(Boolean(checked))}
                    />
                    自动移除限流账号
                  </label>
                </div>
              </SettingsSection>

              <SettingsSection
                title="请求过滤"
                description="可选敏感词和 AI 审核；默认关闭，配置后会在请求进入上游前拦截。"
                isOpen={openSections.filter}
                onToggle={() => toggleSection("filter")}
              >
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm text-stone-700">敏感词</label>
                    <Textarea
                      value={(config?.sensitive_words || []).join("\n")}
                      onChange={(event) => setSensitiveWordsText(event.target.value)}
                      placeholder="一行一个，留空则不启用敏感词过滤"
                      className="min-h-28 rounded-xl border-stone-200 bg-white font-mono text-xs shadow-none"
                    />
                    <p className="text-xs text-stone-500">命中任意一行都会直接拒绝本次任务。</p>
                  </div>
                  <div className="space-y-4 rounded-xl border border-stone-200 bg-white px-4 py-3">
                    <label className="flex items-center gap-3 text-sm text-stone-700">
                      <Checkbox
                        checked={Boolean(config?.ai_review?.enabled)}
                        onCheckedChange={(checked) => setAIReviewField("enabled", Boolean(checked))}
                      />
                      启用 AI 审核
                    </label>
                    <div className="grid gap-4 md:grid-cols-3">
                      <div className="space-y-2">
                        <label className="text-sm text-stone-700">Base URL</label>
                        <Input
                          value={String(config?.ai_review?.base_url || "")}
                          onChange={(event) => setAIReviewField("base_url", event.target.value)}
                          placeholder="https://api.openai.com"
                          className="h-10 rounded-xl border-stone-200 bg-white"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm text-stone-700">API Key</label>
                        <Input
                          value={String(config?.ai_review?.api_key || "")}
                          onChange={(event) => setAIReviewField("api_key", event.target.value)}
                          placeholder="sk-..."
                          className="h-10 rounded-xl border-stone-200 bg-white"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm text-stone-700">Model</label>
                        <Input
                          value={String(config?.ai_review?.model || "")}
                          onChange={(event) => setAIReviewField("model", event.target.value)}
                          placeholder="gpt-4.1-mini"
                          className="h-10 rounded-xl border-stone-200 bg-white"
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm text-stone-700">审核提示词</label>
                      <Textarea
                        value={String(config?.ai_review?.prompt || "")}
                        onChange={(event) => setAIReviewField("prompt", event.target.value)}
                        placeholder="判断用户请求是否允许。只回答 ALLOW 或 REJECT。"
                        className="min-h-24 rounded-xl border-stone-200 bg-white text-xs shadow-none"
                      />
                    </div>
                  </div>
                </div>
              </SettingsSection>

              <SettingsSection
                title="日志设置"
                description="控制台输出级别，默认收起，不用常改。"
                isOpen={openSections.logs}
                onToggle={() => toggleSection("logs")}
              >
                <div className="space-y-3 rounded-xl border border-stone-200 bg-white px-4 py-3">
                  <div>
                    <label className="text-sm text-stone-700">控制台日志级别</label>
                    <p className="mt-1 text-xs text-stone-500">不选择时使用默认 info / warning / error。</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {logLevelOptions.map((level) => (
                      <label key={level} className="flex items-center gap-2 text-sm capitalize text-stone-700">
                        <Checkbox
                          checked={Boolean(config?.log_levels?.includes(level))}
                          onCheckedChange={(checked) => setLogLevel(level, Boolean(checked))}
                        />
                        {level}
                      </label>
                    ))}
                  </div>
                </div>
              </SettingsSection>
            </>
          ) : null}
        </div>

        <div className="flex justify-end">
          <Button
            className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
            onClick={() => void saveConfig()}
            disabled={isSavingConfig}
          >
            {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
            保存
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
