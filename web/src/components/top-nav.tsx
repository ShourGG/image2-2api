"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Github } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

import webConfig from "@/constants/common-env";
import { clearStoredAuthSession, getStoredAuthSession, type StoredAuthSession } from "@/store/auth";
import { cn } from "@/lib/utils";

const adminNavItems = [
  { href: "/image", label: "画图" },
  { href: "/account", label: "账号信息" },
  { href: "/accounts", label: "号池管理" },
  { href: "/register", label: "注册机" },
  { href: "/image-manager", label: "图片管理" },
  { href: "/logs", label: "日志管理" },
  { href: "/settings", label: "设置" },
];

const userNavItems = [
  { href: "/image", label: "画图" },
  { href: "/logs", label: "日志管理" },
  { href: "/account", label: "账号信息" },
];

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<StoredAuthSession | null | undefined>(undefined);

  useEffect(() => {
    let active = true;

    const load = async () => {
      if (pathname === "/login" || pathname === "/signup") {
        if (!active) {
          return;
        }
        setSession(null);
        return;
      }

      const storedSession = await getStoredAuthSession();
      if (!active) {
        return;
      }
      setSession(storedSession);
    };

    void load();
    return () => {
      active = false;
    };
  }, [pathname]);

  const handleLogout = async () => {
    await clearStoredAuthSession();
    router.replace("/login");
  };

  if (pathname === "/login" || pathname === "/signup" || session === undefined || !session) {
    return null;
  }

  const navItems = session.role === "admin" ? adminNavItems : userNavItems;
  const roleLabel = session.role === "admin" ? "管理员" : "普通用户";

  return (
    <header className="rounded-2xl border border-white/80 bg-white/75 shadow-[0_18px_60px_-44px_rgba(15,23,42,0.45)] backdrop-blur-xl">
      <div className="flex min-h-14 flex-col gap-2 px-3 py-2 sm:h-14 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-4 sm:py-0">
        <div className="flex items-center justify-between gap-2 sm:justify-start sm:gap-3">
          <Link
            href="/image"
            className="inline-flex shrink-0 items-center gap-2 rounded-xl px-1 py-1 text-stone-950 transition hover:bg-stone-100/70"
          >
            <img src="/shour-logo.svg" alt="" className="size-8 rounded-xl shadow-sm" />
            <span className="flex flex-col leading-none">
              <span className="text-[15px] font-semibold tracking-tight">shour生成图</span>
              <span className="mt-1 hidden text-[10px] font-medium uppercase tracking-[0.18em] text-stone-400 sm:block">
                Image Studio
              </span>
            </span>
          </Link>
          <a
            href="https://github.com/basketikun/chatgpt2api"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-sm text-stone-400 transition hover:bg-stone-100/80 hover:text-stone-700"
            aria-label="GitHub repository"
          >
            <Github className="size-4" />
            <span className="hidden md:inline">GitHub</span>
          </a>
          <button
            type="button"
            className="ml-auto shrink-0 py-1 text-xs text-stone-400 transition hover:text-stone-700 sm:hidden"
            onClick={() => void handleLogout()}
          >
            退出
          </button>
        </div>
        <nav className="hide-scrollbar -mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1 sm:mx-0 sm:justify-center sm:gap-1.5 sm:overflow-visible sm:px-0">
          {navItems.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "relative shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] font-medium transition sm:px-3.5 sm:text-sm",
                  active
                    ? "bg-stone-950 text-white shadow-sm"
                    : "text-stone-500 hover:bg-stone-100/85 hover:text-stone-900",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="hidden items-center justify-end gap-2 sm:flex sm:gap-3">
          <span className="hidden rounded-full bg-stone-100 px-2.5 py-1 text-[10px] font-medium text-stone-500 sm:inline-block sm:text-[11px]">
            {roleLabel}
          </span>
          <span className="hidden rounded-full bg-stone-100 px-2.5 py-1 text-[10px] font-medium text-stone-500 sm:inline-block sm:text-[11px]">
            v{webConfig.appVersion}
          </span>
          <button
            type="button"
            className="rounded-full px-2 py-1 text-xs text-stone-400 transition hover:bg-stone-100 hover:text-stone-700 sm:text-sm"
            onClick={() => void handleLogout()}
          >
            退出
          </button>
        </div>
      </div>
    </header>
  );
}
