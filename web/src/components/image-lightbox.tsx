"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type WheelEvent } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Download, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";

import { cn } from "@/lib/utils";

type LightboxImage = {
  id: string;
  src: string;
  sizeLabel?: string;
  dimensions?: string;
};

type ImageLightboxProps = {
  images: LightboxImage[];
  currentIndex: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIndexChange: (index: number) => void;
};

type Point = {
  x: number;
  y: number;
};

type Transform = {
  scale: number;
  x: number;
  y: number;
};

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const WHEEL_ZOOM_STEP = 1.14;

function clampScale(value: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function ImageLightbox({
  images,
  currentIndex,
  open,
  onOpenChange,
  onIndexChange,
}: ImageLightboxProps) {
  const current = images[currentIndex];
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < images.length - 1;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const transformRef = useRef<Transform>({ scale: 1, x: 0, y: 0 });
  const activePointersRef = useRef<Map<number, Point>>(new Map());
  const dragRef = useRef<{
    pointerId: number;
    start: Point;
    origin: Point;
    targetWasStage: boolean;
    moved: boolean;
  } | null>(null);
  const pinchRef = useRef<{
    startDistance: number;
    startScale: number;
    contentPoint: Point;
  } | null>(null);
  const [transform, setTransform] = useState<Transform>({ scale: 1, x: 0, y: 0 });

  const updateTransform = useCallback((next: Transform | ((current: Transform) => Transform)) => {
    setTransform((current) => {
      const computed = typeof next === "function" ? next(current) : next;
      const normalized = {
        scale: clampScale(computed.scale),
        x: computed.scale <= MIN_SCALE ? 0 : computed.x,
        y: computed.scale <= MIN_SCALE ? 0 : computed.y,
      };
      transformRef.current = normalized;
      return normalized;
    });
  }, []);

  const resetTransform = useCallback(() => {
    activePointersRef.current.clear();
    dragRef.current = null;
    pinchRef.current = null;
    updateTransform({ scale: 1, x: 0, y: 0 });
  }, [updateTransform]);

  const goPrev = useCallback(() => {
    if (hasPrev) onIndexChange(currentIndex - 1);
  }, [hasPrev, currentIndex, onIndexChange]);

  const goNext = useCallback(() => {
    if (hasNext) onIndexChange(currentIndex + 1);
  }, [hasNext, currentIndex, onIndexChange]);

  const zoomAt = useCallback((clientX: number, clientY: number, nextScale: number) => {
    updateTransform((currentTransform) => {
      const scale = clampScale(nextScale);
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect || currentTransform.scale === scale) {
        return { ...currentTransform, scale };
      }
      const pointX = clientX - rect.left - rect.width / 2;
      const pointY = clientY - rect.top - rect.height / 2;
      const ratio = scale / currentTransform.scale;
      return {
        scale,
        x: pointX - (pointX - currentTransform.x) * ratio,
        y: pointY - (pointY - currentTransform.y) * ratio,
      };
    });
  }, [updateTransform]);

  const zoomFromCenter = useCallback((direction: "in" | "out") => {
    const rect = stageRef.current?.getBoundingClientRect();
    const currentTransform = transformRef.current;
    const nextScale =
      direction === "in"
        ? currentTransform.scale * 1.3
        : currentTransform.scale / 1.3;
    zoomAt(
      rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
      rect ? rect.top + rect.height / 2 : window.innerHeight / 2,
      nextScale,
    );
  }, [zoomAt]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, goPrev, goNext]);

  useEffect(() => {
    if (!open) return;
    resetTransform();
  }, [open, current?.src, resetTransform]);

  const handleDownload = useCallback(() => {
    if (!current) return;
    const link = document.createElement("a");
    link.href = current.src;
    link.download = `image-${current.id}.png`;
    link.click();
  }, [current]);

  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const currentScale = transformRef.current.scale;
    const nextScale = event.deltaY < 0 ? currentScale * WHEEL_ZOOM_STEP : currentScale / WHEEL_ZOOM_STEP;
    zoomAt(event.clientX, event.clientY, nextScale);
  }, [zoomAt]);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const point = { x: event.clientX, y: event.clientY };
    activePointersRef.current.set(event.pointerId, point);
    event.currentTarget.setPointerCapture(event.pointerId);

    if (activePointersRef.current.size === 1) {
      dragRef.current = {
        pointerId: event.pointerId,
        start: point,
        origin: { x: transformRef.current.x, y: transformRef.current.y },
        targetWasStage: event.target === event.currentTarget,
        moved: false,
      };
      return;
    }

    if (activePointersRef.current.size === 2) {
      const points = Array.from(activePointersRef.current.values());
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      const center = {
        x: (points[0].x + points[1].x) / 2 - rect.left - rect.width / 2,
        y: (points[0].y + points[1].y) / 2 - rect.top - rect.height / 2,
      };
      const currentTransform = transformRef.current;
      pinchRef.current = {
        startDistance: Math.max(1, distance(points[0], points[1])),
        startScale: currentTransform.scale,
        contentPoint: {
          x: (center.x - currentTransform.x) / currentTransform.scale,
          y: (center.y - currentTransform.y) / currentTransform.scale,
        },
      };
      dragRef.current = null;
    }
  }, []);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!activePointersRef.current.has(event.pointerId)) return;
    const nextPoint = { x: event.clientX, y: event.clientY };
    activePointersRef.current.set(event.pointerId, nextPoint);

    if (activePointersRef.current.size >= 2 && pinchRef.current) {
      const points = Array.from(activePointersRef.current.values()).slice(0, 2);
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      const center = {
        x: (points[0].x + points[1].x) / 2 - rect.left - rect.width / 2,
        y: (points[0].y + points[1].y) / 2 - rect.top - rect.height / 2,
      };
      const nextScale = clampScale(
        pinchRef.current.startScale * (distance(points[0], points[1]) / pinchRef.current.startDistance),
      );
      updateTransform({
        scale: nextScale,
        x: center.x - pinchRef.current.contentPoint.x * nextScale,
        y: center.y - pinchRef.current.contentPoint.y * nextScale,
      });
      return;
    }

    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.start.x;
    const dy = event.clientY - drag.start.y;
    if (Math.hypot(dx, dy) > 5) {
      drag.moved = true;
    }
    if (drag.targetWasStage || transformRef.current.scale <= MIN_SCALE) {
      return;
    }
    updateTransform({
      scale: transformRef.current.scale,
      x: drag.origin.x + dx,
      y: drag.origin.y + dy,
    });
  }, [updateTransform]);

  const handlePointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const activeCount = activePointersRef.current.size;
    activePointersRef.current.delete(event.pointerId);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Browser may already have released the pointer during a gesture.
    }

    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      const dx = event.clientX - drag.start.x;
      const dy = event.clientY - drag.start.y;
      const isTap = Math.hypot(dx, dy) <= 5 && !drag.moved;
      if (drag.targetWasStage && activeCount === 1 && isTap) {
        onOpenChange(false);
      }
      dragRef.current = null;
    }

    if (activePointersRef.current.size < 2) {
      pinchRef.current = null;
    }
  }, [onOpenChange]);

  const handleDoubleClick = useCallback((event: MouseEvent<HTMLImageElement>) => {
    event.stopPropagation();
    const currentScale = transformRef.current.scale;
    if (currentScale > 1.05) {
      resetTransform();
      return;
    }
    zoomAt(event.clientX, event.clientY, 2.5);
  }, [resetTransform, zoomAt]);

  if (!current) return null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex items-center justify-center outline-none"
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">
            图片预览
          </DialogPrimitive.Title>

          {/* toolbar */}
          <div className="absolute top-4 right-4 left-4 z-10 flex flex-wrap items-center justify-end gap-2">
            {current.sizeLabel || current.dimensions ? (
              <span className="rounded-full bg-black/50 px-3 py-1.5 text-xs font-medium text-white/90">
                {[current.sizeLabel, current.dimensions].filter(Boolean).join(" · ")}
              </span>
            ) : null}
            {images.length > 1 && (
              <span className="rounded-full bg-black/50 px-3 py-1.5 text-xs font-medium text-white/90">
                {currentIndex + 1} / {images.length}
              </span>
            )}
            <span className="rounded-full bg-black/50 px-3 py-1.5 text-xs font-medium text-white/90">
              {Math.round(transform.scale * 100)}%
            </span>
            <button
              type="button"
              onClick={() => zoomFromCenter("out")}
              className="inline-flex size-9 items-center justify-center rounded-full bg-black/50 text-white/90 transition hover:bg-black/70 disabled:opacity-40"
              aria-label="缩小图片"
              disabled={transform.scale <= MIN_SCALE}
            >
              <ZoomOut className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => zoomFromCenter("in")}
              className="inline-flex size-9 items-center justify-center rounded-full bg-black/50 text-white/90 transition hover:bg-black/70 disabled:opacity-40"
              aria-label="放大图片"
              disabled={transform.scale >= MAX_SCALE}
            >
              <ZoomIn className="size-4" />
            </button>
            <button
              type="button"
              onClick={resetTransform}
              className="inline-flex size-9 items-center justify-center rounded-full bg-black/50 text-white/90 transition hover:bg-black/70"
              aria-label="重置缩放"
            >
              <RotateCcw className="size-4" />
            </button>
            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex size-9 items-center justify-center rounded-full bg-black/50 text-white/90 transition hover:bg-black/70"
              aria-label="下载图片"
            >
              <Download className="size-4" />
            </button>
            <DialogPrimitive.Close className="inline-flex size-9 items-center justify-center rounded-full bg-black/50 text-white/90 transition hover:bg-black/70">
              <X className="size-4" />
              <span className="sr-only">关闭</span>
            </DialogPrimitive.Close>
          </div>

          {/* prev */}
          {hasPrev && (
            <button
              type="button"
              onClick={goPrev}
              className="absolute left-4 z-10 inline-flex size-10 items-center justify-center rounded-full bg-black/40 text-white/90 transition hover:bg-black/60"
              aria-label="上一张"
            >
              <ChevronLeft className="size-5" />
            </button>
          )}

          {/* image */}
          <div
            ref={stageRef}
            className={cn(
              "absolute inset-0 flex touch-none select-none items-center justify-center overflow-hidden px-4 py-20",
              transform.scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
            )}
            onWheel={handleWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            <img
              src={current.src}
              alt=""
              className="max-h-[88vh] max-w-[92vw] rounded-lg object-contain shadow-2xl"
              style={{
                transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
                transformOrigin: "center center",
              }}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={handleDoubleClick}
              draggable={false}
            />
          </div>

          {/* next */}
          {hasNext && (
            <button
              type="button"
              onClick={goNext}
              className="absolute right-4 z-10 inline-flex size-10 items-center justify-center rounded-full bg-black/40 text-white/90 transition hover:bg-black/60"
              aria-label="下一张"
            >
              <ChevronRight className="size-5" />
            </button>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
