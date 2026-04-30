"use client";

import { BookOpen, Copy, ExternalLink, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import promptLibraryData from "@/generated/image-prompt-library.json";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type PromptLibraryItem = {
  id: number;
  title: string;
  category: string;
  prompt: string;
  source_url: string;
  author_handle: string;
  author_url: string;
};

type PromptLibraryData = {
  source_repo: string;
  source_readme: string;
  source_license: string;
  synced_at: string;
  item_count: number;
  items: PromptLibraryItem[];
};

type ApplyMode = "replace" | "append";

type ImagePromptLibraryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApplyPrompt: (prompt: string, mode: ApplyMode) => void;
};

const CATEGORY_LABELS: Record<string, string> = {
  "Ad Creative Cases": "广告创意",
  "E-commerce Cases": "电商",
  "UI 与社交媒体截图案例": "UI / 社媒",
  "人像与摄影案例": "人像摄影",
  "模型对比与社区案例": "对比 / 社区",
  "海报与插画案例": "海报插画",
  "角色设计案例": "角色设计",
};

async function copyText(text: string, successMessage: string) {
  await navigator.clipboard.writeText(text);
  toast.success(successMessage);
}

function normalizeCategoryLabel(value: string) {
  return CATEGORY_LABELS[value] || value;
}

function formatPromptPreview(prompt: string, limit = 220) {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}...`;
}

export function ImagePromptLibraryDialog({
  open,
  onOpenChange,
  onApplyPrompt,
}: ImagePromptLibraryDialogProps) {
  const library = promptLibraryData as PromptLibraryData;
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");

  const categories = useMemo(
    () => Array.from(new Set(library.items.map((item) => item.category))),
    [library.items],
  );

  const filteredItems = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return library.items.filter((item) => {
      if (category !== "all" && item.category !== category) {
        return false;
      }
      if (!keyword) {
        return true;
      }
      const haystack = [
        item.title,
        item.category,
        item.author_handle,
        item.prompt,
      ].join("\n").toLowerCase();
      return haystack.includes(keyword);
    });
  }, [category, library.items, search]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(88dvh,860px)] w-[96vw] max-w-[1080px] flex-col overflow-hidden rounded-[28px] p-0">
        <DialogHeader className="border-b border-stone-100 px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center gap-2 text-xl">
            <BookOpen className="size-5" />
            GPT-Image-2 提示词模板库
          </DialogTitle>
          <DialogDescription className="pt-1 text-sm leading-6">
            内置收录 {library.item_count} 条模板，支持搜索、分类筛选、一键填入。
            来源：
            <a
              href={library.source_readme}
              target="_blank"
              rel="noreferrer"
              className="ml-1 inline-flex items-center gap-1 text-stone-700 underline underline-offset-4"
            >
              awesome-gpt-image-2-prompts
              <ExternalLink className="size-3.5" />
            </a>
            <span className="ml-1 text-stone-500">· {library.source_license}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-6 pt-4 pb-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative w-full lg:max-w-md">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索标题、作者、分类、提示词关键词"
                className="pl-9"
              />
            </div>
            <div className="text-sm text-stone-500">
              当前 {filteredItems.length} / {library.item_count} 条
            </div>
          </div>

          <div className="hide-scrollbar flex gap-2 overflow-x-auto pb-1">
            <button
              type="button"
              onClick={() => setCategory("all")}
              className={`shrink-0 rounded-full px-3 py-1.5 text-sm transition ${
                category === "all" ? "bg-stone-950 text-white" : "bg-stone-100 text-stone-600 hover:bg-stone-200"
              }`}
            >
              全部
            </button>
            {categories.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setCategory(item)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-sm transition ${
                  category === item ? "bg-stone-950 text-white" : "bg-stone-100 text-stone-600 hover:bg-stone-200"
                }`}
              >
                {normalizeCategoryLabel(item)}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {filteredItems.map((item) => (
              <div
                key={`${item.category}-${item.id}-${item.title}`}
                className="rounded-3xl border border-stone-200 bg-white p-4 shadow-sm"
              >
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-stone-100 px-2 py-1 font-medium text-stone-700">
                    #{item.id}
                  </span>
                  <span className="rounded-full bg-stone-100 px-2 py-1 text-stone-600">
                    {normalizeCategoryLabel(item.category)}
                  </span>
                  <a
                    href={item.author_url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-full bg-stone-100 px-2 py-1 text-stone-600 hover:bg-stone-200"
                  >
                    @{item.author_handle}
                  </a>
                </div>

                <div className="text-base font-semibold text-stone-900">
                  {item.title}
                </div>
                <div className="mt-2 rounded-2xl bg-stone-50 px-3 py-3 text-sm leading-6 text-stone-600">
                  {formatPromptPreview(item.prompt)}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    className="rounded-full bg-stone-950 text-white hover:bg-stone-800"
                    onClick={() => {
                      onApplyPrompt(item.prompt, "replace");
                      onOpenChange(false);
                    }}
                  >
                    直接填入
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full"
                    onClick={() => {
                      onApplyPrompt(item.prompt, "append");
                      onOpenChange(false);
                    }}
                  >
                    追加到输入框
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full"
                    onClick={() => {
                      void copyText(item.prompt, "提示词已复制");
                    }}
                  >
                    <Copy className="size-4" />
                    复制
                  </Button>
                  <a
                    href={item.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-stone-500 underline underline-offset-4"
                  >
                    查看来源
                    <ExternalLink className="size-3.5" />
                  </a>
                </div>
              </div>
            ))}
          </div>

          {filteredItems.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-stone-500">
              没搜到匹配模板，换个关键词试试。
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
