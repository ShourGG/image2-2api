"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ImageComposer } from "@/app/image/components/image-composer";
import { ImageResults, type ImageLightboxItem } from "@/app/image/components/image-results";
import { ImageSidebar } from "@/app/image/components/image-sidebar";
import { ImageLightbox } from "@/components/image-lightbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  createImageEditTasksBatch,
  createImageGenerationTasksBatch,
  fetchAccounts,
  fetchCurrentUser,
  fetchImageApiUpstreamUsage,
  fetchImageTasks,
  fetchSettingsConfig,
  type Account,
  type ImageGenerationMode,
  type ImageQuality,
  type ImageSizeTier,
  type ImageTask,
} from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import {
  clearImageConversations,
  deleteImageConversation,
  getImageConversationStats,
  listImageConversations,
  saveImageConversation,
  saveImageConversations,
  type ImageConversation,
  type ImageConversationMode,
  type ImageTurn,
  type ImageTurnStatus,
  type StoredImage,
  type StoredReferenceImage,
} from "@/store/image-conversations";
import type { StoredAuthSession } from "@/store/auth";

const activeConversationQueueIds = new Set<string>();

function imageStorageScope(session: StoredAuthSession) {
  return `${session.role}:${session.subjectId || "anonymous"}`;
}

function activeConversationStorageKey(scope: string) {
  return `chatgpt2api:image_active_conversation_id:${scope}`;
}

function imageSizeStorageKey(scope: string) {
  return `chatgpt2api:image_last_size:${scope}`;
}

function imageQualityStorageKey(scope: string) {
  return `chatgpt2api:image_last_quality:${scope}`;
}

function imageGenerationModeStorageKey(scope: string) {
  return `chatgpt2api:image_last_generation_mode:${scope}`;
}

function buildConversationTitle(prompt: string) {
  const trimmed = prompt.trim();
  if (trimmed.length <= 12) {
    return trimmed;
  }
  return `${trimmed.slice(0, 12)}...`;
}

function formatConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function isScrolledNearBottom(element: HTMLDivElement, threshold = 96) {
  const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
  return remaining <= threshold;
}

function formatAvailableQuota(accounts: Account[]) {
  const availableAccounts = accounts.filter((account) => account.status !== "禁用");
  return String(availableAccounts.reduce((sum, account) => sum + Math.max(0, account.quota), 0));
}

function formatPoints(value?: number | null) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) {
    return "0";
  }
  return numeric.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function formatCompactNumber(value?: unknown) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) {
    return "";
  }
  return numeric.toFixed(4).replace(/\.?0+$/, "");
}

function numericOrNull(value?: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

const DEFAULT_IMAGE_POINT_COST_TABLE: Record<ImageSizeTier, Record<ImageQuality, number>> = {
  normal: { standard: 5, high: 20, xhigh: 25 },
  "2k": { standard: 15, high: 40, xhigh: 50 },
  "4k": { standard: 30, high: 80, xhigh: 100 },
};

const DEFAULT_PAID_COIN_COST_TABLE: Record<ImageSizeTier, Record<ImageQuality, number>> = {
  normal: { standard: 50, high: 80, xhigh: 100 },
  "2k": { standard: 100, high: 150, xhigh: 200 },
  "4k": { standard: 200, high: 350, xhigh: 500 },
};

const OPENAI_COMPATIBLE_ESTIMATED_COST_TABLE: Record<ImageSizeTier, Record<ImageQuality, number>> = {
  normal: { standard: 0.201, high: 0.3015, xhigh: 0.402 },
  "2k": { standard: 0.3015, high: 0.402, xhigh: 0.603 },
  "4k": { standard: 0.402, high: 0.804, xhigh: 1.206 },
};

type QuotaSource = "loading" | "user_points" | "account_pool" | "openai_compatible" | "error";

type OpenAICompatibleUsageSummary = {
  upstreamName: string;
  ok: boolean;
  balance: number | null;
  balanceText: string;
  unit: string;
  requestCount: number;
  actualCost: number;
  modeHint: string;
  errorHint: string;
};

function getImageSizeTier(size: string): ImageSizeTier {
  const mapped = {
    "1:1": "1024x1024",
    "16:9": "1536x1024",
    "4:3": "1536x1024",
    "9:16": "1024x1536",
    "3:4": "1024x1536",
  }[size] || size;
  const match = mapped.match(/^(\d+)x(\d+)$/);
  if (!match) {
    return "normal";
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const maxEdge = Math.max(width, height);
  const totalPixels = width * height;
  if (maxEdge >= 3600 || totalPixels >= 7_000_000) {
    return "4k";
  }
  if (maxEdge >= 2048 || totalPixels >= 2_000_000) {
    return "2k";
  }
  return "normal";
}

function getImagePointCost(
  table: Record<ImageSizeTier, Record<ImageQuality, number>>,
  size: string,
  quality: ImageQuality,
) {
  return table[getImageSizeTier(size)]?.[quality] ?? table.normal.standard;
}

function bonusAllowedForRequest(size: string, quality: ImageQuality) {
  return true;
}

function getEstimatedOpenAICompatibleCost(size: string, quality: ImageQuality) {
  return OPENAI_COMPATIBLE_ESTIMATED_COST_TABLE[getImageSizeTier(size)]?.[quality] ?? OPENAI_COMPATIBLE_ESTIMATED_COST_TABLE.normal.standard;
}

function formatUsageMoney(value: number | null, unit: string) {
  if (value === null) {
    return "";
  }
  const formatted = formatCompactNumber(value);
  if (!formatted) {
    return "";
  }
  return unit.toUpperCase() === "USD" ? `$${formatted}` : `${formatted}${unit ? ` ${unit}` : ""}`;
}

function extractUsageCostStats(data: Record<string, unknown>) {
  let requestCount = 0;
  let actualCost = 0;
  const modelStats = Array.isArray(data.model_stats) ? data.model_stats : [];
  modelStats.forEach((item) => {
    if (!item || typeof item !== "object") {
      return;
    }
    const row = item as Record<string, unknown>;
    const rowRequests = numericOrNull(row.requests ?? row.request_count ?? row.count);
    const rowCost = numericOrNull(row.actual_cost ?? row.cost ?? row.total_cost);
    if (rowRequests && rowRequests > 0 && rowCost && rowCost > 0) {
      requestCount += rowRequests;
      actualCost += rowCost;
    }
  });
  if (requestCount > 0 && actualCost > 0) {
    return { requestCount, actualCost };
  }

  const usage = data.usage && typeof data.usage === "object" ? (data.usage as Record<string, unknown>) : null;
  const total = usage?.total && typeof usage.total === "object" ? (usage.total as Record<string, unknown>) : null;
  const totalRequests = numericOrNull(total?.requests ?? total?.request_count ?? data.requests ?? data.request_count);
  const totalCost = numericOrNull(total?.actual_cost ?? total?.cost ?? data.actual_cost ?? data.cost);
  if (totalRequests && totalRequests > 0 && totalCost && totalCost > 0) {
    return { requestCount: totalRequests, actualCost: totalCost };
  }

  return { requestCount: 0, actualCost: 0 };
}

function summarizeOpenAICompatibleUsage(
  result: { ok: boolean; usage?: unknown; error?: unknown },
  upstreamName: string,
): OpenAICompatibleUsageSummary {
  if (!result.ok) {
    return {
      upstreamName,
      ok: false,
      balance: null,
      balanceText: "--",
      unit: "",
      requestCount: 0,
      actualCost: 0,
      modeHint: "",
      errorHint: "上游 /v1/usage 不可用",
    };
  }
  const usage = result.usage;
  if (!usage || typeof usage !== "object") {
    return {
      upstreamName,
      ok: false,
      balance: null,
      balanceText: "--",
      unit: "",
      requestCount: 0,
      actualCost: 0,
      modeHint: "",
      errorHint: "上游未返回余额",
    };
  }
  const data = usage as Record<string, unknown>;
  const quota = data.quota && typeof data.quota === "object" ? (data.quota as Record<string, unknown>) : null;
  const balance = quota ? numericOrNull(quota.remaining) : numericOrNull(data.remaining ?? data.balance);
  const unit = String((quota ? quota.unit : data.unit) || "").trim();
  const stats = extractUsageCostStats(data);
  return {
    upstreamName,
    ok: balance !== null,
    balance,
    balanceText: formatUsageMoney(balance, unit) || "--",
    unit,
    requestCount: stats.requestCount,
    actualCost: stats.actualCost,
    modeHint: typeof data.mode === "string" ? `模式 ${data.mode}` : "",
    errorHint: balance === null ? "上游未返回余额" : "",
  };
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取参考图失败"));
    reader.readAsDataURL(file);
  });
}

function dataUrlToFile(dataUrl: string, fileName: string, mimeType?: string) {
  const [header, content] = dataUrl.split(",", 2);
  const matchedMimeType = header.match(/data:(.*?);base64/)?.[1];
  const binary = atob(content || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], fileName, { type: mimeType || matchedMimeType || "image/png" });
}

function buildReferenceImageFromResult(image: StoredImage, fileName: string): StoredReferenceImage | null {
  if (!image.b64_json) {
    return null;
  }

  return {
    name: fileName,
    type: "image/png",
    dataUrl: `data:image/png;base64,${image.b64_json}`,
  };
}

async function fetchImageAsFile(url: string, fileName: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("读取结果图失败");
  }
  const blob = await response.blob();
  return new File([blob], fileName, { type: blob.type || "image/png" });
}

async function buildReferenceImageFromStoredImage(image: StoredImage, fileName: string) {
  const direct = buildReferenceImageFromResult(image, fileName);
  if (direct) {
    return {
      referenceImage: direct,
      file: dataUrlToFile(direct.dataUrl, direct.name, direct.type),
    };
  }

  if (!image.url) {
    return null;
  }
  const file = await fetchImageAsFile(image.url, fileName);
  return {
    referenceImage: {
      name: file.name,
      type: file.type || "image/png",
      dataUrl: await readFileAsDataUrl(file),
    },
    file,
  };
}

function taskDataToStoredImage(image: StoredImage, task: ImageTask): StoredImage {
  if (task.status === "success") {
    const first = task.data?.[0];
    if (!first?.b64_json && !first?.url) {
      return {
        ...image,
        taskId: task.id,
        status: "error",
        taskStatus: undefined,
        queuePosition: undefined,
        queueAhead: undefined,
        queueTotal: undefined,
        estimatedWaitSeconds: undefined,
        error: "未返回图片数据",
      };
    }
    return {
      ...image,
      taskId: task.id,
      status: "success",
      taskStatus: undefined,
      queuePosition: undefined,
      queueAhead: undefined,
      queueTotal: undefined,
      estimatedWaitSeconds: undefined,
      b64_json: first.b64_json,
      url: first.url,
      revised_prompt: first.revised_prompt,
      error: undefined,
    };
  }

  if (task.status === "error") {
    return {
      ...image,
      taskId: task.id,
      status: "error",
      taskStatus: undefined,
      queuePosition: undefined,
      queueAhead: undefined,
      queueTotal: undefined,
      estimatedWaitSeconds: undefined,
      error: task.error || "生成失败",
    };
  }

  return {
    ...image,
    taskId: task.id,
    status: "loading",
    taskStatus: task.status === "queued" ? "queued" : "running",
    queuePosition: typeof task.queue_position === "number" ? task.queue_position : undefined,
    queueAhead: typeof task.queue_ahead === "number" ? task.queue_ahead : undefined,
    queueTotal: typeof task.queue_total === "number" ? task.queue_total : undefined,
    estimatedWaitSeconds: typeof task.estimated_wait_seconds === "number" ? task.estimated_wait_seconds : undefined,
    error: undefined,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function pickFallbackConversationId(conversations: ImageConversation[]) {
  const activeConversation = conversations.find((conversation) =>
    conversation.turns.some((turn) => turn.status === "queued" || turn.status === "generating"),
  );
  return activeConversation?.id ?? conversations[0]?.id ?? null;
}

function sortImageConversations(conversations: ImageConversation[]) {
  return [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function deriveTurnStatus(
  turn: ImageTurn,
): Pick<ImageTurn, "status" | "error" | "queuePosition" | "queueAhead" | "queueTotal" | "estimatedWaitSeconds"> {
  const loadingImages = turn.images.filter((image) => image.status === "loading");
  const loadingCount = loadingImages.length;
  const failedCount = turn.images.filter((image) => image.status === "error").length;
  const successCount = turn.images.filter((image) => image.status === "success").length;
  const queuedImages = loadingImages.filter((image) => image.taskStatus === "queued");
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
  const queueMeta = {
    queuePosition: queuePositionValues.length > 0 ? Math.min(...queuePositionValues) : undefined,
    queueAhead: queueAheadValues.length > 0 ? Math.min(...queueAheadValues) : undefined,
    queueTotal: queueTotalValues.length > 0 ? Math.max(...queueTotalValues) : undefined,
    estimatedWaitSeconds: waitValues.length > 0 ? Math.min(...waitValues) : undefined,
  };
  if (loadingCount > 0) {
    if (queuedImages.length === loadingCount) {
      return {
        status: "queued",
        error: undefined,
        ...queueMeta,
      };
    }
    return {
      status: turn.status === "queued" && queuedImages.length === 0 ? "queued" : "generating",
      error: undefined,
      queuePosition: undefined,
      queueAhead: undefined,
      queueTotal: undefined,
      estimatedWaitSeconds: undefined,
    };
  }
  if (failedCount > 0) {
    return {
      status: "error",
      error: `其中 ${failedCount} 张未成功生成`,
      queuePosition: undefined,
      queueAhead: undefined,
      queueTotal: undefined,
      estimatedWaitSeconds: undefined,
    };
  }
  if (successCount > 0) {
    return {
      status: "success",
      error: undefined,
      queuePosition: undefined,
      queueAhead: undefined,
      queueTotal: undefined,
      estimatedWaitSeconds: undefined,
    };
  }
  return {
    status: "queued",
    error: undefined,
    queuePosition: undefined,
    queueAhead: undefined,
    queueTotal: undefined,
    estimatedWaitSeconds: undefined,
  };
}

async function syncConversationImageTasks(storageScope: string, items: ImageConversation[]) {
  const taskIds = Array.from(
    new Set(
      items.flatMap((conversation) =>
        conversation.turns.flatMap((turn) =>
          turn.images.flatMap((image) => (image.status === "loading" && image.taskId ? [image.taskId] : [])),
        ),
      ),
    ),
  );
  if (taskIds.length === 0) {
    return items;
  }

  let taskList: Awaited<ReturnType<typeof fetchImageTasks>>;
  try {
    taskList = await fetchImageTasks(taskIds);
  } catch {
    return items;
  }
  const taskMap = new Map(taskList.items.map((task) => [task.id, task]));
  let changed = false;
  const normalized = items.map((conversation) => {
    const turns = conversation.turns.map((turn) => {
      let turnChanged = false;
      const images = turn.images.map((image) => {
        if (image.status !== "loading" || !image.taskId) {
          return image;
        }
        const task = taskMap.get(image.taskId);
        if (!task) {
          return image;
        }
        const nextImage = taskDataToStoredImage(image, task);
        if (nextImage !== image) {
          turnChanged = true;
        }
        return nextImage;
      });
      if (!turnChanged) {
        return turn;
      }
      changed = true;
      const derived = deriveTurnStatus({ ...turn, images });
      return {
        ...turn,
        ...derived,
        images,
      };
    });
    if (turns === conversation.turns || !turns.some((turn, index) => turn !== conversation.turns[index])) {
      return conversation;
    }
    return {
      ...conversation,
      turns,
      updatedAt: new Date().toISOString(),
    };
  });

  if (changed) {
    await saveImageConversations(storageScope, normalized);
  }
  return normalized;
}

async function recoverConversationHistory(storageScope: string, items: ImageConversation[]) {
  let changed = false;
  const normalized = items.map((conversation) => {
    const turns = conversation.turns.map((turn) => {
      if (turn.status !== "queued" && turn.status !== "generating") {
        return turn;
      }

      let turnChanged = false;
      const images = turn.images.map((image) => {
        if (image.status !== "loading" || image.taskId) {
          return image;
        }
        turnChanged = true;
        return {
          ...image,
          status: "error" as const,
          error: "页面刷新或任务中断，未找到可恢复的任务 ID",
        };
      });
      const derived = deriveTurnStatus({ ...turn, images });
      if (!turnChanged && derived.status === turn.status && derived.error === turn.error) {
        return turn;
      }
      changed = true;
      return {
        ...turn,
        ...derived,
        images,
      };
    });

    if (!turns.some((turn, index) => turn !== conversation.turns[index])) {
      return conversation;
    }

    return {
      ...conversation,
      turns,
      updatedAt: new Date().toISOString(),
    };
  });

  if (changed) {
    await saveImageConversations(storageScope, normalized);
  }

  return syncConversationImageTasks(storageScope, normalized);
}


function ImagePageContent({ session }: { session: StoredAuthSession }) {
  const didLoadQuotaRef = useRef(false);
  const quotaRequestIdRef = useRef(0);
  const quotaSourceRef = useRef<QuotaSource>("loading");
  const openAICompatibleUsagesRef = useRef<OpenAICompatibleUsageSummary[]>([]);
  const conversationsRef = useRef<ImageConversation[]>([]);
  const resultsViewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastAutoScrollConversationIdRef = useRef<string | null>(null);
  const lastAutoScrollTurnCountRef = useRef(0);
  const storageScope = useMemo(() => imageStorageScope(session), [session]);
  const activeConversationKey = useMemo(() => activeConversationStorageKey(storageScope), [storageScope]);
  const imageSizeKey = useMemo(() => imageSizeStorageKey(storageScope), [storageScope]);
  const imageQualityKey = useMemo(() => imageQualityStorageKey(storageScope), [storageScope]);
  const imageGenerationModeKey = useMemo(() => imageGenerationModeStorageKey(storageScope), [storageScope]);

  const [imagePrompt, setImagePrompt] = useState("");
  const [imageCount, setImageCount] = useState("1");
  const [imageSize, setImageSize] = useState("");
  const [imageQuality, setImageQuality] = useState<ImageQuality>("standard");
  const [imageGenerationMode, setImageGenerationMode] = useState<ImageGenerationMode>("free");
  const [imagePointCostTable, setImagePointCostTable] = useState(DEFAULT_IMAGE_POINT_COST_TABLE);
  const [paidCoinCostTable, setPaidCoinCostTable] = useState(DEFAULT_PAID_COIN_COST_TABLE);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [referenceImageFiles, setReferenceImageFiles] = useState<File[]>([]);
  const [referenceImages, setReferenceImages] = useState<StoredReferenceImage[]>([]);
  const [conversations, setConversations] = useState<ImageConversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [quotaSource, setQuotaSource] = useState<QuotaSource>("loading");
  const [quotaErrorHint, setQuotaErrorHint] = useState("");
  const [userPoints, setUserPoints] = useState<number | null>(null);
  const [userPaidCoins, setUserPaidCoins] = useState<number | null>(null);
  const [userPaidBonusUses, setUserPaidBonusUses] = useState<number | null>(null);
  const [accountPoolQuota, setAccountPoolQuota] = useState<number | null>(null);
  const [openAICompatibleUsages, setOpenAICompatibleUsages] = useState<OpenAICompatibleUsageSummary[]>([]);
  const [lightboxImages, setLightboxImages] = useState<ImageLightboxItem[]>([]);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: "one"; id: string } | { type: "all" } | null>(null);

  const parsedCount = useMemo(() => Math.max(1, Math.min(10, Number(imageCount) || 1)), [imageCount]);
  const currentPointCost = useMemo(
    () => getImagePointCost(imagePointCostTable, imageSize, imageQuality),
    [imagePointCostTable, imageQuality, imageSize],
  );
  const currentPaidCoinCost = useMemo(
    () => getImagePointCost(paidCoinCostTable, imageSize, imageQuality),
    [imageQuality, imageSize, paidCoinCostTable],
  );
  const currentUpstreamEstimatedCost = useMemo(
    () => getEstimatedOpenAICompatibleCost(imageSize, imageQuality),
    [imageQuality, imageSize],
  );
  const quotaDisplay = useMemo(() => {
    if (quotaSource === "user_points") {
      if (imageGenerationMode === "paid") {
        const coins = Math.max(0, Number(userPaidCoins ?? 0));
        const bonusUses = Math.max(0, Number(userPaidBonusUses ?? 0));
        const usableBonusUses = bonusAllowedForRequest(imageSize, imageQuality) ? bonusUses : 0;
        const coinCount = currentPaidCoinCost > 0 ? Math.floor(coins / currentPaidCoinCost) : 0;
        return {
          label: "可生成",
          value: `${usableBonusUses + coinCount}张`,
          hint: `图币 ${formatPoints(coins)} · 体验券 ${bonusUses} · ${formatPoints(currentPaidCoinCost)} 图币/张`,
        };
      }
      const points = Math.max(0, Number(userPoints ?? 0));
      const count = currentPointCost > 0 ? Math.floor(points / currentPointCost) : 0;
      return {
        label: "可生成",
        value: `${count}张`,
        hint: `剩余 ${formatPoints(points)} 积分 · ${formatPoints(currentPointCost)} 积分/张`,
      };
    }

    if (quotaSource === "account_pool") {
      return {
        label: "可生成",
        value: accountPoolQuota === null ? "加载中..." : `${formatCompactNumber(accountPoolQuota)}张`,
        hint: "",
      };
    }

    if (quotaSource === "openai_compatible") {
      const okUsages = openAICompatibleUsages.filter((item) => item.ok && item.balance !== null);
      if (openAICompatibleUsages.length === 0) {
        return { label: "约可生成", value: "--", hint: quotaErrorHint || "未配置可用上游" };
      }

      const units = Array.from(new Set(okUsages.map((item) => item.unit || "USD")));
      const aggregateUnit = units.length === 1 ? units[0] : "USD";
      const balanceTotal =
        okUsages.length > 0 && units.length <= 1
          ? okUsages.reduce((sum, item) => sum + Math.max(0, item.balance ?? 0), 0)
          : null;
      const requestCount = okUsages.reduce((sum, item) => sum + Math.max(0, item.requestCount), 0);
      const actualCost = okUsages.reduce((sum, item) => sum + Math.max(0, item.actualCost), 0);
      const historicalAverageCost = requestCount > 0 && actualCost > 0 ? actualCost / requestCount : null;
      const canUseDefaultCost = aggregateUnit === "" || aggregateUnit.toUpperCase() === "USD";
      const estimatedCost = historicalAverageCost || (canUseDefaultCost ? currentUpstreamEstimatedCost : null);
      const estimatedImages =
        balanceTotal !== null && estimatedCost !== null && estimatedCost > 0
          ? Math.floor(Math.max(0, balanceTotal) / estimatedCost)
          : null;
      const enabledCount = openAICompatibleUsages.length;
      const okCount = okUsages.length;
      const balanceText = formatUsageMoney(balanceTotal, aggregateUnit);
      const costText = formatUsageMoney(estimatedCost, aggregateUnit || "USD");
      const hintParts = [
        enabledCount > 1 ? `${okCount}/${enabledCount} 个上游可用` : okUsages[0]?.upstreamName,
        balanceText ? `余额合计 ${balanceText}` : "",
        costText ? `${historicalAverageCost ? "历史均价" : "预估单价"} ${costText}/张` : "",
        okUsages.find((item) => item.modeHint)?.modeHint || "",
      ].filter(Boolean);

      if (estimatedImages !== null) {
        return {
          label: "约可生成",
          value: `${estimatedImages}张`,
          hint: hintParts.join(" · "),
        };
      }

      const fallbackUsage = okUsages[0];
      return {
        label: "上游余额",
        value: fallbackUsage?.balanceText || "--",
        hint: hintParts.join(" · ") || quotaErrorHint || openAICompatibleUsages.find((item) => item.errorHint)?.errorHint || "",
      };
    }

    if (quotaSource === "error") {
      return { label: "可生成", value: "--", hint: quotaErrorHint || "额度查询失败" };
    }

    return { label: "可生成", value: "加载中...", hint: "" };
  }, [
    accountPoolQuota,
    currentPointCost,
    currentPaidCoinCost,
    currentUpstreamEstimatedCost,
    imageGenerationMode,
    imageQuality,
    imageSize,
    openAICompatibleUsages,
    quotaErrorHint,
    quotaSource,
    userPaidBonusUses,
    userPaidCoins,
    userPoints,
  ]);
  const selectedConversation = useMemo(
    () => conversations.find((item) => item.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );
  const activeTaskCount = useMemo(
    () =>
      conversations.reduce((sum, conversation) => {
        const stats = getImageConversationStats(conversation);
        return sum + stats.queued + stats.running;
      }, 0),
    [conversations],
  );
  const deleteConfirmTitle = deleteConfirm?.type === "all" ? "清空历史记录" : deleteConfirm?.type === "one" ? "删除对话" : "";
  const deleteConfirmDescription =
    deleteConfirm?.type === "all"
      ? "确认删除全部图片历史记录吗？删除后无法恢复。"
      : deleteConfirm?.type === "one"
        ? "确认删除这条图片对话吗？删除后无法恢复。"
        : "";

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    quotaSourceRef.current = quotaSource;
  }, [quotaSource]);

  useEffect(() => {
    openAICompatibleUsagesRef.current = openAICompatibleUsages;
  }, [openAICompatibleUsages]);

  useEffect(() => {
    let cancelled = false;

    const loadHistory = async () => {
      try {
        const storedSize = typeof window !== "undefined" ? window.localStorage.getItem(imageSizeKey) : null;
        const storedQuality = typeof window !== "undefined" ? window.localStorage.getItem(imageQualityKey) : null;
        const storedGenerationMode = typeof window !== "undefined" ? window.localStorage.getItem(imageGenerationModeKey) : null;
        setImageSize(storedSize || "");
        setImageQuality(storedQuality === "xhigh" ? "xhigh" : storedQuality === "high" ? "high" : "standard");
        setImageGenerationMode(storedGenerationMode === "paid" ? "paid" : "free");

        const items = await listImageConversations(storageScope);
        const normalizedItems = await recoverConversationHistory(storageScope, items);
        if (cancelled) {
          return;
        }

        conversationsRef.current = normalizedItems;
        setConversations(normalizedItems);
        const storedConversationId =
          typeof window !== "undefined" ? window.localStorage.getItem(activeConversationKey) : null;
        const nextSelectedConversationId =
          (storedConversationId && normalizedItems.some((conversation) => conversation.id === storedConversationId)
            ? storedConversationId
            : null) ?? pickFallbackConversationId(normalizedItems);
        setSelectedConversationId(nextSelectedConversationId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取会话记录失败";
        toast.error(message);
      } finally {
        if (!cancelled) {
          setIsLoadingHistory(false);
        }
      }
    };

    void loadHistory();
    return () => {
      cancelled = true;
    };
  }, [activeConversationKey, imageGenerationModeKey, imageQualityKey, imageSizeKey, storageScope]);

  const loadQuota = useCallback(async () => {
    const requestId = quotaRequestIdRef.current + 1;
    quotaRequestIdRef.current = requestId;

    try {
      if (session.role === "user") {
        const data = await fetchCurrentUser();
        if (quotaRequestIdRef.current !== requestId) {
          return;
        }
        setQuotaSource("user_points");
        setQuotaErrorHint("");
        setUserPoints(Math.max(0, Number(data.item.points || 0)));
        setUserPaidCoins(Math.max(0, Number(data.item.paid_coins || 0)));
        setUserPaidBonusUses(Math.max(0, Number(data.item.paid_bonus_uses || 0)));
        setImageGenerationMode((current) => current || data.item.preferred_image_mode || "free");
        setImagePointCostTable((prev) => ({
          normal: { ...prev.normal, ...(data.billing.image_point_costs || {}), ...(data.billing.image_point_cost_table?.normal || {}) },
          "2k": { ...prev["2k"], ...(data.billing.image_point_cost_table?.["2k"] || {}) },
          "4k": { ...prev["4k"], ...(data.billing.image_point_cost_table?.["4k"] || {}) },
        }));
        setPaidCoinCostTable((prev) => ({
          normal: { ...prev.normal, ...(data.billing.paid_coin_cost_table?.normal || {}) },
          "2k": { ...prev["2k"], ...(data.billing.paid_coin_cost_table?.["2k"] || {}) },
          "4k": { ...prev["4k"], ...(data.billing.paid_coin_cost_table?.["4k"] || {}) },
        }));
        return;
      }

      const settings = await fetchSettingsConfig();
      if (quotaRequestIdRef.current !== requestId) {
        return;
      }
      const config = settings.config;
      if (config.image_generation_strategy === "openai_compatible") {
        const upstreams = (config.image_generation_api_upstreams || []).filter(
          (item) => item.enabled !== false && item.api_key_set && item.id,
        );
        if (upstreams.length === 0) {
          if (quotaRequestIdRef.current !== requestId) {
            return;
          }
          setQuotaSource("openai_compatible");
          setOpenAICompatibleUsages([]);
          setQuotaErrorHint("未配置可用上游");
          return;
        }
        const usageResults = await Promise.all(
          upstreams.map(async (upstream) => {
            try {
              const usage = await fetchImageApiUpstreamUsage(upstream.id);
              return summarizeOpenAICompatibleUsage(usage.result, upstream.name || "OpenAI兼容上游");
            } catch {
              return {
                upstreamName: upstream.name || "OpenAI兼容上游",
                ok: false,
                balance: null,
                balanceText: "--",
                unit: "",
                requestCount: 0,
                actualCost: 0,
                modeHint: "",
                errorHint: "上游 /v1/usage 查询失败",
              };
            }
          }),
        );
        if (quotaRequestIdRef.current !== requestId) {
          return;
        }
        const hasUsableUsage = usageResults.some((item) => item.ok);
        setQuotaSource("openai_compatible");
        if (hasUsableUsage) {
          setOpenAICompatibleUsages(usageResults);
          setQuotaErrorHint("");
          return;
        }

        if (
          quotaSourceRef.current !== "openai_compatible" ||
          openAICompatibleUsagesRef.current.length === 0
        ) {
          setOpenAICompatibleUsages(usageResults);
        }
        setQuotaErrorHint(usageResults.find((item) => item.errorHint)?.errorHint || "上游额度查询失败");
        return;
      }

      const data = await fetchAccounts();
      if (quotaRequestIdRef.current !== requestId) {
        return;
      }
      setQuotaSource("account_pool");
      setQuotaErrorHint("");
      setAccountPoolQuota(Number(formatAvailableQuota(data.items)) || 0);
    } catch {
      if (quotaRequestIdRef.current !== requestId) {
        return;
      }
      if (quotaSourceRef.current === "openai_compatible" && openAICompatibleUsagesRef.current.length > 0) {
        setQuotaErrorHint("上游额度刷新失败");
        return;
      }
      setQuotaSource("error");
      setQuotaErrorHint("额度查询失败");
    }
  }, [session.role]);

  useEffect(() => {
    if (didLoadQuotaRef.current) {
      return;
    }
    didLoadQuotaRef.current = true;

    const handleFocus = () => {
      void loadQuota();
    };

    void loadQuota();
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [loadQuota]);

  useEffect(() => {
    if (!selectedConversation) {
      lastAutoScrollConversationIdRef.current = null;
      lastAutoScrollTurnCountRef.current = 0;
      return;
    }

    const viewport = resultsViewportRef.current;
    if (!viewport) {
      lastAutoScrollConversationIdRef.current = selectedConversation.id;
      lastAutoScrollTurnCountRef.current = selectedConversation.turns.length;
      return;
    }

    const conversationChanged = lastAutoScrollConversationIdRef.current !== selectedConversation.id;
    const turnCountChanged = lastAutoScrollTurnCountRef.current !== selectedConversation.turns.length;
    const isTypingInComposer = typeof document !== "undefined" && document.activeElement === textareaRef.current;

    // 仅在切换会话、新增轮次，或用户本来就停留在底部时跟随滚动。
    // 任务轮询会频繁刷新 updatedAt；这里避免每次都 smooth scroll 导致输入框附近看起来抖动。
    if (!isTypingInComposer && (conversationChanged || turnCountChanged || isScrolledNearBottom(viewport))) {
      viewport.scrollTo({
        top: viewport.scrollHeight,
        behavior: conversationChanged || turnCountChanged ? "smooth" : "auto",
      });
    }

    lastAutoScrollConversationIdRef.current = selectedConversation.id;
    lastAutoScrollTurnCountRef.current = selectedConversation.turns.length;
  }, [selectedConversation?.id, selectedConversation?.turns.length, selectedConversation?.updatedAt]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (selectedConversationId) {
      window.localStorage.setItem(activeConversationKey, selectedConversationId);
    } else {
      window.localStorage.removeItem(activeConversationKey);
    }
  }, [activeConversationKey, selectedConversationId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (imageSize) {
      window.localStorage.setItem(imageSizeKey, imageSize);
      return;
    }
    window.localStorage.removeItem(imageSizeKey);
  }, [imageSize, imageSizeKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(imageQualityKey, imageQuality);
  }, [imageQuality, imageQualityKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(imageGenerationModeKey, imageGenerationMode);
  }, [imageGenerationMode, imageGenerationModeKey]);

  useEffect(() => {
    if (session.role !== "user" || imageGenerationMode !== "free") {
      return;
    }
    if (imageQuality !== "standard") {
      setImageQuality("standard");
    }
    if (getImageSizeTier(imageSize) !== "normal") {
      setImageSize("");
    }
  }, [imageGenerationMode, imageQuality, imageSize, session.role]);

  useEffect(() => {
    if (session.role !== "user" || imageGenerationMode !== "paid" || imageQuality !== "xhigh") {
      return;
    }
    setImageQuality("high");
  }, [imageGenerationMode, imageQuality, session.role]);

  useEffect(() => {
    if (selectedConversationId && !conversations.some((conversation) => conversation.id === selectedConversationId)) {
      setSelectedConversationId(pickFallbackConversationId(conversations));
    }
  }, [conversations, selectedConversationId]);

  const persistConversation = async (conversation: ImageConversation) => {
    const nextConversations = sortImageConversations([
      conversation,
      ...conversationsRef.current.filter((item) => item.id !== conversation.id),
    ]);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    await saveImageConversation(storageScope, conversation);
  };

  const updateConversation = useCallback(
    async (
      conversationId: string,
      updater: (current: ImageConversation | null) => ImageConversation,
      options: { persist?: boolean } = {},
    ) => {
      const current = conversationsRef.current.find((item) => item.id === conversationId) ?? null;
      const nextConversation = updater(current);
      const nextConversations = sortImageConversations([
        nextConversation,
        ...conversationsRef.current.filter((item) => item.id !== conversationId),
      ]);
      conversationsRef.current = nextConversations;
      setConversations(nextConversations);
      if (options.persist !== false) {
        await saveImageConversation(storageScope, nextConversation);
      }
    },
    [storageScope],
  );

  const clearComposerInputs = useCallback(() => {
    setImagePrompt("");
    setImageCount("1");
    setReferenceImageFiles([]);
    setReferenceImages([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  const resetComposer = useCallback(() => {
    clearComposerInputs();
  }, [clearComposerInputs]);

  const handleCreateDraft = () => {
    setSelectedConversationId(null);
    resetComposer();
    textareaRef.current?.focus();
  };

  const handleDeleteConversation = async (id: string) => {
    const nextConversations = conversations.filter((item) => item.id !== id);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    if (selectedConversationId === id) {
      setSelectedConversationId(pickFallbackConversationId(nextConversations));
      resetComposer();
    }

    try {
      await deleteImageConversation(storageScope, id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除会话失败";
      toast.error(message);
      const items = await listImageConversations(storageScope);
      conversationsRef.current = items;
      setConversations(items);
    }
  };

  const handleClearHistory = async () => {
    try {
      await clearImageConversations(storageScope);
      conversationsRef.current = [];
      setConversations([]);
      setSelectedConversationId(null);
      resetComposer();
      toast.success("已清空历史记录");
    } catch (error) {
      const message = error instanceof Error ? error.message : "清空历史记录失败";
      toast.error(message);
    }
  };

  const openDeleteConversationConfirm = (id: string) => {
    setIsHistoryOpen(false);
    setDeleteConfirm({ type: "one", id });
  };

  const openClearHistoryConfirm = () => {
    setIsHistoryOpen(false);
    setDeleteConfirm({ type: "all" });
  };

  const handleConfirmDelete = async () => {
    const target = deleteConfirm;
    setDeleteConfirm(null);
    if (!target) {
      return;
    }
    if (target.type === "all") {
      await handleClearHistory();
      return;
    }
    await handleDeleteConversation(target.id);
  };

  const appendReferenceImages = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      return;
    }

    try {
      const previews = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          type: file.type || "image/png",
          dataUrl: await readFileAsDataUrl(file),
        })),
      );

      setReferenceImageFiles((prev) => [...prev, ...files]);
      setReferenceImages((prev) => [...prev, ...previews]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取参考图失败";
      toast.error(message);
    }
  }, []);

  const handleReferenceImageChange = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        return;
      }

      await appendReferenceImages(files);
    },
    [appendReferenceImages],
  );

  const handleRemoveReferenceImage = useCallback((index: number) => {
    setReferenceImageFiles((prev) => {
      const next = prev.filter((_, currentIndex) => currentIndex !== index);
      if (next.length === 0 && fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return next;
    });
    setReferenceImages((prev) => prev.filter((_, currentIndex) => currentIndex !== index));
  }, []);

  const handleContinueEdit = useCallback(
    async (conversationId: string, image: StoredImage | StoredReferenceImage) => {
      try {
        const nextReference =
          "dataUrl" in image
            ? {
                referenceImage: image,
                file: dataUrlToFile(image.dataUrl, image.name, image.type),
              }
            : await buildReferenceImageFromStoredImage(image, `conversation-${conversationId}-${Date.now()}.png`);
        if (!nextReference) {
          return;
        }

        setSelectedConversationId(conversationId);

        setReferenceImages((prev) => [...prev, nextReference.referenceImage]);
        setReferenceImageFiles((prev) => [...prev, nextReference.file]);
        setImagePrompt("");
        textareaRef.current?.focus();
        toast.success("已加入当前参考图，继续输入描述即可编辑");
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取结果图失败";
        toast.error(message);
      }
    },
    [],
  );

  const openLightbox = useCallback((images: ImageLightboxItem[], index: number) => {
    if (images.length === 0) {
      return;
    }

    setLightboxImages(images);
    setLightboxIndex(Math.max(0, Math.min(index, images.length - 1)));
    setLightboxOpen(true);
  }, []);

  /* eslint-disable react-hooks/preserve-manual-memoization */
  const runConversationQueue = useCallback(
    async (conversationId: string) => {
      if (activeConversationQueueIds.has(conversationId)) {
        return;
      }

      const snapshot = conversationsRef.current.find((conversation) => conversation.id === conversationId);
      const activeTurn = snapshot?.turns.find(
        (turn) =>
          (turn.status === "queued" || turn.status === "generating") &&
          turn.images.some((image) => image.status === "loading"),
      );
      if (!snapshot || !activeTurn) {
        return;
      }

      activeConversationQueueIds.add(conversationId);
      const applyTasks = async (tasks: ImageTask[]) => {
        const taskMap = new Map(tasks.map((task) => [task.id, task]));
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          const turns = conversation.turns.map((turn) => {
            if (turn.id !== activeTurn.id) {
              return turn;
            }
            const images = turn.images.map((image) => {
              const taskId = image.taskId || image.id;
              const task = taskMap.get(taskId);
              return task ? taskDataToStoredImage({ ...image, taskId }, task) : image;
            });
            const derived = deriveTurnStatus({ ...turn, status: "generating", images });
            return {
              ...turn,
              ...derived,
              images,
            };
          });
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns,
          };
        });
      };

      try {
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns: conversation.turns.map((turn) =>
              turn.id === activeTurn.id
                ? {
                    ...turn,
                    status: "generating",
                    error: undefined,
                    images: turn.images.map((image) =>
                      image.status === "loading" ? { ...image, taskId: image.taskId || image.id } : image,
                    ),
                  }
                : turn,
            ),
          };
        });

        const referenceFiles = activeTurn.referenceImages.map((image, index) =>
          dataUrlToFile(image.dataUrl, image.name || `${activeTurn.id}-${index + 1}.png`, image.type),
        );
        if (activeTurn.mode === "edit" && referenceFiles.length === 0) {
          throw new Error("未找到可用于继续编辑的参考图");
        }

        const pendingImages = activeTurn.images.filter((image) => image.status === "loading");
        const requestGenerationMode = session.role === "user" ? activeTurn.generationMode : undefined;
        const pendingTaskIds = pendingImages.map((image) => image.taskId || image.id);
        const submitted = activeTurn.mode === "edit"
          ? await createImageEditTasksBatch(
              pendingTaskIds,
              referenceFiles,
              activeTurn.prompt,
              activeTurn.model,
              activeTurn.size,
              activeTurn.quality,
              requestGenerationMode,
            )
          : await createImageGenerationTasksBatch(
              pendingTaskIds,
              activeTurn.prompt,
              activeTurn.model,
              activeTurn.size,
              activeTurn.quality,
              requestGenerationMode,
            );
        await applyTasks(submitted.items);

        while (true) {
          const latestConversation = conversationsRef.current.find((conversation) => conversation.id === conversationId);
          const latestTurn = latestConversation?.turns.find((turn) => turn.id === activeTurn.id);
          const loadingTaskIds =
            latestTurn?.images.flatMap((image) =>
              image.status === "loading" && image.taskId ? [image.taskId] : [],
            ) || [];
          if (loadingTaskIds.length === 0) {
            break;
          }

          await sleep(2000);
          const taskList = await fetchImageTasks(loadingTaskIds);
          if (taskList.items.length > 0) {
            await applyTasks(taskList.items);
          }
          if (taskList.missing_ids.length > 0 && latestTurn) {
            const missingImages = latestTurn.images.filter(
              (image) => image.status === "loading" && image.taskId && taskList.missing_ids.includes(image.taskId),
            );
            const missingTaskIds = missingImages.map((image) => image.taskId || image.id);
            const resubmitted = activeTurn.mode === "edit"
              ? await createImageEditTasksBatch(
                  missingTaskIds,
                  referenceFiles,
                  activeTurn.prompt,
                  activeTurn.model,
                  activeTurn.size,
                  activeTurn.quality,
                  requestGenerationMode,
                )
              : await createImageGenerationTasksBatch(
                  missingTaskIds,
                  activeTurn.prompt,
                  activeTurn.model,
                  activeTurn.size,
                  activeTurn.quality,
                  requestGenerationMode,
                );
            if (resubmitted.items.length > 0) {
              await applyTasks(resubmitted.items);
            }
          }
        }

        await loadQuota();
      } catch (error) {
        const message = error instanceof Error ? error.message : "生成图片失败";
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns: conversation.turns.map((turn) =>
              turn.id === activeTurn.id
                ? {
                    ...turn,
                    status: "error",
                    error: message,
                    images: turn.images.map((image) =>
                      image.status === "loading" ? { ...image, status: "error", error: message } : image,
                    ),
                  }
                : turn,
            ),
          };
        });
        toast.error(message);
      } finally {
        activeConversationQueueIds.delete(conversationId);
        for (const conversation of conversationsRef.current) {
          if (
            !activeConversationQueueIds.has(conversation.id) &&
            conversation.turns.some(
              (turn) =>
                (turn.status === "queued" || turn.status === "generating") &&
                turn.images.some((image) => image.status === "loading"),
            )
          ) {
            void runConversationQueue(conversation.id);
          }
        }
      }
    },
    [loadQuota, session.role, updateConversation],
  );
  /* eslint-enable react-hooks/preserve-manual-memoization */

  useEffect(() => {
    for (const conversation of conversations) {
      if (
        !activeConversationQueueIds.has(conversation.id) &&
        conversation.turns.some(
          (turn) =>
            (turn.status === "queued" || turn.status === "generating") &&
            turn.images.some((image) => image.status === "loading"),
        )
      ) {
        void runConversationQueue(conversation.id);
      }
    }
  }, [conversations, runConversationQueue]);

  const handleSubmit = async () => {
    const prompt = imagePrompt.trim();
    if (!prompt) {
      toast.error("请输入提示词");
      return;
    }

    const effectiveImageMode: ImageConversationMode = referenceImageFiles.length > 0 ? "edit" : "generate";
    if (session.role === "user" && imageGenerationMode === "free") {
      if (imageQuality !== "standard") {
        toast.error("免费生成只支持标准画质");
        return;
      }
      if (getImageSizeTier(imageSize) !== "normal") {
        toast.error("免费生成只支持普通尺寸");
        return;
      }
    }

    const targetConversation = selectedConversationId
      ? conversationsRef.current.find((conversation) => conversation.id === selectedConversationId) ?? null
      : null;
    const now = new Date().toISOString();
    const conversationId = targetConversation?.id ?? createId();
    const turnId = createId();
    const draftTurn: ImageTurn = {
      id: turnId,
      prompt,
      model: "gpt-image-2",
      mode: effectiveImageMode,
      referenceImages: effectiveImageMode === "edit" ? referenceImages : [],
      count: parsedCount,
      size: imageSize,
      quality: imageQuality,
      generationMode: session.role === "user" ? imageGenerationMode : "free",
      images: Array.from({ length: parsedCount }, (_, index) => {
        const imageId = `${turnId}-${index}`;
        return {
          id: imageId,
          taskId: imageId,
          status: "loading" as const,
        };
      }),
      createdAt: now,
      status: "queued",
    };

    const baseConversation: ImageConversation = targetConversation
      ? {
          ...targetConversation,
          updatedAt: now,
          turns: [...targetConversation.turns, draftTurn],
        }
      : {
          id: conversationId,
          title: buildConversationTitle(prompt),
          createdAt: now,
          updatedAt: now,
          turns: [draftTurn],
        };

    setSelectedConversationId(conversationId);
    clearComposerInputs();

    await persistConversation(baseConversation);
    void runConversationQueue(conversationId);

    const targetStats = getImageConversationStats(baseConversation);
    if (targetStats.running > 0 || targetStats.queued > 1) {
      toast.success("已加入当前对话队列");
    } else if (!targetConversation) {
      toast.success("已创建新对话并开始处理");
    } else {
      toast.success("已发送到当前对话");
    }
  };

  return (
    <>
      <section className="mx-auto grid h-[calc(100dvh-6.25rem)] min-h-0 w-full max-w-[1380px] grid-cols-1 gap-2 px-0 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] sm:h-[calc(100dvh-5rem)] sm:gap-3 sm:px-3 sm:pb-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <div className="hidden h-full min-h-0 border-r border-stone-200/70 pr-3 lg:block">
          <ImageSidebar
            conversations={conversations}
            isLoadingHistory={isLoadingHistory}
            selectedConversationId={selectedConversationId}
            onCreateDraft={handleCreateDraft}
            onClearHistory={openClearHistoryConfirm}
            onSelectConversation={setSelectedConversationId}
            onDeleteConversation={openDeleteConversationConfirm}
            formatConversationTime={formatConversationTime}
          />
        </div>

        <Dialog open={isHistoryOpen} onOpenChange={setIsHistoryOpen}>
          <DialogContent className="flex h-[min(82dvh,760px)] w-[92vw] max-w-[460px] flex-col overflow-hidden rounded-[32px] border-white/80 bg-white p-0 shadow-[0_32px_110px_-38px_rgba(15,23,42,0.45)] sm:rounded-[36px]">
            <DialogHeader className="px-6 pt-7 pb-4 sm:px-8">
              <DialogTitle className="flex items-center gap-2 text-xl font-bold tracking-tight">
                <History className="size-5" />
                历史记录
              </DialogTitle>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 sm:px-8">
              <ImageSidebar
                conversations={conversations}
                isLoadingHistory={isLoadingHistory}
                selectedConversationId={selectedConversationId}
                onCreateDraft={() => {
                  handleCreateDraft();
                  setIsHistoryOpen(false);
                }}
                onClearHistory={openClearHistoryConfirm}
                onSelectConversation={(id) => {
                  setSelectedConversationId(id);
                  setIsHistoryOpen(false);
                }}
                onDeleteConversation={openDeleteConversationConfirm}
                formatConversationTime={formatConversationTime}
                hideActionButtons
              />
            </div>
          </DialogContent>
        </Dialog>

        <div className="flex min-h-0 flex-col gap-2 sm:gap-4">
          <div className="flex items-center justify-between gap-2 px-1 lg:hidden">
            <Button
              variant="outline"
              className="h-10 flex-1 rounded-2xl border-stone-200 bg-white/90 text-stone-700 shadow-sm"
              onClick={() => setIsHistoryOpen(true)}
            >
              <History className="mr-2 size-4" />
              历史记录 ({conversations.length})
            </Button>
            <Button
              className="h-10 rounded-2xl bg-stone-950 text-white shadow-sm"
              onClick={handleCreateDraft}
            >
              <Plus className="size-4" />
              新建
            </Button>
            <Button
              variant="outline"
              className="h-10 rounded-2xl border-stone-200 bg-white/85 px-3 text-stone-600 shadow-sm"
              onClick={openClearHistoryConfirm}
              disabled={conversations.length === 0}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>

          <div
            ref={resultsViewportRef}
            className="hide-scrollbar min-h-0 flex-1 overflow-y-auto px-1 py-2 sm:px-4 sm:py-4"
          >
            <ImageResults
              selectedConversation={selectedConversation}
              onOpenLightbox={openLightbox}
              onContinueEdit={handleContinueEdit}
              formatConversationTime={formatConversationTime}
            />
          </div>

          <ImageComposer
            prompt={imagePrompt}
            imageCount={imageCount}
            imageSize={imageSize}
            imageQuality={imageQuality}
            generationMode={session.role === "user" ? imageGenerationMode : "paid"}
            showGenerationModeSwitch={session.role === "user"}
            availableQuota={quotaDisplay.value}
            quotaLabel={quotaDisplay.label}
            quotaHint={quotaDisplay.hint}
            activeTaskCount={activeTaskCount}
            referenceImages={referenceImages}
            textareaRef={textareaRef}
            fileInputRef={fileInputRef}
            onPromptChange={setImagePrompt}
            onImageCountChange={setImageCount}
            onImageSizeChange={setImageSize}
            onImageQualityChange={setImageQuality}
            onGenerationModeChange={setImageGenerationMode}
            onSubmit={handleSubmit}
            onPickReferenceImage={() => fileInputRef.current?.click()}
            onReferenceImageChange={handleReferenceImageChange}
            onRemoveReferenceImage={handleRemoveReferenceImage}
          />
        </div>
      </section>

      <ImageLightbox
        images={lightboxImages}
        currentIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onIndexChange={setLightboxIndex}
      />

      {deleteConfirm ? (
        <Dialog open onOpenChange={(open) => (!open ? setDeleteConfirm(null) : null)}>
          <DialogContent showCloseButton={false} className="rounded-2xl p-6">
            <DialogHeader className="gap-2">
              <DialogTitle>{deleteConfirmTitle}</DialogTitle>
              <DialogDescription className="text-sm leading-6">
                {deleteConfirmDescription}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
                取消
              </Button>
              <Button className="bg-rose-600 text-white hover:bg-rose-700" onClick={() => void handleConfirmDelete()}>
                确认删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

export default function ImagePage() {
  const { isCheckingAuth, session } = useAuthGuard();

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <ImagePageContent session={session} />;
}
