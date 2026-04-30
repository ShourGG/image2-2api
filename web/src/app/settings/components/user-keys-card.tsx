"use client";

import { useEffect, useRef, useState } from "react";
import { Ban, CheckCircle2, LoaderCircle, Pencil, Trash2, Users } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { deleteUser, fetchUsers, updateUser, type RegisteredUser } from "@/lib/api";

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

export function UserKeysCard() {
  const didLoadRef = useRef(false);
  const [items, setItems] = useState<RegisteredUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [editingItem, setEditingItem] = useState<RegisteredUser | null>(null);
  const [deletingItem, setDeletingItem] = useState<RegisteredUser | null>(null);
  const [formName, setFormName] = useState("");
  const [formPassword, setFormPassword] = useState("");
  const [formPoints, setFormPoints] = useState("50");
  const [formPaidCoins, setFormPaidCoins] = useState("0");
  const [formPaidBonusUses, setFormPaidBonusUses] = useState("1");

  const load = async () => {
    setIsLoading(true);
    try {
      const data = await fetchUsers();
      setItems(data.items);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载用户失败");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    void load();
  }, []);

  const setItemPending = (id: string, isPending: boolean) => {
    setPendingIds((current) => {
      const next = new Set(current);
      if (isPending) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const handleToggle = async (item: RegisteredUser) => {
    setItemPending(item.id, true);
    try {
      const data = await updateUser(item.id, { enabled: !item.enabled });
      setItems(data.items);
      toast.success(item.enabled ? "用户已禁用" : "用户已启用");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新用户失败");
    } finally {
      setItemPending(item.id, false);
    }
  };

  const openEditDialog = (item: RegisteredUser) => {
    setEditingItem(item);
    setFormName(item.name || "");
    setFormPassword("");
    setFormPoints(formatPoints(item.points ?? 0));
    setFormPaidCoins(String(Math.max(0, Number(item.paid_coins || 0))));
    setFormPaidBonusUses(String(Math.max(0, Number(item.paid_bonus_uses || 0))));
  };

  const handleSave = async () => {
    if (!editingItem) {
      return;
    }
    setItemPending(editingItem.id, true);
    try {
      const data = await updateUser(editingItem.id, {
        name: formName.trim(),
        points: Math.max(0, Number(formPoints || 0)),
        paid_coins: Math.max(0, Math.floor(Number(formPaidCoins || 0))),
        paid_bonus_uses: Math.max(0, Math.floor(Number(formPaidBonusUses || 0))),
        ...(formPassword.trim() ? { password: formPassword.trim() } : {}),
      });
      setItems(data.items);
      setEditingItem(null);
      setFormPassword("");
      setFormPoints("50");
      setFormPaidCoins("0");
      setFormPaidBonusUses("1");
      toast.success(formPassword.trim() ? "用户信息和密码已更新" : "用户信息已更新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存用户失败");
    } finally {
      setItemPending(editingItem.id, false);
    }
  };

  const handleDelete = async () => {
    if (!deletingItem) {
      return;
    }
    setItemPending(deletingItem.id, true);
    try {
      const data = await deleteUser(deletingItem.id);
      setItems(data.items);
      setDeletingItem(null);
      toast.success("用户已删除，相关账号归属已清空");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除用户失败");
    } finally {
      setItemPending(deletingItem.id, false);
    }
  };

  return (
    <>
      <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="space-y-6 p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-stone-100">
                <Users className="size-5 text-stone-600" />
              </div>
              <div>
                <h2 className="text-lg font-semibold tracking-tight">注册用户管理</h2>
                <p className="text-sm text-stone-500">普通用户通过 `/signup` 自助注册。免费生成扣积分走号池；充值高清扣图币或体验券走 OpenAI 兼容上游。这里可管理名称、密码、积分、图币、体验券和启停。</p>
              </div>
            </div>
            <Badge variant="secondary" className="rounded-md bg-stone-100 px-3 py-1 text-stone-600">
              共 {items.length} 人
            </Badge>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-10">
              <LoaderCircle className="size-5 animate-spin text-stone-400" />
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-xl bg-stone-50 px-6 py-10 text-center text-sm text-stone-500">
              暂无注册用户，用户访问 `/signup` 后会出现在这里。
            </div>
          ) : (
            <div className="space-y-3">
              {items.map((item) => {
                const isPending = pendingIds.has(item.id);
                return (
                  <div key={item.id} className="flex flex-col gap-3 rounded-xl border border-stone-200 bg-white px-4 py-4 md:flex-row md:items-center md:justify-between">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="truncate text-sm font-medium text-stone-800">{item.name || item.email}</div>
                        <Badge variant={item.enabled ? "success" : "secondary"} className="rounded-md">
                          {item.enabled ? "已启用" : "已禁用"}
                        </Badge>
                        <Badge variant="info" className="rounded-md">
                          {formatPoints(item.points)} 积分
                        </Badge>
                        <Badge variant="secondary" className="rounded-md">
                          {Math.max(0, Number(item.paid_coins || 0))} 图币
                        </Badge>
                        <Badge variant="secondary" className="rounded-md">
                          体验券 {Math.max(0, Number(item.paid_bonus_uses || 0))}
                        </Badge>
                      </div>
                      <div className="text-sm text-stone-500">{item.email}</div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
                        <span>创建时间 {formatDateTime(item.created_at)}</span>
                        <span>最近登录 {formatDateTime(item.last_login_at)}</span>
                        <span>最近调用 {formatDateTime(item.last_used_at)}</span>
                        <span>累计签到 {item.checkin_total_count ?? 0} 次</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-xl border-stone-200 bg-white px-4 text-stone-700"
                        onClick={() => openEditDialog(item)}
                        disabled={isPending}
                      >
                        <Pencil className="size-4" />
                        编辑
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-xl border-stone-200 bg-white px-4 text-stone-700"
                        onClick={() => void handleToggle(item)}
                        disabled={isPending}
                      >
                        {isPending ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : item.enabled ? (
                          <Ban className="size-4" />
                        ) : (
                          <CheckCircle2 className="size-4" />
                        )}
                        {item.enabled ? "禁用" : "启用"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-xl border-rose-200 bg-white px-4 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                        onClick={() => setDeletingItem(item)}
                        disabled={isPending}
                      >
                        {isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                        删除
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={Boolean(editingItem)} onOpenChange={(open) => (!open ? setEditingItem(null) : null)}>
        <DialogContent className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>编辑用户</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              可修改显示名称，也可以直接重置登录密码。留空则不修改密码。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">名称</label>
              <Input
                value={formName}
                onChange={(event) => setFormName(event.target.value)}
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">新密码</label>
              <Input
                type="password"
                value={formPassword}
                onChange={(event) => setFormPassword(event.target.value)}
                placeholder="至少 6 位，不改可留空"
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">积分</label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={formPoints}
                onChange={(event) => setFormPoints(event.target.value)}
                placeholder="默认 50"
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">图币</label>
              <Input
                type="number"
                min="0"
                step="1"
                value={formPaidCoins}
                onChange={(event) => setFormPaidCoins(event.target.value)}
                placeholder="充值余额，1 元 = 100 图币"
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-700">充值体验券</label>
              <Input
                type="number"
                min="0"
                step="1"
                value={formPaidBonusUses}
                onChange={(event) => setFormPaidBonusUses(event.target.value)}
                placeholder="默认 1 次"
                className="h-11 rounded-xl border-stone-200 bg-white"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200"
              onClick={() => setEditingItem(null)}
              disabled={editingItem ? pendingIds.has(editingItem.id) : false}
            >
              取消
            </Button>
            <Button
              type="button"
              className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
              onClick={() => void handleSave()}
              disabled={editingItem ? pendingIds.has(editingItem.id) : false}
            >
              {editingItem && pendingIds.has(editingItem.id) ? <LoaderCircle className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deletingItem)} onOpenChange={(open) => (!open ? setDeletingItem(null) : null)}>
        <DialogContent className="rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>删除用户</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              确认删除用户「{deletingItem?.name || deletingItem?.email}」吗？删除后该用户无法登录，且所属账号会自动取消归属。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              className="h-10 rounded-xl bg-stone-100 px-5 text-stone-700 hover:bg-stone-200"
              onClick={() => setDeletingItem(null)}
              disabled={deletingItem ? pendingIds.has(deletingItem.id) : false}
            >
              取消
            </Button>
            <Button
              type="button"
              className="h-10 rounded-xl bg-rose-600 px-5 text-white hover:bg-rose-700"
              onClick={() => void handleDelete()}
              disabled={deletingItem ? pendingIds.has(deletingItem.id) : false}
            >
              {deletingItem && pendingIds.has(deletingItem.id) ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
