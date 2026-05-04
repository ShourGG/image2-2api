"use client";

import localforage from "localforage";

import type { ImageGenerationMode, ImageModel, ImageQuality } from "@/lib/api";

export type ImageConversationMode = "generate" | "edit";

export type StoredReferenceImage = {
  name: string;
  type: string;
  dataUrl: string;
};

export type StoredImage = {
  id: string;
  taskId?: string;
  status?: "loading" | "success" | "error";
  taskStatus?: "queued" | "running";
  queuePosition?: number;
  queueAhead?: number;
  queueTotal?: number;
  estimatedWaitSeconds?: number;
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
  error?: string;
};

export type ImageTurnStatus = "queued" | "generating" | "success" | "error";

export type ImageTurn = {
  id: string;
  prompt: string;
  model: ImageModel;
  mode: ImageConversationMode;
  referenceImages: StoredReferenceImage[];
  count: number;
  size: string;
  quality: ImageQuality;
  generationMode: ImageGenerationMode;
  images: StoredImage[];
  createdAt: string;
  status: ImageTurnStatus;
  queuePosition?: number;
  queueAhead?: number;
  queueTotal?: number;
  estimatedWaitSeconds?: number;
  error?: string;
};

export type ImageConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ImageTurn[];
};

export type ImageConversationStats = {
  queued: number;
  running: number;
};

const imageConversationStorage = localforage.createInstance({
  name: "chatgpt2api",
  storeName: "image_conversations",
});

const IMAGE_CONVERSATIONS_KEY_PREFIX = "items:";
let imageConversationWriteQueue: Promise<void> = Promise.resolve();

function normalizeScopeId(scopeId: string) {
  return String(scopeId || "").trim() || "default";
}

function getImageConversationsKey(scopeId: string) {
  return `${IMAGE_CONVERSATIONS_KEY_PREFIX}${normalizeScopeId(scopeId)}`;
}

function normalizeStoredImageUrl(value: unknown): string | undefined {
  const url = typeof value === "string" ? value.trim() : "";
  if (!url) {
    return undefined;
  }
  if (typeof window === "undefined") {
    return url;
  }

  try {
    const currentUrl = new URL(window.location.href);
    const imageUrl = new URL(url, currentUrl.origin);
    if (
      imageUrl.hostname === "image.shour.fun" &&
      imageUrl.pathname.startsWith("/images/") &&
      currentUrl.hostname !== imageUrl.hostname
    ) {
      return `${currentUrl.origin}${imageUrl.pathname}${imageUrl.search}${imageUrl.hash}`;
    }
  } catch {
    return url;
  }
  return url;
}

function normalizeStoredImage(image: StoredImage): StoredImage {
  const normalized = {
    ...image,
    taskId: typeof image.taskId === "string" && image.taskId ? image.taskId : undefined,
    taskStatus: image.taskStatus === "queued" || image.taskStatus === "running" ? image.taskStatus : undefined,
    queuePosition: Number.isFinite(Number(image.queuePosition)) ? Number(image.queuePosition) : undefined,
    queueAhead: Number.isFinite(Number(image.queueAhead)) ? Number(image.queueAhead) : undefined,
    queueTotal: Number.isFinite(Number(image.queueTotal)) ? Number(image.queueTotal) : undefined,
    estimatedWaitSeconds: Number.isFinite(Number(image.estimatedWaitSeconds))
      ? Number(image.estimatedWaitSeconds)
      : undefined,
    url: normalizeStoredImageUrl(image.url),
    revised_prompt: typeof image.revised_prompt === "string" ? image.revised_prompt : undefined,
  };
  if (image.status === "loading" || image.status === "error" || image.status === "success") {
    return normalized;
  }
  return {
    ...normalized,
    status: image.b64_json || image.url ? "success" : "loading",
  };
}

function normalizeReferenceImage(image: StoredReferenceImage): StoredReferenceImage {
  return {
    name: image.name || "reference.png",
    type: image.type || "image/png",
    dataUrl: image.dataUrl,
  };
}

function normalizeGenerationMode(value: unknown): ImageGenerationMode {
  return value === "paid" ? "paid" : "free";
}

function dataUrlMimeType(dataUrl: string) {
  const match = dataUrl.match(/^data:(.*?);base64,/);
  return match?.[1] || "image/png";
}

function getLegacyReferenceImages(source: Record<string, unknown>): StoredReferenceImage[] {
  if (Array.isArray(source.referenceImages)) {
    return source.referenceImages
      .filter((image): image is StoredReferenceImage => {
        if (!image || typeof image !== "object") {
          return false;
        }
        const candidate = image as StoredReferenceImage;
        return typeof candidate.dataUrl === "string" && candidate.dataUrl.length > 0;
      })
      .map(normalizeReferenceImage);
  }

  if (source.sourceImage && typeof source.sourceImage === "object") {
    const image = source.sourceImage as { dataUrl?: unknown; fileName?: unknown };
    if (typeof image.dataUrl === "string" && image.dataUrl) {
      return [
        {
          name: typeof image.fileName === "string" && image.fileName ? image.fileName : "reference.png",
          type: dataUrlMimeType(image.dataUrl),
          dataUrl: image.dataUrl,
        },
      ];
    }
  }

  return [];
}

function normalizeTurn(turn: ImageTurn & Record<string, unknown>): ImageTurn {
  const normalizedImages = Array.isArray(turn.images) ? turn.images.map(normalizeStoredImage) : [];
  const loadingImages = normalizedImages.filter((image) => image.status === "loading");
  const queuedImages = loadingImages.filter((image) => image.taskStatus === "queued");
  const runningImages = loadingImages.filter((image) => image.taskStatus === "running");
  const queuePositionValues = queuedImages
    .map((image) => image.queuePosition)
    .filter((value): value is number => typeof value === "number" && value >= 1);
  const queueAheadValues = queuedImages
    .map((image) => image.queueAhead)
    .filter((value): value is number => typeof value === "number" && value >= 0);
  const queueTotalValues = queuedImages
    .map((image) => image.queueTotal)
    .filter((value): value is number => typeof value === "number" && value >= 1);
  const waitValues = queuedImages
    .map((image) => image.estimatedWaitSeconds)
    .filter((value): value is number => typeof value === "number" && value >= 0);
  const derivedStatus: ImageTurnStatus =
    loadingImages.length > 0
      ? queuedImages.length === loadingImages.length && runningImages.length === 0
        ? "queued"
        : "generating"
      : normalizedImages.some((image) => image.status === "error")
        ? "error"
        : "success";

  return {
    id: String(turn.id || `${Date.now()}`),
    prompt: String(turn.prompt || ""),
    model: (turn.model as ImageModel) || "gpt-image-2",
    mode: turn.mode === "edit" ? "edit" : "generate",
    referenceImages: getLegacyReferenceImages(turn),
    count: Math.max(1, Number(turn.count || normalizedImages.length || 1)),
    size: typeof turn.size === "string" ? turn.size : "",
    quality: turn.quality === "xhigh" ? "xhigh" : turn.quality === "high" ? "high" : "standard",
    generationMode: normalizeGenerationMode(turn.generationMode ?? turn.generation_mode),
    images: normalizedImages,
    createdAt: String(turn.createdAt || new Date().toISOString()),
    status:
      turn.status === "queued" ||
      turn.status === "generating" ||
      turn.status === "success" ||
      turn.status === "error"
        ? turn.status
        : derivedStatus,
    queuePosition:
      queuePositionValues.length > 0 ? Math.min(...queuePositionValues) : undefined,
    queueAhead:
      queueAheadValues.length > 0 ? Math.min(...queueAheadValues) : undefined,
    queueTotal:
      queueTotalValues.length > 0 ? Math.max(...queueTotalValues) : undefined,
    estimatedWaitSeconds:
      waitValues.length > 0 ? Math.min(...waitValues) : undefined,
    error: typeof turn.error === "string" ? turn.error : undefined,
  };
}

function normalizeConversation(conversation: ImageConversation & Record<string, unknown>): ImageConversation {
  const turns = Array.isArray(conversation.turns)
    ? conversation.turns.map((turn) => normalizeTurn(turn as ImageTurn & Record<string, unknown>))
    : [
        normalizeTurn({
          id: String(conversation.id || `${Date.now()}`),
          prompt: String(conversation.prompt || ""),
          model: (conversation.model as ImageModel) || "gpt-image-2",
          mode: conversation.mode === "edit" ? "edit" : "generate",
          referenceImages: getLegacyReferenceImages(conversation),
          count: Number(conversation.count || 1),
          size: typeof conversation.size === "string" ? conversation.size : "",
          quality: conversation.quality === "xhigh" ? "xhigh" : conversation.quality === "high" ? "high" : "standard",
          generationMode: normalizeGenerationMode(conversation.generationMode ?? conversation.generation_mode),
          images: Array.isArray(conversation.images) ? (conversation.images as StoredImage[]) : [],
          createdAt: String(conversation.createdAt || new Date().toISOString()),
          status:
            conversation.status === "generating" || conversation.status === "success" || conversation.status === "error"
              ? conversation.status
              : "success",
          error: typeof conversation.error === "string" ? conversation.error : undefined,
        }),
      ];
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;

  return {
    id: String(conversation.id || `${Date.now()}`),
    title: String(conversation.title || ""),
    createdAt: String(conversation.createdAt || lastTurn?.createdAt || new Date().toISOString()),
    updatedAt: String(conversation.updatedAt || lastTurn?.createdAt || new Date().toISOString()),
    turns,
  };
}

function sortImageConversations(conversations: ImageConversation[]): ImageConversation[] {
  return [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function getTimestamp(value: string) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function pickLatestConversation(current: ImageConversation, next: ImageConversation) {
  return getTimestamp(next.updatedAt) >= getTimestamp(current.updatedAt) ? next : current;
}

function queueImageConversationWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = imageConversationWriteQueue.then(operation);
  imageConversationWriteQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function readStoredImageConversations(scopeId: string): Promise<ImageConversation[]> {
  const items =
    (await imageConversationStorage.getItem<Array<ImageConversation & Record<string, unknown>>>(
      getImageConversationsKey(scopeId),
    )) || [];
  return items.map(normalizeConversation);
}

export async function listImageConversations(scopeId: string): Promise<ImageConversation[]> {
  return sortImageConversations(await readStoredImageConversations(scopeId));
}

export async function saveImageConversations(scopeId: string, conversations: ImageConversation[]): Promise<void> {
  await queueImageConversationWrite(async () => {
    const items = await readStoredImageConversations(scopeId);
    const conversationMap = new Map(items.map((item) => [item.id, item]));
    for (const conversation of conversations.map(normalizeConversation)) {
      const current = conversationMap.get(conversation.id);
      conversationMap.set(conversation.id, current ? pickLatestConversation(current, conversation) : conversation);
    }
    await imageConversationStorage.setItem(
      getImageConversationsKey(scopeId),
      sortImageConversations([...conversationMap.values()]),
    );
  });
}

export async function saveImageConversation(scopeId: string, conversation: ImageConversation): Promise<void> {
  await queueImageConversationWrite(async () => {
    const items = await readStoredImageConversations(scopeId);
    const nextConversation = normalizeConversation(conversation);
    const current = items.find((item) => item.id === nextConversation.id);
    const persistedConversation = current ? pickLatestConversation(current, nextConversation) : nextConversation;
    const nextItems = sortImageConversations([
      persistedConversation,
      ...items.filter((item) => item.id !== persistedConversation.id),
    ]);
    await imageConversationStorage.setItem(getImageConversationsKey(scopeId), nextItems);
  });
}

export async function deleteImageConversation(scopeId: string, id: string): Promise<void> {
  await queueImageConversationWrite(async () => {
    const items = await readStoredImageConversations(scopeId);
    await imageConversationStorage.setItem(
      getImageConversationsKey(scopeId),
      items.filter((item) => item.id !== id),
    );
  });
}

export async function clearImageConversations(scopeId: string): Promise<void> {
  await queueImageConversationWrite(async () => {
    await imageConversationStorage.removeItem(getImageConversationsKey(scopeId));
  });
}

export function getImageConversationStats(conversation: ImageConversation | null): ImageConversationStats {
  if (!conversation) {
    return { queued: 0, running: 0 };
  }

  return conversation.turns.reduce(
    (acc, turn) => {
      if (turn.status === "queued") {
        acc.queued += 1;
      } else if (turn.status === "generating") {
        acc.running += 1;
      }
      return acc;
    },
    { queued: 0, running: 0 },
  );
}
