"use client";
import { ArrowUp, Check, ChevronDown, ImagePlus, LoaderCircle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type RefObject } from "react";

import { ImageLightbox } from "@/components/image-lightbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ImageGenerationMode, ImageQuality } from "@/lib/api";
import { cn } from "@/lib/utils";

type ImageComposerProps = {
  prompt: string;
  imageCount: string;
  imageSize: string;
  imageQuality: ImageQuality;
  generationMode: ImageGenerationMode;
  showGenerationModeSwitch?: boolean;
  availableQuota: string;
  quotaLabel?: string;
  quotaHint?: string;
  activeTaskCount: number;
  referenceImages: Array<{ name: string; dataUrl: string }>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onPromptChange: (value: string) => void;
  onImageCountChange: (value: string) => void;
  onImageSizeChange: (value: string) => void;
  onImageQualityChange: (value: ImageQuality) => void;
  onGenerationModeChange: (value: ImageGenerationMode) => void;
  onSubmit: () => void | Promise<void>;
  onPickReferenceImage: () => void;
  onReferenceImageChange: (files: File[]) => void | Promise<void>;
  onRemoveReferenceImage: (index: number) => void;
};

export function ImageComposer({
  prompt,
  imageCount,
  imageSize,
  imageQuality,
  generationMode,
  showGenerationModeSwitch = false,
  availableQuota,
  quotaLabel = "剩余额度",
  quotaHint = "",
  activeTaskCount,
  referenceImages,
  textareaRef,
  fileInputRef,
  onPromptChange,
  onImageCountChange,
  onImageSizeChange,
  onImageQualityChange,
  onGenerationModeChange,
  onSubmit,
  onPickReferenceImage,
  onReferenceImageChange,
  onRemoveReferenceImage,
}: ImageComposerProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [isSizeMenuOpen, setIsSizeMenuOpen] = useState(false);
  const [isQualityMenuOpen, setIsQualityMenuOpen] = useState(false);
  const sizeMenuRef = useRef<HTMLDivElement>(null);
  const qualityMenuRef = useRef<HTMLDivElement>(null);
  const lightboxImages = useMemo(
    () => referenceImages.map((image, index) => ({ id: `${image.name}-${index}`, src: image.dataUrl })),
    [referenceImages],
  );
  const allImageSizeOptions = [
    { value: "", label: "未指定" },
    { value: "1024x1024", label: "1024x1024 方图" },
    { value: "1536x1024", label: "1536x1024 横图" },
    { value: "1024x1536", label: "1024x1536 竖图" },
    { value: "2048x2048", label: "2K 2048x2048 方图" },
    { value: "2048x1152", label: "2K 2048x1152 横图" },
    { value: "1152x2048", label: "2K 1152x2048 竖图" },
    { value: "2560x1440", label: "2K 2560x1440 横图" },
    { value: "1440x2560", label: "2K 1440x2560 竖图" },
    { value: "3840x2160", label: "4K 3840x2160 横图" },
    { value: "2160x3840", label: "4K 2160x3840 竖图" },
  ];
  const imageSizeOptions = generationMode === "free" ? allImageSizeOptions.slice(0, 4) : allImageSizeOptions;
  const imageSizeLabel = imageSizeOptions.find((option) => option.value === imageSize)?.label || "未指定";
  const imageQualityOptions: Array<{ value: ImageQuality; label: string }> = generationMode === "free" ? [
    { value: "standard", label: "标准" },
  ] : [
    { value: "standard", label: "标准" },
    { value: "high", label: "高清 high" },
  ];
  const imageQualityLabel = imageQualityOptions.find((option) => option.value === imageQuality)?.label || "高清 high";

  useEffect(() => {
    if (!isSizeMenuOpen && !isQualityMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!sizeMenuRef.current?.contains(target)) {
        setIsSizeMenuOpen(false);
      }
      if (!qualityMenuRef.current?.contains(target)) {
        setIsQualityMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isQualityMenuOpen, isSizeMenuOpen]);

  const handleTextareaPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    void onReferenceImageChange(imageFiles);
  };

  return (
    <div className="shrink-0 flex justify-center px-1 sm:px-0">
      <div style={{ width: "min(980px, 100%)" }}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            void onReferenceImageChange(Array.from(event.target.files || []));
          }}
        />

        {referenceImages.length > 0 ? (
          <div className="mb-2 flex gap-2 overflow-x-auto px-1 pb-1 sm:mb-3 sm:flex-wrap sm:overflow-visible sm:pb-0">
            {referenceImages.map((image, index) => (
              <div key={`${image.name}-${index}`} className="relative size-14 shrink-0 sm:size-16">
                <button
                  type="button"
                  onClick={() => {
                    setLightboxIndex(index);
                    setLightboxOpen(true);
                  }}
                  className="group size-14 overflow-hidden rounded-2xl border border-stone-200 bg-stone-50 transition hover:border-stone-300 sm:size-16"
                  aria-label={`预览参考图 ${image.name || index + 1}`}
                >
                  <img
                    src={image.dataUrl}
                    alt={image.name || `参考图 ${index + 1}`}
                    className="h-full w-full object-cover"
                  />
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemoveReferenceImage(index);
                  }}
                  className="absolute -right-1 -top-1 inline-flex size-5 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 transition hover:border-stone-300 hover:text-stone-800"
                  aria-label={`移除参考图 ${image.name || index + 1}`}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="rounded-[24px] border border-stone-200 bg-white shadow-[0_14px_60px_-42px_rgba(15,23,42,0.45)] sm:rounded-[32px] sm:shadow-none">
          <div
            className="relative cursor-text"
            onClick={() => {
              textareaRef.current?.focus();
            }}
          >
            <ImageLightbox
              images={lightboxImages}
              currentIndex={lightboxIndex}
              open={lightboxOpen}
              onOpenChange={setLightboxOpen}
              onIndexChange={setLightboxIndex}
            />
            <Textarea
              ref={textareaRef}
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              onPaste={handleTextareaPaste}
              placeholder={
                referenceImages.length > 0
                  ? "描述你希望如何修改参考图"
                  : "输入你想要生成的画面，也可直接粘贴图片"
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void onSubmit();
                }
              }}
              className="min-h-[82px] resize-none rounded-[24px] border-0 bg-transparent px-4 pt-4 pb-2 text-[15px] leading-6 text-stone-900 shadow-none placeholder:text-stone-400 focus-visible:ring-0 sm:min-h-[148px] sm:rounded-[32px] sm:px-6 sm:pt-6 sm:pb-6 sm:leading-7"
            />

            <div className="border-t border-stone-100 bg-white px-3 pb-3 pt-2 sm:px-6 sm:pb-4 sm:pt-4">
              <div className="flex items-end justify-between gap-2 sm:gap-3">
                <div className="hide-scrollbar flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5 sm:flex-wrap sm:gap-3 sm:overflow-visible sm:pb-0">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 shrink-0 rounded-full border-stone-200 bg-white px-3 text-xs font-medium text-stone-700 shadow-none sm:h-10 sm:px-4 sm:text-sm"
                    onClick={onPickReferenceImage}
                  >
                    <ImagePlus className="size-3.5 sm:size-4" />
                    <span>{referenceImages.length > 0 ? "添加参考图" : "上传"}</span>
                  </Button>
                  <div
                    className="inline-flex min-w-0 max-w-[62vw] items-center rounded-full bg-stone-100 px-2 py-1 text-[10px] font-medium text-stone-600 sm:max-w-[560px] sm:px-3 sm:py-2 sm:text-xs"
                    title={quotaHint ? `${quotaLabel} ${availableQuota} · ${quotaHint}` : `${quotaLabel} ${availableQuota}`}
                  >
                    <span className="hidden xs:inline shrink-0">{quotaLabel} </span>
                    <span className="shrink-0">{availableQuota}</span>
                    {quotaHint ? <span className="ml-1 min-w-0 truncate text-stone-400">· {quotaHint}</span> : null}
                  </div>
                  {showGenerationModeSwitch ? (
                    <div className="flex h-9 shrink-0 items-center rounded-full border border-stone-200 bg-white p-0.5 text-[11px] font-medium sm:h-10 sm:text-xs">
                      {([
                        ["free", "免费"],
                        ["paid", "充值高清"],
                      ] as Array<[ImageGenerationMode, string]>).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          className={cn(
                            "h-8 rounded-full px-3 transition sm:px-4",
                            generationMode === value
                              ? "bg-stone-950 text-white"
                              : "text-stone-600 hover:bg-stone-100",
                          )}
                          onClick={() => onGenerationModeChange(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {activeTaskCount > 0 && (
                    <div className="flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-700 sm:gap-1.5 sm:px-3 sm:py-2 sm:text-xs">
                      <LoaderCircle className="size-3 animate-spin" />
                      {activeTaskCount}<span className="hidden sm:inline"> 个任务处理中</span>
                    </div>
                  )}
                  <div className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-stone-200 bg-white px-2 py-0.5 sm:h-auto sm:gap-2 sm:px-3 sm:py-1">
                    <span className="text-[11px] font-medium text-stone-700 sm:text-sm">张数</span>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min="1"
                      max="10"
                      step="1"
                      value={imageCount}
                      onChange={(event) => onImageCountChange(event.target.value)}
                      className="h-7 w-[40px] border-0 bg-transparent px-0 text-center text-xs font-medium text-stone-700 shadow-none focus-visible:ring-0 sm:h-8 sm:w-[64px] sm:text-sm"
                    />
                  </div>
                  <div
                    ref={sizeMenuRef}
                    className="relative flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-stone-200 bg-white px-2 py-0.5 text-[11px] sm:h-auto sm:gap-2 sm:px-3 sm:py-1 sm:text-[13px]"
                  >
                    <span className="font-medium text-stone-700 sm:text-sm">比例</span>
                    <button
                      type="button"
                      className="flex h-7 w-[78px] items-center justify-between bg-transparent text-left text-xs font-bold text-stone-700 min-[390px]:w-[96px] sm:h-8 sm:w-[132px]"
                      onClick={() => {
                        setIsQualityMenuOpen(false);
                        setIsSizeMenuOpen((open) => !open);
                      }}
                    >
                      <span className="truncate">{imageSizeLabel}</span>
                      <ChevronDown className={cn("size-4 shrink-0 opacity-60 transition", isSizeMenuOpen && "rotate-180")} />
                    </button>
                    {isSizeMenuOpen ? (
                      <div className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+5.75rem)] z-[80] max-h-[45dvh] overflow-y-auto rounded-3xl border border-white/80 bg-white p-2 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.35)] sm:absolute sm:inset-x-auto sm:bottom-[calc(100%+10px)] sm:left-0 sm:w-[186px]">
                        {imageSizeOptions.map((option) => {
                          const active = option.value === imageSize;
                          return (
                            <button
                              key={option.label}
                              type="button"
                              className={cn(
                                "flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left text-sm text-stone-700 transition hover:bg-stone-100",
                                active && "bg-stone-100 font-medium text-stone-950",
                              )}
                              onClick={() => {
                                onImageSizeChange(option.value);
                                setIsSizeMenuOpen(false);
                              }}
                            >
                              <span>{option.label}</span>
                              {active ? <Check className="size-4" /> : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                  <div
                    ref={qualityMenuRef}
                    className="relative flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-stone-200 bg-white px-2 py-0.5 text-[11px] sm:h-auto sm:gap-2 sm:px-3 sm:py-1 sm:text-[13px]"
                  >
                    <span className="font-medium text-stone-700 sm:text-sm">画质</span>
                    <button
                      type="button"
                      className="flex h-7 w-[74px] items-center justify-between bg-transparent text-left text-xs font-bold text-stone-700 sm:h-8 sm:w-[104px]"
                      onClick={() => {
                        setIsSizeMenuOpen(false);
                        setIsQualityMenuOpen((open) => !open);
                      }}
                    >
                      <span className="truncate">{imageQualityLabel}</span>
                      <ChevronDown className={cn("size-4 shrink-0 opacity-60 transition", isQualityMenuOpen && "rotate-180")} />
                    </button>
                    {isQualityMenuOpen ? (
                      <div className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+5.75rem)] z-[80] max-h-[45dvh] overflow-y-auto rounded-3xl border border-white/80 bg-white p-2 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.35)] sm:absolute sm:inset-x-auto sm:bottom-[calc(100%+10px)] sm:left-0 sm:w-[156px]">
                        {imageQualityOptions.map((option) => {
                          const active = option.value === imageQuality;
                          return (
                            <button
                              key={option.value}
                              type="button"
                              className={cn(
                                "flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left text-sm text-stone-700 transition hover:bg-stone-100",
                                active && "bg-stone-100 font-medium text-stone-950",
                              )}
                              onClick={() => {
                                onImageQualityChange(option.value);
                                setIsQualityMenuOpen(false);
                              }}
                            >
                              <span>{option.label}</span>
                              {active ? <Check className="size-4" /> : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>

                </div>

                <button
                  type="button"
                  onClick={() => void onSubmit()}
                  disabled={!prompt.trim()}
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-stone-950 text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300 sm:size-11"
                  aria-label={referenceImages.length > 0 ? "编辑图片" : "生成图片"}
                >
                  <ArrowUp className="size-3.5 sm:size-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
