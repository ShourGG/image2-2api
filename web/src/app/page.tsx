"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  CreditCard,
  Gift,
  ImageIcon,
  ShieldCheck,
  Sparkles,
  Wand2,
} from "lucide-react";

import { getDefaultRouteForRole, getStoredAuthSession, type StoredAuthSession } from "@/store/auth";

const featureCards = [
  {
    icon: Gift,
    title: "免费体验",
    text: "注册即可试用，适合日常灵感、草图和轻量创作。",
  },
  {
    icon: CreditCard,
    title: "充值高清",
    text: "充值后可选 2K / 4K 尺寸，适合海报、壁纸和精细画面。",
  },
  {
    icon: ShieldCheck,
    title: "作品保存",
    text: "生成结果自动保存到个人历史，可继续编辑、分享和下载。",
  },
];

const workSteps = [
  "输入提示词，也可以上传参考图继续编辑",
  "选择免费生成或充值高清",
  "生成结果自动保存到个人历史记录",
];

function HomeVisual() {
  return (
    <div className="relative mx-auto w-full max-w-[330px] sm:max-w-[520px]">
      <div className="absolute -left-8 top-10 size-24 rounded-full bg-amber-300/30 blur-3xl sm:size-32" />
      <div className="absolute -right-8 bottom-16 size-28 rounded-full bg-sky-300/30 blur-3xl sm:size-40" />
      <div className="relative overflow-hidden rounded-[30px] border border-white/80 bg-white/80 p-2.5 shadow-[0_28px_90px_-42px_rgba(15,23,42,0.5)] backdrop-blur sm:rounded-[34px] sm:p-3">
        <div className="overflow-hidden rounded-[24px] bg-stone-950 p-3 text-white sm:rounded-[26px] sm:p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="size-2.5 rounded-full bg-rose-400 sm:size-3" />
              <div className="size-2.5 rounded-full bg-amber-300 sm:size-3" />
              <div className="size-2.5 rounded-full bg-emerald-400 sm:size-3" />
            </div>
            <div className="rounded-full bg-white/10 px-3 py-1 text-[11px] text-white/70">2K / 4K</div>
          </div>

          <div className="mt-4 grid gap-3 sm:mt-5 sm:grid-cols-[1.1fr_0.9fr]">
            <div className="relative min-h-[210px] overflow-hidden rounded-[24px] bg-stone-900 sm:min-h-[260px] sm:rounded-3xl">
              <img
                src="/home-showcase.webp"
                alt="上游生成的国风商业海报示例"
                className="absolute inset-0 h-full w-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-stone-950/55 via-stone-950/10 to-white/0" />
              <div className="relative z-10 flex min-h-[210px] flex-col justify-between p-3 sm:min-h-[260px] sm:p-4">
                <div className="inline-flex w-fit items-center gap-2 rounded-full bg-white/80 px-3 py-1 text-xs font-medium text-stone-900">
                  <Sparkles className="size-3.5" />
                  上游生成图
                </div>
                <div>
                  <div className="space-y-2 rounded-[22px] bg-white/82 p-3 text-stone-950 shadow-xl backdrop-blur sm:rounded-3xl sm:p-4">
                    <div className="text-xs font-semibold sm:text-sm">真实 2K 标杆 · 国风商业海报</div>
                    <div className="h-2 w-5/6 rounded-full bg-stone-300/80" />
                    <div className="h-2 w-2/3 rounded-full bg-stone-300/80" />
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <div className="rounded-[24px] bg-white/10 p-3 sm:rounded-3xl sm:p-4">
                <div className="mb-3 flex items-center gap-2 text-xs font-semibold sm:text-sm">
                  <Wand2 className="size-4" />
                  创作设置
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-1">
                  <div className="rounded-2xl bg-white px-3 py-3 text-stone-950">
                    <div className="text-xs text-stone-500">尺寸</div>
                    <div className="text-sm font-semibold">2560x1440</div>
                  </div>
                  <div className="rounded-2xl bg-amber-300 px-3 py-3 text-stone-950">
                    <div className="text-xs text-stone-700">画质</div>
                    <div className="text-sm font-semibold">high</div>
                  </div>
                </div>
              </div>
              <div className="rounded-[24px] bg-white/10 p-3 sm:rounded-3xl sm:p-4">
                <div className="text-xs text-white/60">作品状态</div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div className="rounded-2xl bg-white/10 p-3">
                    <div className="text-lg font-bold">2K</div>
                    <div className="text-[11px] text-white/55">高清输出</div>
                  </div>
                  <div className="rounded-2xl bg-white/10 p-3">
                    <div className="text-lg font-bold">已保存</div>
                    <div className="text-[11px] text-white/55">历史记录</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  const [session, setSession] = useState<StoredAuthSession | null | undefined>(undefined);

  useEffect(() => {
    let active = true;

    const load = async () => {
      const storedSession = await getStoredAuthSession();
      if (active) {
        setSession(storedSession);
      }
    };

    void load();
    return () => {
      active = false;
    };
  }, []);

  const primaryHref = session ? getDefaultRouteForRole(session.role) : "/signup";
  const primaryLabel = session ? "进入画图台" : "立即注册";

  return (
    <section className="relative overflow-hidden rounded-[28px] border border-white/70 bg-white/55 px-4 pb-5 pt-5 shadow-[0_24px_90px_-54px_rgba(15,23,42,0.35)] backdrop-blur sm:rounded-[32px] sm:px-8 sm:py-12 lg:px-12">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent" />
      <div className="mb-5 flex items-center justify-between sm:hidden">
        <div className="inline-flex items-center gap-2 rounded-full bg-stone-950 px-3 py-1.5 text-xs font-semibold text-white">
          <Sparkles className="size-3.5" />
          shour生成图
        </div>
        <Link
          href={session ? "/account" : "/login"}
          className="rounded-full bg-white/80 px-3 py-1.5 text-xs font-semibold text-stone-600 shadow-sm"
        >
          {session ? "账户" : "登录"}
        </Link>
      </div>

      <div className="grid items-center gap-7 lg:grid-cols-[1fr_0.92fr] lg:gap-10">
        <div className="w-full min-w-0 max-w-3xl">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white/80 px-3 py-1.5 text-[11px] font-medium text-stone-600 shadow-sm sm:mb-5 sm:text-xs">
            <ImageIcon className="size-4" />
            免费试用 · 充值高清 · 自动保存
          </div>

          <h1 className="text-[38px] font-black leading-[0.96] tracking-[-0.045em] text-stone-950 sm:text-6xl sm:leading-none lg:text-7xl">
            把想法直接变成
            <span className="block bg-gradient-to-r from-stone-950 via-stone-700 to-amber-600 bg-clip-text text-transparent">
              高清图片。
            </span>
          </h1>

          <p className="mt-4 max-w-2xl text-[15px] leading-7 text-stone-600 sm:mt-5 sm:text-lg sm:leading-8">
            免费试用，充值后支持 2K / 4K 高清生成。作品自动保存，支持参考图继续编辑、分享和下载。
          </p>

          <div className="mt-5 grid grid-cols-[1.05fr_0.95fr] gap-2 sm:hidden">
            <Link
              href={primaryHref}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-stone-950 px-4 text-sm font-semibold text-white shadow-[0_18px_45px_-24px_rgba(15,23,42,0.65)]"
            >
              {primaryLabel}
              <ArrowRight className="size-4" />
            </Link>
            <Link
              href={session ? "/account" : "/login"}
              className="inline-flex h-12 items-center justify-center rounded-2xl border border-stone-200 bg-white/85 px-4 text-sm font-semibold text-stone-800"
            >
              {session ? "账户" : "登录"}
            </Link>
          </div>

          <div className="mt-5 grid grid-cols-3 gap-2 sm:hidden">
            {[
              ["50", "免费积分"],
              ["4K", "高清可用"],
              ["保存", "历史记录"],
            ].map(([value, label]) => (
              <div key={label} className="rounded-2xl bg-white/75 px-3 py-3 text-center shadow-sm">
                <div className="text-lg font-black text-stone-950">{value}</div>
                <div className="mt-0.5 text-[11px] text-stone-500">{label}</div>
              </div>
            ))}
          </div>

          <div className="mt-6 hidden flex-col gap-3 sm:mt-8 sm:flex sm:flex-row">
            <Link
              href={primaryHref}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-stone-950 px-6 text-sm font-semibold text-white shadow-[0_18px_45px_-24px_rgba(15,23,42,0.65)] transition hover:bg-stone-800 sm:h-12"
            >
              {primaryLabel}
              <ArrowRight className="size-4" />
            </Link>
            <Link
              href={session ? "/account" : "/login"}
              className="hidden h-12 items-center justify-center gap-2 rounded-2xl border border-stone-200 bg-white/85 px-6 text-sm font-semibold text-stone-800 transition hover:border-stone-300 hover:bg-white sm:inline-flex"
            >
              {session ? "查看账户" : "已有账号登录"}
            </Link>
          </div>
        </div>

        <HomeVisual />
      </div>

      <div className="mt-7 grid gap-3 sm:mt-9 sm:grid-cols-3">
        {featureCards.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.title} className="rounded-3xl border border-white/70 bg-white/70 p-4 shadow-sm">
              <div className="mb-3 flex size-10 items-center justify-center rounded-2xl bg-stone-100 text-stone-800">
                <Icon className="size-5" />
              </div>
              <div className="text-sm font-bold text-stone-950">{item.title}</div>
              <p className="mt-1.5 text-xs leading-5 text-stone-500">{item.text}</p>
            </div>
          );
        })}
      </div>

      <div className="mt-8 grid gap-4 border-t border-stone-200/70 pt-5 sm:mt-10 sm:pt-6 lg:grid-cols-[0.8fr_1.2fr]">
        <div>
          <div className="text-sm font-semibold text-stone-950">怎么用</div>
          <p className="mt-2 text-sm leading-7 text-stone-500">
            进入画图台后，输入提示词或上传参考图即可生成。作品会进入历史记录，方便继续编辑、复制地址或分享下载。
          </p>
        </div>
        <div className="grid gap-2 sm:gap-3 md:grid-cols-3">
          {workSteps.map((step, index) => (
            <div key={step} className="flex gap-3 rounded-2xl bg-stone-50/80 p-3 sm:p-4">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-stone-950 text-xs font-bold text-white">
                {index + 1}
              </div>
              <div className="text-sm leading-6 text-stone-700">{step}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-2 text-xs text-stone-500">
        {["免费积分", "签到奖励", "充值高清", "4K 可用", "作品历史", "分享下载"].map((item) => (
          <span key={item} className="inline-flex items-center gap-1 rounded-full bg-white/75 px-3 py-1.5">
            <CheckCircle2 className="size-3.5 text-emerald-600" />
            {item}
          </span>
        ))}
      </div>

      <div className="mt-8 rounded-3xl border border-white/70 bg-white/90 p-2 shadow-sm sm:hidden">
        {session ? (
          <Link
            href={primaryHref}
            className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-stone-950 text-sm font-semibold text-white"
          >
            {primaryLabel}
            <ArrowRight className="size-4" />
          </Link>
        ) : (
          <div className="grid grid-cols-[0.85fr_1.15fr] gap-2">
            <Link
              href="/login"
              className="flex h-12 items-center justify-center rounded-2xl bg-stone-100 text-sm font-semibold text-stone-800"
            >
              登录
            </Link>
            <Link
              href="/signup"
              className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-stone-950 text-sm font-semibold text-white"
            >
              立即注册
              <ArrowRight className="size-4" />
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}
