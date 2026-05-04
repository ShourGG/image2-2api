"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoaderCircle, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { registerUserAccount } from "@/lib/api";
import { useRedirectIfAuthenticated } from "@/lib/use-auth-guard";
import { getDefaultRouteForRole, setStoredAuthSession } from "@/store/auth";

export default function SignupPage() {
  const router = useRouter();
  const { isCheckingAuth } = useRedirectIfAuthenticated();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [siteInviteCode, setSiteInviteCode] = useState("");
  const [referralCode, setReferralCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSignup = async () => {
    const normalizedEmail = email.trim();
    const normalizedName = name.trim();
    if (!normalizedEmail || !password) {
      toast.error("请输入邮箱和密码");
      return;
    }
    if (password !== confirmPassword) {
      toast.error("两次输入的密码不一致");
      return;
    }

    setIsSubmitting(true);
    try {
      const data = await registerUserAccount({
        email: normalizedEmail,
        password,
        name: normalizedName,
        site_invite_code: siteInviteCode.trim(),
        referral_code: referralCode.trim(),
      });
      if (!data.token) {
        throw new Error("注册返回缺少会话令牌");
      }
      await setStoredAuthSession({
        key: data.token,
        role: data.role,
        subjectId: data.subject_id,
        name: data.name,
      });
      router.replace(getDefaultRouteForRole(data.role));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "注册失败");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isCheckingAuth) {
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
          <div className="space-y-4 text-center">
            <div className="mx-auto inline-flex size-14 items-center justify-center rounded-[18px] bg-stone-950 text-white shadow-sm">
              <UserPlus className="size-5" />
            </div>
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold tracking-tight text-stone-950">注册新用户</h1>
              <p className="text-sm leading-6 text-stone-500">注册后即可登录使用画图功能；站点准入码和好友推荐码已分开填写。</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="name" className="block text-sm font-medium text-stone-700">
                昵称
              </label>
              <Input
                id="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="可选，不填则使用邮箱前缀"
                className="h-13 rounded-2xl border-stone-200 bg-white px-4"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="email" className="block text-sm font-medium text-stone-700">
                邮箱
              </label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
                className="h-13 rounded-2xl border-stone-200 bg-white px-4"
              />
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
                placeholder="至少 6 位"
                className="h-13 rounded-2xl border-stone-200 bg-white px-4"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="site-invite-code" className="block text-sm font-medium text-stone-700">
                站点邀请码
              </label>
              <Input
                id="site-invite-code"
                value={siteInviteCode}
                onChange={(event) => setSiteInviteCode(event.target.value)}
                placeholder="站点开启准入码时必填"
                className="h-13 rounded-2xl border-stone-200 bg-white px-4"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="referral-code" className="block text-sm font-medium text-stone-700">
                推荐人邀请码
              </label>
              <Input
                id="referral-code"
                value={referralCode}
                onChange={(event) => setReferralCode(event.target.value)}
                placeholder="填写好友邀请码可让对方获得积分"
                className="h-13 rounded-2xl border-stone-200 bg-white px-4"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="confirm-password" className="block text-sm font-medium text-stone-700">
                确认密码
              </label>
              <Input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleSignup();
                  }
                }}
                placeholder="再次输入密码"
                className="h-13 rounded-2xl border-stone-200 bg-white px-4"
              />
            </div>
          </div>

          <Button
            className="h-13 w-full rounded-2xl bg-stone-950 text-white hover:bg-stone-800"
            onClick={() => void handleSignup()}
            disabled={isSubmitting}
          >
            {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
            注册并登录
          </Button>

          <div className="text-center text-sm text-stone-500">
            已有账号？
            <Link href="/login" className="ml-1 font-medium text-stone-900 underline-offset-4 hover:underline">
              返回登录
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
