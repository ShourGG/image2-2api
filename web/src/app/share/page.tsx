"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Copy, ExternalLink, ImageIcon, Share2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { ImageLightbox } from "@/components/image-lightbox";
import { Button } from "@/components/ui/button";
import { fetchImageShare, type SharedImageRecord } from "@/lib/api";

async function copyText(text: string, successMessage: string) {
  await navigator.clipboard.writeText(text);
  toast.success(successMessage);
}

function SharePageContent() {
  const searchParams = useSearchParams();
  const shareId = searchParams.get("id") || "";
  const [shareItem, setShareItem] = useState<SharedImageRecord | null>(null);
  const [shareError, setShareError] = useState("");
  const [isShareLoading, setIsShareLoading] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const legacyPayload = useMemo(
    () => ({
      imageUrl: searchParams.get("image") || "",
      prompt: searchParams.get("prompt") || "",
      revisedPrompt: searchParams.get("revised_prompt") || "",
      model: searchParams.get("model") || "",
      size: searchParams.get("size") || "",
      quality: searchParams.get("quality") || "",
      result: searchParams.get("result") || "",
      createdAt: searchParams.get("created_at") || "",
    }),
    [searchParams],
  );

  useEffect(() => {
    if (!shareId) {
      setShareItem(null);
      setShareError("");
      setIsShareLoading(false);
      return;
    }

    let cancelled = false;
    setIsShareLoading(true);
    setShareError("");
    setShareItem(null);
    void fetchImageShare(shareId)
      .then((response) => {
        if (cancelled) return;
        setShareItem(response.item);
      })
      .catch((error) => {
        if (cancelled) return;
        setShareItem(null);
        setShareError(error instanceof Error ? error.message : "分享内容加载失败");
      })
      .finally(() => {
        if (cancelled) return;
        setIsShareLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [shareId]);

  const imageUrl = shareId ? shareItem?.image_url || "" : legacyPayload.imageUrl;
  const prompt = shareId ? shareItem?.prompt || "" : legacyPayload.prompt;
  const revisedPrompt = shareId ? shareItem?.revised_prompt || "" : legacyPayload.revisedPrompt;
  const model = shareId ? shareItem?.model || "" : legacyPayload.model;
  const size = shareId ? shareItem?.size || "" : legacyPayload.size;
  const quality = shareId ? shareItem?.quality || "" : legacyPayload.quality;
  const result = shareId ? String(shareItem?.result || "") : legacyPayload.result;
  const createdAt = shareId ? shareItem?.created_at || "" : legacyPayload.createdAt;
  const lightboxImages = useMemo(
    () => (
      imageUrl
        ? [
            {
              id: shareId || "shared-image",
              src: imageUrl,
              sizeLabel: size || undefined,
            },
          ]
        : []
    ),
    [imageUrl, shareId, size],
  );

  const shareCurrentPage = async () => {
    const currentUrl = window.location.href;
    await copyText(currentUrl, "分享页地址已复制");
  };

  if (shareId && isShareLoading && !shareItem) {
    return <SharePageFallback />;
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between gap-4">
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-stone-700 shadow-sm transition hover:bg-stone-50"
        >
          <ArrowLeft className="size-4" />
          返回首页
        </Link>
        <div className="inline-flex items-center gap-2 rounded-full bg-stone-950 px-4 py-2 text-sm font-semibold text-white">
          <Sparkles className="size-4" />
          Shour 分享图
        </div>
      </div>

      {shareId && shareError ? (
        <section className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xl rounded-[28px] border border-stone-200 bg-white p-8 text-center shadow-sm">
            <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-stone-100 text-stone-700">
              <ImageIcon className="size-7" />
            </div>
            <h1 className="text-2xl font-bold text-stone-950">分享页不存在或已失效</h1>
            <p className="mt-3 text-sm leading-7 text-stone-500">
              {shareError}
            </p>
          </div>
        </section>
      ) : null}

      {!shareError && !imageUrl ? (
        <section className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xl rounded-[28px] border border-stone-200 bg-white p-8 text-center shadow-sm">
            <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-stone-100 text-stone-700">
              <ImageIcon className="size-7" />
            </div>
            <h1 className="text-2xl font-bold text-stone-950">这个分享页没有图片</h1>
            <p className="mt-3 text-sm leading-7 text-stone-500">
              链接里没有带上图片地址，或者参数已经丢失。回到生成页重新点一次分享页就行。
            </p>
          </div>
        </section>
      ) : !shareError ? (
        <section className="grid gap-6 lg:h-[calc(100vh-7.5rem)] lg:grid-cols-[minmax(0,1.1fr)_380px]">
          <div className="overflow-hidden rounded-[30px] border border-stone-200 bg-white shadow-sm lg:min-h-0">
            <div className="lg:flex lg:h-full lg:items-center lg:justify-center lg:overflow-auto">
              <button
                type="button"
                className="group relative block w-full cursor-zoom-in bg-stone-100 text-left outline-none lg:flex lg:h-full lg:items-center lg:justify-center"
                onClick={() => setLightboxOpen(true)}
              >
                <img
                  src={imageUrl}
                  alt="分享图片"
                  className="block max-h-[78vh] w-full bg-stone-100 object-contain lg:max-h-full"
                />
                <span className="pointer-events-none absolute right-4 bottom-4 rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white opacity-90 transition group-hover:bg-black/70">
                  点按查看大图
                </span>
              </button>
            </div>
          </div>

          <aside className="space-y-4 rounded-[30px] border border-stone-200 bg-white p-5 shadow-sm lg:flex lg:min-h-0 lg:flex-col lg:overflow-hidden">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-600">
                <Share2 className="size-3.5" />
                公开分享页
              </div>
              <h1 className="mt-3 text-2xl font-bold tracking-tight text-stone-950">这张图来自 shour生成图</h1>
              <p className="mt-2 text-sm leading-7 text-stone-500">
                这里展示的是公开图片页面，任何拿到链接的人都可以查看这张图。
              </p>
            </div>

            <div className="flex flex-wrap gap-2 text-xs text-stone-500">
              {result ? <span className="rounded-full bg-stone-100 px-3 py-1.5">结果 {result}</span> : null}
              {model ? <span className="rounded-full bg-stone-100 px-3 py-1.5">{model}</span> : null}
              {size ? <span className="rounded-full bg-stone-100 px-3 py-1.5">{size}</span> : null}
              {quality ? <span className="rounded-full bg-stone-100 px-3 py-1.5">{quality}</span> : null}
            </div>

            <div className="max-h-[40vh] space-y-3 overflow-y-auto rounded-3xl bg-stone-50 p-4 lg:max-h-[calc(100vh-24rem)] lg:min-h-0 lg:flex-1">
              <div className="min-w-0">
                <div className="text-xs font-medium uppercase tracking-[0.18em] text-stone-400">提示词</div>
                <div className="mt-2 whitespace-pre-wrap break-words text-sm leading-7 text-stone-800">
                  {prompt || "未附带提示词"}
                </div>
              </div>
              {revisedPrompt ? (
                <div className="min-w-0">
                  <div className="text-xs font-medium uppercase tracking-[0.18em] text-stone-400">模型改写提示词</div>
                  <div className="mt-2 whitespace-pre-wrap break-words text-sm leading-7 text-stone-700">
                    {revisedPrompt}
                  </div>
                </div>
              ) : null}
              {createdAt ? (
                <div className="text-xs text-stone-400">生成时间：{createdAt}</div>
              ) : null}
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                type="button"
                className="h-11 rounded-2xl bg-stone-950 text-white hover:bg-stone-800"
                onClick={() => {
                  void shareCurrentPage().catch(() => {
                    toast.error("分享页地址复制失败");
                  });
                }}
              >
                <Share2 className="size-4" />
                复制分享链接
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-11 rounded-2xl border-stone-200 bg-white text-stone-700"
                onClick={() => {
                  void copyText(imageUrl, "图片地址已复制").catch(() => {
                    toast.error("复制图片地址失败");
                  });
                }}
              >
                <ExternalLink className="size-4" />
                复制图片地址
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-11 rounded-2xl border-stone-200 bg-white text-stone-700"
                onClick={() => {
                  void copyText(prompt, "提示词已复制").catch(() => {
                    toast.error("复制提示词失败");
                  });
                }}
                disabled={!prompt}
              >
                <Copy className="size-4" />
                复制提示词
              </Button>
              <a
                href={imageUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl border border-stone-200 bg-white px-4 text-sm font-medium text-stone-700 transition hover:bg-stone-50"
              >
                <ExternalLink className="size-4" />
                查看原图
              </a>
            </div>
          </aside>
        </section>
      ) : null}
      <ImageLightbox
        images={lightboxImages}
        currentIndex={0}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onIndexChange={() => undefined}
      />
    </main>
  );
}

function SharePageFallback() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between gap-4">
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-stone-700 shadow-sm transition hover:bg-stone-50"
        >
          <ArrowLeft className="size-4" />
          返回首页
        </Link>
        <div className="inline-flex items-center gap-2 rounded-full bg-stone-950 px-4 py-2 text-sm font-semibold text-white">
          <Sparkles className="size-4" />
          Shour 分享图
        </div>
      </div>
      <section className="flex flex-1 items-center justify-center">
        <div className="w-full max-w-xl rounded-[28px] border border-stone-200 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-stone-100 text-stone-700">
            <ImageIcon className="size-7" />
          </div>
          <h1 className="text-2xl font-bold text-stone-950">正在加载分享页</h1>
          <p className="mt-3 text-sm leading-7 text-stone-500">稍等一下，分享内容马上出来。</p>
        </div>
      </section>
    </main>
  );
}

export default function SharePage() {
  return (
    <Suspense fallback={<SharePageFallback />}>
      <SharePageContent />
    </Suspense>
  );
}
