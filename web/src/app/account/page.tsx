"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarCheck2, CreditCard, LoaderCircle, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  fetchCurrentUser,
  gambleCheckin,
  normalCheckin,
  type CheckinHistoryEntry,
  type CurrentUser,
  type ImageQuality,
  type ImageSizeTier,
  type MeResponse,
} from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import type { StoredAuthSession } from "@/store/auth";

function formatDateTime(value?: string | null) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatPoints(value?: number | null) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) {
    return "0";
  }
  return numeric.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

const DEFAULT_IMAGE_POINT_COST_TABLE: Record<ImageSizeTier, Record<ImageQuality, number>> = {
  normal: { standard: 5, high: 20, xhigh: 25 },
  "2k": { standard: 15, high: 40, xhigh: 50 },
  "4k": { standard: 30, high: 80, xhigh: 100 },
};

const DEFAULT_PAID_COIN_COST_TABLE: Record<ImageSizeTier, Record<ImageQuality, number>> = {
  normal: { standard: 50, high: 80, xhigh: 100 },
  "2k": { standard: 100, high: 150, xhigh: 200 },
  "4k": { standard: 200, high: 350, xhigh: 500 },
};

function formatSignedPoints(value?: number | null) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric === 0) {
    return "0";
  }
  return `${numeric > 0 ? "+" : ""}${formatPoints(numeric)}`;
}

function formatSignedMultiplier(value?: number | null) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric === 0) {
    return "0";
  }
  return `${numeric > 0 ? "+" : ""}${formatPoints(numeric)}`;
}

function nearlyEqual(left: number, right: number) {
  return Math.abs(left - right) < 0.001;
}

function authMethodLabel(session: StoredAuthSession) {
  if (session.role === "user") {
    return "邮箱密码会话";
  }
  if (session.key.startsWith("usr-")) {
    return "管理员账号密码";
  }
  return session.key.startsWith("sk-") ? "API Key" : "管理员会话";
}

function roleLabel(role: string) {
  return role === "admin" ? "管理员" : "普通用户";
}

function checkinModeLabel(mode?: string | null) {
  if (mode === "normal") {
    return "普通签到";
  }
  if (mode === "gamble") {
    return "赌狗签到";
  }
  return "未签到";
}

function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-stone-100 py-3 last:border-b-0">
      <div className="text-sm text-stone-500">{label}</div>
      <div className="max-w-[65%] text-right text-sm font-medium break-all text-stone-800">{value || "—"}</div>
    </div>
  );
}

function CheckinHistoryCard({ items }: { items: CheckinHistoryEntry[] }) {
  return (
    <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
      <CardContent className="p-6">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-stone-100">
            <CalendarCheck2 className="size-5 text-stone-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">签到记录</h2>
            <p className="text-sm text-stone-500">仅展示最近的签到结算记录。</p>
          </div>
        </div>

        {items.length === 0 ? (
          <div className="rounded-xl bg-stone-50 px-4 py-6 text-sm text-stone-500">
            还没有签到记录，今天可以先来一发普通签到或者赌狗签到。
          </div>
        ) : (
          <div className="space-y-3">
            {items.map((entry, index) => (
              <div key={`${entry.date}-${entry.mode}-${index}`} className="rounded-xl border border-stone-200 bg-white px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={entry.mode === "gamble" ? "warning" : "secondary"}
                      className="rounded-md"
                    >
                      {checkinModeLabel(entry.mode)}
                    </Badge>
                    <span className="text-sm text-stone-500">{formatDateTime(entry.at || entry.date)}</span>
                  </div>
                  <div className={`text-sm font-semibold ${entry.change >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                    {formatSignedPoints(entry.change)} 积分
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-stone-500">
                  <span>签到前 {formatPoints(entry.points_before)} 分</span>
                  <span>签到后 {formatPoints(entry.points_after)} 分</span>
                  {entry.mode === "gamble" ? <span>下注 {formatPoints(entry.bet)} 分</span> : null}
                  {entry.mode === "gamble" ? <span>最大倍率 {formatPoints(entry.max_multiplier)}</span> : null}
                  {entry.mode === "gamble" ? <span>实际倍率 {formatSignedMultiplier(entry.actual_multiplier)}</span> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AccountPageContent({ session }: { session: StoredAuthSession }) {
  const [payload, setPayload] = useState<MeResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isNormalSubmitting, setIsNormalSubmitting] = useState(false);
  const [isGambleSubmitting, setIsGambleSubmitting] = useState(false);
  const [bet, setBet] = useState("10");
  const [maxMultiplier, setMaxMultiplier] = useState("1");

  useEffect(() => {
    let active = true;

    const load = async () => {
      setIsLoading(true);
      try {
        const data = await fetchCurrentUser();
        if (!active) {
          return;
        }
        setPayload(data);
        if (data.checkins?.rules?.default_bet) {
          setBet(formatPoints(data.checkins.rules.default_bet));
        }
      } catch (error) {
        if (!active) {
          return;
        }
        toast.error(error instanceof Error ? error.message : "加载账号信息失败");
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    };

    void load();
    return () => {
      active = false;
    };
  }, []);

  const currentUser: CurrentUser = payload?.item || {
    id: session.subjectId,
    name: session.name,
    role: session.role,
  };
  const permissions = payload?.permissions || [];
  const billing = payload?.billing || {
    mode: session.role === "user" ? "points" : "account_pool",
    image_point_cost: 5,
    image_point_costs: { standard: 5, high: 20, xhigh: 25 },
    image_point_cost_table: DEFAULT_IMAGE_POINT_COST_TABLE,
    paid_coin_cost_table: DEFAULT_PAID_COIN_COST_TABLE,
    coin_exchange_rate: 100,
    default_paid_bonus_uses: 1,
    default_user_points: 50,
  };
  const imagePointCostTable = {
    normal: {
      ...DEFAULT_IMAGE_POINT_COST_TABLE.normal,
      ...(billing.image_point_costs || {}),
      ...(billing.image_point_cost_table?.normal || {}),
    },
    "2k": {
      ...DEFAULT_IMAGE_POINT_COST_TABLE["2k"],
      ...(billing.image_point_cost_table?.["2k"] || {}),
    },
    "4k": {
      ...DEFAULT_IMAGE_POINT_COST_TABLE["4k"],
      ...(billing.image_point_cost_table?.["4k"] || {}),
    },
  };
  const imageCostSummary = [
    `免费普通标准 ${formatPoints(imagePointCostTable.normal.standard)} 分/张`,
  ].join("，");
  const paidCoinCostTable = {
    normal: {
      ...DEFAULT_PAID_COIN_COST_TABLE.normal,
      ...(billing.paid_coin_cost_table?.normal || {}),
    },
    "2k": {
      ...DEFAULT_PAID_COIN_COST_TABLE["2k"],
      ...(billing.paid_coin_cost_table?.["2k"] || {}),
    },
    "4k": {
      ...DEFAULT_PAID_COIN_COST_TABLE["4k"],
      ...(billing.paid_coin_cost_table?.["4k"] || {}),
    },
  };
  const paidCostSummary = [
    `普通 ${formatPoints(paidCoinCostTable.normal.standard)}/${formatPoints(paidCoinCostTable.normal.high)} 图币`,
    `2K ${formatPoints(paidCoinCostTable["2k"].standard)}/${formatPoints(paidCoinCostTable["2k"].high)} 图币`,
    `4K ${formatPoints(paidCoinCostTable["4k"].standard)}/${formatPoints(paidCoinCostTable["4k"].high)} 图币`,
  ].join("，");
  const checkins = payload?.checkins;
  const points = Math.max(0, Number(currentUser.points || 0));
  const paidCoins = Math.max(0, Number(currentUser.paid_coins || 0));
  const paidBonusUses = Math.max(0, Number(currentUser.paid_bonus_uses || 0));
  const reservedPoints = Number(checkins?.rules.min_reserved_points || 10);
  const availableRisk = Math.max(0, points - reservedPoints);
  const betValue = Number(bet || 0);
  const safeMaxMultiplier = useMemo(() => {
    if (!Number.isFinite(betValue) || betValue <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(points, availableRisk / betValue));
  }, [availableRisk, betValue, points]);
  const multiplierPresetOptions = useMemo(() => {
    if (safeMaxMultiplier <= 0) {
      return [];
    }
    const presets = [
      { label: "保守 1x", value: 1 },
      { label: "稳一点 1.5x", value: 1.5 },
      { label: "常规 2x", value: 2 },
      { label: "激进 3x", value: 3 },
      { label: "狠一点 5x", value: 5 },
    ].filter((item) => item.value <= safeMaxMultiplier + 0.001);

    if (!presets.some((item) => nearlyEqual(item.value, safeMaxMultiplier))) {
      presets.push({
        label: `当前上限 ${formatPoints(safeMaxMultiplier)}x`,
        value: safeMaxMultiplier,
      });
    }
    return presets;
  }, [safeMaxMultiplier]);
  const checkinStats = checkins?.stats || {
    total_count: Number(currentUser.checkin_total_count || 0),
    normal_count: Number(currentUser.checkin_normal_count || 0),
    gamble_count: Number(currentUser.checkin_gamble_count || 0),
    total_change: Number(currentUser.checkin_total_change || 0),
  };

  const remainingImages = useMemo(() => {
    if (imagePointCostTable.normal.standard <= 0) {
      return 0;
    }
    return Math.floor(points / imagePointCostTable.normal.standard);
  }, [imagePointCostTable.normal.standard, points]);
  const paidRemainingImages = useMemo(() => {
    if (paidCoinCostTable.normal.high <= 0) {
      return paidBonusUses;
    }
    return paidBonusUses + Math.floor(paidCoins / paidCoinCostTable.normal.high);
  }, [paidBonusUses, paidCoinCostTable.normal.high, paidCoins]);

  const metricCards = session.role === "user"
    ? [
        {
          label: "当前积分",
          value: `${formatPoints(points)} 分`,
          hint: `默认 ${formatPoints(billing.default_user_points)} 分`,
          icon: CreditCard,
        },
        {
          label: "还能生成",
          value: `${remainingImages} 张`,
          hint: `免费普通标准 ${formatPoints(imagePointCostTable.normal.standard)} 分/张`,
          icon: Sparkles,
        },
        {
          label: "图币余额",
          value: `${formatPoints(paidCoins)} 图币`,
          hint: `充值高清约 ${paidRemainingImages} 张`,
          icon: Sparkles,
        },
        {
          label: "体验券",
          value: `${paidBonusUses} 次`,
          hint: `默认 ${billing.default_paid_bonus_uses ?? 1} 次`,
          icon: CreditCard,
        },
        {
          label: "今日签到",
          value: checkins?.checked_in_today ? "已签到" : "未签到",
          hint: checkins?.checked_in_today
            ? checkinModeLabel(checkins.last_checkin_mode)
            : `普通签到 +${formatPoints(checkins?.rules.normal_reward || 1.25)} 分`,
          icon: CalendarCheck2,
        },
        {
          label: "累计签到",
          value: `${checkinStats.total_count} 次`,
          hint: `净变动 ${formatSignedPoints(checkinStats.total_change)} 分`,
          icon: ShieldCheck,
        },
      ]
    : [
        { label: "当前身份", value: roleLabel(currentUser.role), hint: authMethodLabel(session), icon: UserRound },
        { label: "可访问模块", value: `${permissions.length} 项`, hint: "当前会话权限", icon: ShieldCheck },
        { label: "号池模式", value: "全局可用池", hint: "哪个号能用就用哪个", icon: Sparkles },
      ];

  const handleNormalCheckin = async () => {
    setIsNormalSubmitting(true);
    try {
      const data = await normalCheckin();
      setPayload(data);
      const reward = data.checkins?.latest_result?.change ?? data.checkins?.rules.normal_reward ?? 1.25;
      toast.success(`普通签到成功，到账 ${formatPoints(reward)} 积分`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "普通签到失败");
    } finally {
      setIsNormalSubmitting(false);
    }
  };

  const handleGambleCheckin = async () => {
    const betValue = Number(bet || 0);
    const multiplierValue = Number(maxMultiplier || 0);
    if (!Number.isFinite(betValue) || betValue <= 0) {
      toast.error("请输入有效的下注积分");
      return;
    }
    if (!Number.isFinite(multiplierValue) || multiplierValue <= 0) {
      toast.error("请输入有效的最大倍率");
      return;
    }

    setIsGambleSubmitting(true);
    try {
      const data = await gambleCheckin({
        bet: betValue,
        max_multiplier: multiplierValue,
      });
      setPayload(data);
      const latest = data.checkins?.latest_result;
      if (latest) {
        toast.success(
          `赌狗签到已结算 ${formatSignedPoints(latest.change)} 积分，实际倍率 ${formatSignedMultiplier(latest.actual_multiplier)}`,
        );
      } else {
        toast.success("赌狗签到结算完成");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "赌狗签到失败");
    } finally {
      setIsGambleSubmitting(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <div className="text-xs font-semibold tracking-[0.18em] text-stone-500 uppercase">Account</div>
        <h1 className="text-2xl font-semibold tracking-tight">账号信息</h1>
        <p className="text-sm text-stone-500">
          {session.role === "user"
            ? "你的画图历史、本地会话、调用日志和签到记录都按当前账号隔离保存。"
            : "当前显示的是管理员会话信息与可访问模块概览。"}
        </p>
      </div>

      {isLoading && !payload ? (
        <div className="flex min-h-[30vh] items-center justify-center">
          <LoaderCircle className="size-5 animate-spin text-stone-400" />
        </div>
      ) : null}

      <div className={`grid gap-4 ${session.role === "user" ? "md:grid-cols-2 xl:grid-cols-4" : "md:grid-cols-3"} ${isLoading && !payload ? "hidden" : ""}`}>
        {metricCards.map((item) => {
          const Icon = item.icon;
          return (
            <Card key={item.label} className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
              <CardContent className="space-y-4 p-5">
                <div className="flex items-center justify-between">
                  <div className="text-sm text-stone-500">{item.label}</div>
                  <Icon className="size-4 text-stone-400" />
                </div>
                <div className="text-2xl font-semibold tracking-tight text-stone-900">{item.value}</div>
                <div className="text-xs text-stone-400">{item.hint}</div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className={`grid gap-4 ${session.role === "user" ? "lg:grid-cols-[1.08fr_0.92fr]" : "lg:grid-cols-[1.2fr_0.8fr]"} ${isLoading && !payload ? "hidden" : ""}`}>
        <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
          <CardContent className="p-6">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-stone-100">
                <UserRound className="size-5 text-stone-600" />
              </div>
              <div>
                <h2 className="text-lg font-semibold tracking-tight">基础资料</h2>
                <p className="text-sm text-stone-500">当前登录账号的基础信息与会话来源。</p>
              </div>
            </div>

            <div>
              <ProfileRow label="名称" value={String(currentUser.name || session.name || "")} />
              <ProfileRow label="邮箱" value={String(currentUser.email || "")} />
              <ProfileRow label="身份" value={roleLabel(currentUser.role)} />
              <ProfileRow label="会话方式" value={authMethodLabel(session)} />
              <ProfileRow label="账号 ID" value={String(currentUser.id || session.subjectId || "")} />
              <ProfileRow label="创建时间" value={formatDateTime(currentUser.created_at)} />
              <ProfileRow label="最近登录" value={formatDateTime(currentUser.last_login_at)} />
              <ProfileRow label="最近调用" value={formatDateTime(currentUser.last_used_at)} />
              {session.role === "user" ? <ProfileRow label="积分余额" value={`${formatPoints(points)} 分`} /> : null}
              {session.role === "user" ? <ProfileRow label="累计签到" value={`${checkinStats.total_count} 次`} /> : null}
              {session.role === "user" ? <ProfileRow label="普通签到" value={`${checkinStats.normal_count} 次`} /> : null}
              {session.role === "user" ? <ProfileRow label="赌狗签到" value={`${checkinStats.gamble_count} 次`} /> : null}
              {session.role === "user" ? <ProfileRow label="签到净变动" value={`${formatSignedPoints(checkinStats.total_change)} 分`} /> : null}
              <ProfileRow label="状态" value={currentUser.enabled === false ? "已禁用" : "正常"} />
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
            <CardContent className="p-6">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-xl bg-stone-100">
                  <ShieldCheck className="size-5 text-stone-600" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">权限范围</h2>
                  <p className="text-sm text-stone-500">当前账号允许访问的模块。</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {permissions.map((item) => (
                  <Badge key={item} variant="secondary" className="rounded-md bg-stone-100 px-3 py-1 text-stone-700">
                    {item}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>

          {session.role === "user" ? (
            <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
              <CardContent className="space-y-5 p-6">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-xl bg-stone-100">
                      <CalendarCheck2 className="size-5 text-stone-600" />
                    </div>
                    <div>
                      <h2 className="text-lg font-semibold tracking-tight">签到中心</h2>
                      <p className="text-sm text-stone-500">普通签到稳拿分，赌狗签到随机结算正负倍率。</p>
                    </div>
                  </div>
                  <Badge variant={checkins?.checked_in_today ? "success" : "warning"} className="rounded-md">
                    {checkins?.checked_in_today ? "今日已签" : "待签到"}
                  </Badge>
                </div>

                <div className="rounded-xl bg-stone-50 px-4 py-3 text-sm text-stone-600">
                  {checkins?.checked_in_today ? (
                    <>
                      今天已经完成 <span className="font-semibold text-stone-900">{checkinModeLabel(checkins.last_checkin_mode)}</span>
                      ，时间 {formatDateTime(checkins.last_checkin_at)}。
                    </>
                  ) : (
                    <>
                      今天还没签到。普通签到固定到账 <span className="font-semibold text-stone-900">{formatPoints(checkins?.rules.normal_reward || 1.25)}</span> 分。
                    </>
                  )}
                </div>

                <div className="grid gap-3">
                  <Button
                    type="button"
                    className="h-11 rounded-xl bg-stone-950 text-white hover:bg-stone-800"
                    onClick={() => void handleNormalCheckin()}
                    disabled={Boolean(checkins?.checked_in_today) || isNormalSubmitting || isGambleSubmitting}
                  >
                    {isNormalSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
                    普通签到 +{formatPoints(checkins?.rules.normal_reward || 1.25)} 积分
                  </Button>

                  <div className="rounded-2xl border border-stone-200 bg-white p-4">
                    <div className="space-y-1">
                      <div className="text-sm font-semibold text-stone-900">赌狗签到</div>
                      <p className="text-xs leading-5 text-stone-500">
                        你自己填下注积分和最大倍率，系统会在正负倍率里随机结算。最差结果也必须给自己留 {formatPoints(reservedPoints)} 分。
                      </p>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-stone-700">下注积分</label>
                        <Input
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={bet}
                          onChange={(event) => setBet(event.target.value)}
                          className="h-11 rounded-xl border-stone-200 bg-white"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-stone-700">最大倍率</label>
                        <Input
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={maxMultiplier}
                          onChange={(event) => setMaxMultiplier(event.target.value)}
                          max={safeMaxMultiplier > 0 ? formatPoints(safeMaxMultiplier) : undefined}
                          className="h-11 rounded-xl border-stone-200 bg-white"
                        />
                      </div>
                    </div>

                    <div className="grid gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        {multiplierPresetOptions.length > 0 ? (
                          multiplierPresetOptions.map((item) => {
                            const isActive = nearlyEqual(Number(maxMultiplier || 0), item.value);
                            return (
                              <Button
                                key={item.label}
                                type="button"
                                variant={isActive ? "secondary" : "outline"}
                                size="sm"
                                className={`rounded-xl ${isActive ? "bg-stone-900 text-white hover:bg-stone-800" : "border-stone-200 bg-white text-stone-700 hover:bg-stone-50"}`}
                                onClick={() => setMaxMultiplier(formatPoints(item.value))}
                              >
                                {item.label}
                              </Button>
                            );
                          })
                        ) : (
                          <div className="text-xs text-stone-500">先填下注积分，系统再给你可选倍率。</div>
                        )}
                      </div>
                      <div className="text-xs text-stone-500">
                        {safeMaxMultiplier > 0
                          ? `按你当前下注，最大倍率最高可填 ${formatPoints(safeMaxMultiplier)}x。建议新手先从 1x 或 1.5x 开始。`
                          : "当前下注还不合法，暂时无法计算可用倍率。"}
                      </div>
                    </div>

                    <div className="mt-4 grid gap-2 rounded-xl bg-stone-50 px-4 py-3 text-xs text-stone-500">
                      <div>当前积分：{formatPoints(points)} 分</div>
                      <div>账户保底：{formatPoints(reservedPoints)} 分</div>
                      <div>可承受最大风险：{formatPoints(availableRisk)} 分</div>
                      <div>限制：下注积分 × 最大倍率 ≤ {formatPoints(availableRisk)}</div>
                      <div>当前下注可用最大倍率：{safeMaxMultiplier > 0 ? `${formatPoints(safeMaxMultiplier)}x` : "—"}</div>
                      <div>倍率池：负 25% / 50% / 75% / 100%，正 25% / 50% / 75% / 100%</div>
                    </div>

                    <Button
                      type="button"
                      variant="outline"
                      className="mt-4 h-11 w-full rounded-xl border-stone-200 bg-white text-stone-800 hover:bg-stone-50"
                      onClick={() => void handleGambleCheckin()}
                      disabled={Boolean(checkins?.checked_in_today) || isNormalSubmitting || isGambleSubmitting}
                    >
                      {isGambleSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
                      赌狗签到结算
                    </Button>
                  </div>
                </div>

                <div className="rounded-xl bg-amber-50/80 px-4 py-4 text-sm text-amber-950">
                  <div className="mb-2 font-semibold">规则说明</div>
                  <ul className="space-y-1.5 text-sm leading-6">
                    {(checkins?.rules.summary || []).map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                    <li>赌狗签到校验规则：最大倍率不能高于当前账户积分，且下注积分 × 最大倍率不能超过当前积分减去 {formatPoints(reservedPoints)} 分。</li>
                  </ul>
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
            <CardContent className="p-6">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-xl bg-stone-100">
                  <CreditCard className="size-5 text-stone-600" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">计费与资源</h2>
                  <p className="text-sm text-stone-500">按当前账号类型展示资源规则。</p>
                </div>
              </div>

              {billing.mode === "points" ? (
                <div className="space-y-3 text-sm text-stone-600">
                  <div className="rounded-xl bg-stone-50 px-4 py-3">
                    免费生成：默认注册赠送 <span className="font-semibold text-stone-900">{formatPoints(billing.default_user_points)}</span> 分，走本地 Free 号池。
                  </div>
                  <div className="rounded-xl bg-stone-50 px-4 py-3">
                    免费扣分：<span className="font-semibold text-stone-900">{imageCostSummary}</span>。失败会自动回滚。
                  </div>
                  <div className="rounded-xl bg-stone-50 px-4 py-3">
                    按标准画质算，你当前约还能生成 <span className="font-semibold text-stone-900">{remainingImages}</span> 张图片。
                  </div>
                  <div className="rounded-xl bg-stone-50 px-4 py-3">
                    充值高清：<span className="font-semibold text-stone-900">1 元 = {billing.coin_exchange_rate ?? 100} 图币</span>，优先用体验券，再扣图币；体验券不限尺寸，4K 也可用。
                  </div>
                  <div className="rounded-xl bg-stone-50 px-4 py-3">
                    充值扣费：<span className="font-semibold text-stone-900">{paidCostSummary}</span>。失败会自动回滚。
                  </div>
                </div>
              ) : (
                <div className="space-y-3 text-sm text-stone-600">
                  <div className="rounded-xl bg-stone-50 px-4 py-3">
                    管理员不走积分扣费，直接使用全局账号池管理上游资源。
                  </div>
                  <div className="rounded-xl bg-stone-50 px-4 py-3">
                    当前画图采用“哪个上游号可用就用哪个”的策略，不固定绑定单个账号。
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {session.role === "user" && !isLoading ? <CheckinHistoryCard items={(checkins?.history || []).slice(0, 8)} /> : null}
    </section>
  );
}

export default function AccountPage() {
  const { isCheckingAuth, session } = useAuthGuard();

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <AccountPageContent session={session} />;
}
