"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, KeyRound, LoaderCircle, LockKeyhole, Mail, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fetchAdminSetupState, loginWithPassword, setupAdminAccount } from "@/lib/api";
import { useRedirectIfAuthenticated } from "@/lib/use-auth-guard";
import { getDefaultRouteForRole, setStoredAuthSession } from "@/store/auth";

export default function LoginPage() {
  const router = useRouter();
  const { isCheckingAuth } = useRedirectIfAuthenticated();
  const [setupRequired, setSetupRequired] = useState(false);
  const [isLoadingSetup, setIsLoadingSetup] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupName, setSetupName] = useState("");
  const [setupEmail, setSetupEmail] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [setupConfirmPassword, setSetupConfirmPassword] = useState("");
  const [setupKey, setSetupKey] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let active = true;

    const loadSetupState = async () => {
      try {
        const data = await fetchAdminSetupState();
        if (active) {
          setSetupRequired(Boolean(data.required));
        }
      } catch {
        if (active) {
          setSetupRequired(false);
        }
      } finally {
        if (active) {
          setIsLoadingSetup(false);
        }
      }
    };

    void loadSetupState();
    return () => {
      active = false;
    };
  }, []);

  const saveSessionAndRedirect = async (data: Awaited<ReturnType<typeof loginWithPassword>>) => {
    if (!data.token) {
      throw new Error("登录返回缺少会话令牌");
    }
    await setStoredAuthSession({
      key: data.token,
      role: data.role,
      subjectId: data.subject_id,
      name: data.name,
    });
    router.replace(getDefaultRouteForRole(data.role));
  };

  const handleLogin = async () => {
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      toast.error("请输入邮箱和密码");
      return;
    }

    setIsSubmitting(true);
    try {
      const data = await loginWithPassword(normalizedEmail, password);
      await saveSessionAndRedirect(data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "登录失败");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSetup = async () => {
    const normalizedEmail = setupEmail.trim();
    if (!normalizedEmail || !setupPassword || !setupKey.trim()) {
      toast.error("请填写管理员邮箱、密码和后台密钥");
      return;
    }
    if (setupPassword !== setupConfirmPassword) {
      toast.error("两次输入的密码不一致");
      return;
    }

    setIsSubmitting(true);
    try {
      const data = await setupAdminAccount({
        email: normalizedEmail,
        password: setupPassword,
        name: setupName.trim(),
        setup_key: setupKey.trim(),
      });
      await saveSessionAndRedirect(data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "初始化失败");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isCheckingAuth || isLoadingSetup) {
    return (
      <div className="grid min-h-[calc(100vh-1rem)] w-full place-items-center px-4 py-6">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return (
    <div className="grid min-h-[calc(100vh-1rem)] w-full place-items-center px-4 py-6">
      <Card className="w-full max-w-[560px] rounded-[30px] border-white/80 bg-white/95 shadow-[0_28px_90px_rgba(28,25,23,0.10)]">
        <CardContent className="space-y-7 p-6 sm:p-8">
          <div className="flex items-center justify-between gap-3">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-3 py-1.5 text-xs font-medium text-stone-600 transition hover:bg-stone-200 hover:text-stone-900"
            >
              <ArrowLeft className="size-3.5" />
              返回首页
            </Link>
            <span className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-stone-500 shadow-sm">
              shour生成图
            </span>
          </div>

          <div className="space-y-4 text-center">
            <div className="mx-auto inline-flex size-14 items-center justify-center rounded-[18px] bg-stone-950 text-white shadow-sm">
              {setupRequired ? <ShieldCheck className="size-5" /> : <LockKeyhole className="size-5" />}
            </div>
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold tracking-tight text-stone-950">
                {setupRequired ? "首次部署初始化" : "登录 shour生成图"}
              </h1>
              <p className="text-sm leading-6 text-stone-500">
                {setupRequired
                  ? "检测到还没有后台账号。先创建一个管理员邮箱密码，后续登录页只使用邮箱密码。"
                  : "请输入邮箱和密码登录。"}
              </p>
            </div>
          </div>

          {setupRequired ? (
            <div className="space-y-4">
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">
                部署密钥只在首次初始化时使用一次。绑定完成后不会再在登录页显示。
              </div>

              <div className="space-y-2">
                <label htmlFor="setup-name" className="block text-sm font-medium text-stone-700">
                  管理员名称
                </label>
                <Input
                  id="setup-name"
                  value={setupName}
                  onChange={(event) => setSetupName(event.target.value)}
                  placeholder="可选，例如 Shour"
                  className="h-13 rounded-2xl border-stone-200 bg-white px-4"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="setup-email" className="block text-sm font-medium text-stone-700">
                  管理员邮箱
                </label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-stone-400" />
                  <Input
                    id="setup-email"
                    type="email"
                    value={setupEmail}
                    onChange={(event) => setSetupEmail(event.target.value)}
                    placeholder="admin@example.com"
                    className="h-13 rounded-2xl border-stone-200 bg-white pl-11"
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <label htmlFor="setup-password" className="block text-sm font-medium text-stone-700">
                    登录密码
                  </label>
                  <Input
                    id="setup-password"
                    type="password"
                    value={setupPassword}
                    onChange={(event) => setSetupPassword(event.target.value)}
                    placeholder="至少 6 位"
                    className="h-13 rounded-2xl border-stone-200 bg-white px-4"
                    autoComplete="new-password"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="setup-confirm-password" className="block text-sm font-medium text-stone-700">
                    确认密码
                  </label>
                  <Input
                    id="setup-confirm-password"
                    type="password"
                    value={setupConfirmPassword}
                    onChange={(event) => setSetupConfirmPassword(event.target.value)}
                    placeholder="再次输入密码"
                    className="h-13 rounded-2xl border-stone-200 bg-white px-4"
                    autoComplete="new-password"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label htmlFor="setup-key" className="block text-sm font-medium text-stone-700">
                  后台密钥
                </label>
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-stone-400" />
                  <Input
                    id="setup-key"
                    type="password"
                    value={setupKey}
                    onChange={(event) => setSetupKey(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void handleSetup();
                      }
                    }}
                    placeholder="输入首次部署时配置的密钥"
                    className="h-13 rounded-2xl border-stone-200 bg-white pl-11"
                    autoComplete="off"
                  />
                </div>
              </div>

              <Button
                className="h-13 w-full rounded-2xl bg-stone-950 text-white hover:bg-stone-800"
                onClick={() => void handleSetup()}
                disabled={isSubmitting}
              >
                {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
                初始化并登录
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="email" className="block text-sm font-medium text-stone-700">
                  邮箱
                </label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-stone-400" />
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void handleLogin();
                      }
                    }}
                    placeholder="name@example.com"
                    className="h-13 rounded-2xl border-stone-200 bg-white pl-11"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label htmlFor="password" className="block text-sm font-medium text-stone-700">
                  密码
                </label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void handleLogin();
                    }
                  }}
                  placeholder="请输入密码"
                  className="h-13 rounded-2xl border-stone-200 bg-white px-4"
                />
              </div>

              <Button
                className="h-13 w-full rounded-2xl bg-stone-950 text-white hover:bg-stone-800"
                onClick={() => void handleLogin()}
                disabled={isSubmitting}
              >
                {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
                登录
              </Button>

              <div className="text-center text-sm text-stone-500">
                还没有账号？
                <Link href="/signup" className="ml-1 font-medium text-stone-900 underline-offset-4 hover:underline">
                  去注册
                </Link>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
