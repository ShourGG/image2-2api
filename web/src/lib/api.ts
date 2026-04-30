import { httpRequest } from "@/lib/request";

export type AccountType = "Free" | "Plus" | "ProLite" | "Pro" | "Team";
export type AccountStatus = "正常" | "限流" | "异常" | "禁用";
export type ImageModel = "gpt-image-2" | "codex-gpt-image-2";
export type ImageQuality = "standard" | "high" | "xhigh";
export type ImageSizeTier = "normal" | "2k" | "4k";
export type ImageGenerationMode = "free" | "paid";
export type AuthRole = "admin" | "user";

export type ImageApiUpstream = {
  id: string;
  name: string;
  base_url: string;
  api_key?: string;
  api_key_set?: boolean;
  model: string;
  max_concurrency: number | string;
  enabled: boolean;
};

export type Account = {
  id: string;
  access_token: string;
  type: AccountType;
  status: AccountStatus;
  quota: number;
  imageQuotaUnknown?: boolean;
  email?: string | null;
  user_id?: string | null;
  limits_progress?: Array<{
    feature_name?: string;
    remaining?: number;
    reset_after?: string;
  }>;
  default_model_slug?: string | null;
  restoreAt?: string | null;
  owner_user_id?: string | null;
  success: number;
  fail: number;
  lastUsedAt: string | null;
};

type AccountListResponse = {
  items: Account[];
};

type AccountMutationResponse = {
  items: Account[];
  added?: number;
  skipped?: number;
  removed?: number;
  refreshed?: number;
  errors?: Array<{ access_token: string; error: string }>;
};

type AccountRefreshResponse = {
  items: Account[];
  refreshed: number;
  errors: Array<{ access_token: string; error: string }>;
};

type AccountUpdateResponse = {
  item: Account;
  items: Account[];
};

export type SettingsConfig = {
  proxy: string;
  base_url?: string;
  refresh_account_interval_minute?: number | string;
  image_retention_days?: number | string;
  auth_rate_limit_login_ip_limit?: number | string;
  auth_rate_limit_login_ip_window_seconds?: number | string;
  auth_rate_limit_login_ip_email_limit?: number | string;
  auth_rate_limit_login_ip_email_window_seconds?: number | string;
  auth_rate_limit_register_ip_limit?: number | string;
  auth_rate_limit_register_ip_window_seconds?: number | string;
  auth_rate_limit_register_ip_email_limit?: number | string;
  auth_rate_limit_register_ip_email_window_seconds?: number | string;
  auth_register_ip_account_limit?: number | string;
  image_generation_strategy?: "chatgpt2api" | "gpt2api" | "codex_responses" | "openai_compatible";
  image_generation_api_base_url?: string;
  image_generation_api_key?: string;
  image_generation_api_key_set?: boolean;
  image_generation_api_model?: string;
  image_generation_api_max_concurrency?: number | string;
  image_generation_api_upstreams?: ImageApiUpstream[];
  auto_remove_invalid_accounts?: boolean;
  auto_remove_rate_limited_accounts?: boolean;
  log_levels?: string[];
  [key: string]: unknown;
};

export type ManagedImage = {
  name: string;
  date: string;
  size: number;
  url: string;
  created_at: string;
};

export type SystemLog = {
  time: string;
  type: "call" | "account" | string;
  summary?: string;
  detail?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ImageResponse = {
  created: number;
  data: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
};

export type ImageTask = {
  id: string;
  status: "queued" | "running" | "success" | "error";
  mode: "generate" | "edit";
  model?: ImageModel;
  size?: string;
  quality?: ImageQuality | "";
  generation_mode?: ImageGenerationMode | "";
  created_at: string;
  updated_at: string;
  queue_position?: number;
  queue_ahead?: number;
  queue_total?: number;
  estimated_wait_seconds?: number;
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  error?: string;
};

type ImageTaskListResponse = {
  items: ImageTask[];
  missing_ids: string[];
};

type ImageTaskBatchResponse = {
  items: ImageTask[];
};

export type SharedImageRecord = {
  id: string;
  image_url: string;
  prompt: string;
  revised_prompt?: string;
  model?: string;
  size?: string;
  quality?: string;
  result?: number;
  created_at?: string;
  shared_at?: string;
};

export type LoginResponse = {
  ok: boolean;
  version: string;
  role: AuthRole;
  subject_id: string;
  name: string;
  token?: string;
  email?: string;
  points?: number;
};

export type AdminAccount = {
  id: string;
  name: string;
  role: "admin";
  email: string;
  enabled: boolean;
  created_at: string | null;
  last_login_at: string | null;
  last_used_at: string | null;
};

export type RegisteredUser = {
  id: string;
  name: string;
  role: "user";
  email: string;
  enabled: boolean;
  created_at: string | null;
  registration_ip?: string | null;
  last_login_at: string | null;
  last_used_at: string | null;
  points: number;
  paid_coins?: number;
  paid_bonus_uses?: number;
  preferred_image_mode?: ImageGenerationMode;
  checkin_total_count?: number;
  checkin_normal_count?: number;
  checkin_gamble_count?: number;
  checkin_total_change?: number;
  last_checkin_date?: string | null;
  last_checkin_mode?: "normal" | "gamble" | null;
  last_checkin_at?: string | null;
};

export type CurrentUser = {
  id: string;
  name: string;
  role: AuthRole;
  email?: string;
  enabled?: boolean;
  created_at?: string | null;
  registration_ip?: string | null;
  last_login_at?: string | null;
  last_used_at?: string | null;
  points?: number;
  paid_coins?: number;
  paid_bonus_uses?: number;
  preferred_image_mode?: ImageGenerationMode;
  checkin_total_count?: number;
  checkin_normal_count?: number;
  checkin_gamble_count?: number;
  checkin_total_change?: number;
  last_checkin_date?: string | null;
  last_checkin_mode?: "normal" | "gamble" | null;
  last_checkin_at?: string | null;
};

export type CheckinHistoryEntry = {
  mode: "normal" | "gamble";
  date: string;
  at?: string | null;
  change: number;
  points_before: number;
  points_after: number;
  bet?: number;
  max_multiplier?: number;
  actual_multiplier?: number;
};

export type CheckinState = {
  today: string;
  checked_in_today: boolean;
  last_checkin_date?: string | null;
  last_checkin_mode?: "normal" | "gamble" | null;
  last_checkin_at?: string | null;
  history: CheckinHistoryEntry[];
  latest_result?: CheckinHistoryEntry;
  stats: {
    total_count: number;
    normal_count: number;
    gamble_count: number;
    total_change: number;
  };
  rules: {
    normal_reward: number;
    min_reserved_points: number;
    default_bet: number;
    max_history: number;
    gamble_outcome_factors: number[];
    summary: string[];
  };
};

export type MeResponse = {
  item: CurrentUser;
  permissions: string[];
  billing: {
    mode: "points" | "account_pool";
    image_point_cost: number;
    image_point_costs?: Partial<Record<ImageQuality, number>>;
    image_point_cost_table?: Partial<Record<ImageSizeTier, Partial<Record<ImageQuality, number>>>>;
    paid_coin_cost_table?: Partial<Record<ImageSizeTier, Partial<Record<ImageQuality, number>>>>;
    coin_exchange_rate?: number;
    default_paid_bonus_uses?: number;
    default_user_points: number;
  };
  checkins?: CheckinState;
};

export type RegisterConfig = {
  enabled: boolean;
  mail: {
    request_timeout: number;
    wait_timeout: number;
    wait_interval: number;
    providers: Array<Record<string, unknown>>;
  };
  proxy: string;
  total: number;
  threads: number;
  mode: "total" | "quota" | "available";
  target_quota: number;
  target_available: number;
  check_interval: number;
  stats: {
    job_id?: string;
    success: number;
    fail: number;
    done: number;
    running: number;
    threads: number;
    elapsed_seconds?: number;
    avg_seconds?: number;
    success_rate?: number;
    current_quota?: number;
    current_available?: number;
    started_at?: string;
    updated_at?: string;
    finished_at?: string;
  };
  logs?: Array<{
    time: string;
    text: string;
    level: string;
  }>;
};

export async function login(authKey: string) {
  const normalizedAuthKey = String(authKey || "").trim();
  return httpRequest<LoginResponse>("/auth/login", {
    method: "POST",
    body: {},
    headers: {
      Authorization: `Bearer ${normalizedAuthKey}`,
    },
    redirectOnUnauthorized: false,
  });
}

export async function loginWithPassword(email: string, password: string) {
  return httpRequest<LoginResponse>("/auth/login", {
    method: "POST",
    body: {
      email: String(email || "").trim(),
      password,
    },
    redirectOnUnauthorized: false,
  });
}

export async function registerUserAccount(payload: { email: string; password: string; name?: string }) {
  return httpRequest<LoginResponse>("/auth/register", {
    method: "POST",
    body: {
      email: String(payload.email || "").trim(),
      password: payload.password,
      name: String(payload.name || "").trim(),
    },
    redirectOnUnauthorized: false,
  });
}

export async function fetchAdminSetupState() {
  return httpRequest<{ required: boolean }>("/api/admin/setup", {
    redirectOnUnauthorized: false,
  });
}

export async function setupAdminAccount(payload: { email: string; password: string; name?: string; setup_key: string }) {
  return httpRequest<LoginResponse>("/api/admin/setup", {
    method: "POST",
    body: {
      email: String(payload.email || "").trim(),
      password: payload.password,
      name: String(payload.name || "").trim(),
      setup_key: String(payload.setup_key || "").trim(),
    },
    redirectOnUnauthorized: false,
  });
}

export async function bindAdminAccount(payload: { email: string; password: string; name?: string }) {
  return httpRequest<{ item: AdminAccount }>("/api/admin/bind", {
    method: "POST",
    body: {
      email: String(payload.email || "").trim(),
      password: payload.password,
      name: String(payload.name || "").trim(),
    },
  });
}

export async function fetchAccounts() {
  return httpRequest<AccountListResponse>("/api/accounts");
}

export async function createAccounts(tokens: string[]) {
  return httpRequest<AccountMutationResponse>("/api/accounts", {
    method: "POST",
    body: { tokens },
  });
}

export async function deleteAccounts(tokens: string[]) {
  return httpRequest<AccountMutationResponse>("/api/accounts", {
    method: "DELETE",
    body: { tokens },
  });
}

export async function refreshAccounts(accessTokens: string[]) {
  return httpRequest<AccountRefreshResponse>("/api/accounts/refresh", {
    method: "POST",
    body: { access_tokens: accessTokens },
  });
}

export async function updateAccount(
  accessToken: string,
  updates: {
    type?: AccountType;
    status?: AccountStatus;
    quota?: number;
    owner_user_id?: string;
  },
) {
  return httpRequest<AccountUpdateResponse>("/api/accounts/update", {
    method: "POST",
    body: {
      access_token: accessToken,
      ...updates,
    },
  });
}

export async function generateImage(prompt: string, model?: ImageModel, size?: string, quality?: ImageQuality) {
  return httpRequest<ImageResponse>(
    "/v1/images/generations",
    {
      method: "POST",
      body: {
        prompt,
        ...(model ? { model } : {}),
        ...(size ? { size } : {}),
        ...(quality && quality !== "standard" ? { quality } : {}),
        n: 1,
        response_format: "b64_json",
      },
    },
  );
}

export async function editImage(files: File | File[], prompt: string, model?: ImageModel, size?: string, quality?: ImageQuality) {
  const formData = new FormData();
  const uploadFiles = Array.isArray(files) ? files : [files];

  uploadFiles.forEach((file) => {
    formData.append("image", file);
  });
  formData.append("prompt", prompt);
  if (model) {
    formData.append("model", model);
  }
  if (size) {
    formData.append("size", size);
  }
  if (quality && quality !== "standard") {
    formData.append("quality", quality);
  }
  formData.append("n", "1");

  return httpRequest<ImageResponse>(
    "/v1/images/edits",
    {
      method: "POST",
      body: formData,
    },
  );
}

export async function createImageGenerationTask(
  clientTaskId: string,
  prompt: string,
  model?: ImageModel,
  size?: string,
  quality?: ImageQuality,
  generationMode?: ImageGenerationMode,
) {
  return httpRequest<ImageTask>("/api/image-tasks/generations", {
    method: "POST",
    body: {
      client_task_id: clientTaskId,
      prompt,
      ...(model ? { model } : {}),
      ...(size ? { size } : {}),
      ...(quality && quality !== "standard" ? { quality } : {}),
      ...(generationMode ? { generation_mode: generationMode } : {}),
    },
  });
}

export async function createImageGenerationTasksBatch(
  clientTaskIds: string[],
  prompt: string,
  model?: ImageModel,
  size?: string,
  quality?: ImageQuality,
  generationMode?: ImageGenerationMode,
) {
  return httpRequest<ImageTaskBatchResponse>("/api/image-tasks/generations/batch", {
    method: "POST",
    body: {
      client_task_ids: clientTaskIds,
      prompt,
      ...(model ? { model } : {}),
      ...(size ? { size } : {}),
      ...(quality && quality !== "standard" ? { quality } : {}),
      ...(generationMode ? { generation_mode: generationMode } : {}),
    },
  });
}

export async function createImageEditTask(
  clientTaskId: string,
  files: File | File[],
  prompt: string,
  model?: ImageModel,
  size?: string,
  quality?: ImageQuality,
  generationMode?: ImageGenerationMode,
) {
  const formData = new FormData();
  const uploadFiles = Array.isArray(files) ? files : [files];

  uploadFiles.forEach((file) => {
    formData.append("image", file);
  });
  formData.append("client_task_id", clientTaskId);
  formData.append("prompt", prompt);
  if (model) {
    formData.append("model", model);
  }
  if (size) {
    formData.append("size", size);
  }
  if (quality && quality !== "standard") {
    formData.append("quality", quality);
  }
  if (generationMode) {
    formData.append("generation_mode", generationMode);
  }

  return httpRequest<ImageTask>("/api/image-tasks/edits", {
    method: "POST",
    body: formData,
  });
}

export async function createImageEditTasksBatch(
  clientTaskIds: string[],
  files: File | File[],
  prompt: string,
  model?: ImageModel,
  size?: string,
  quality?: ImageQuality,
  generationMode?: ImageGenerationMode,
) {
  const formData = new FormData();
  const uploadFiles = Array.isArray(files) ? files : [files];

  uploadFiles.forEach((file) => {
    formData.append("image", file);
  });
  formData.append("client_task_ids", JSON.stringify(clientTaskIds));
  formData.append("prompt", prompt);
  if (model) {
    formData.append("model", model);
  }
  if (size) {
    formData.append("size", size);
  }
  if (quality && quality !== "standard") {
    formData.append("quality", quality);
  }
  if (generationMode) {
    formData.append("generation_mode", generationMode);
  }

  return httpRequest<ImageTaskBatchResponse>("/api/image-tasks/edits/batch", {
    method: "POST",
    body: formData,
  });
}

export async function fetchImageTasks(ids: string[]) {
  const params = new URLSearchParams();
  if (ids.length > 0) {
    params.set("ids", ids.join(","));
  }
  return httpRequest<ImageTaskListResponse>(`/api/image-tasks${params.toString() ? `?${params.toString()}` : ""}`);
}

export async function createImageShare(payload: {
  image_url: string;
  prompt?: string;
  revised_prompt?: string;
  model?: string;
  size?: string;
  quality?: string;
  result?: number;
  created_at?: string;
}) {
  return httpRequest<{ item: SharedImageRecord; share_url: string }>("/api/shares", {
    method: "POST",
    body: payload,
  });
}

export async function fetchImageShare(shareId: string) {
  return httpRequest<{ item: SharedImageRecord }>(`/api/shares/${encodeURIComponent(shareId)}`, {
    redirectOnUnauthorized: false,
  });
}

export async function fetchSettingsConfig() {
  return httpRequest<{ config: SettingsConfig }>("/api/settings");
}

export async function fetchCurrentUser() {
  return httpRequest<MeResponse>("/api/me");
}

export async function normalCheckin() {
  return httpRequest<MeResponse>("/api/checkins/normal", {
    method: "POST",
    body: {},
  });
}

export async function gambleCheckin(payload: { bet: number; max_multiplier: number }) {
  return httpRequest<MeResponse>("/api/checkins/gamble", {
    method: "POST",
    body: payload,
  });
}

export async function updateSettingsConfig(settings: SettingsConfig) {
  return httpRequest<{ config: SettingsConfig }>("/api/settings", {
    method: "POST",
    body: settings,
  });
}

export async function fetchImageApiUpstreamUsage(upstreamId: string) {
  return httpRequest<{ result: { ok: boolean; status: number; usage?: unknown; error?: unknown } }>(
    `/api/settings/image-upstreams/${encodeURIComponent(upstreamId)}/usage`,
  );
}

export async function fetchManagedImages(filters: { start_date?: string; end_date?: string }) {
  const params = new URLSearchParams();
  if (filters.start_date) params.set("start_date", filters.start_date);
  if (filters.end_date) params.set("end_date", filters.end_date);
  return httpRequest<{ items: ManagedImage[]; groups: Array<{ date: string; items: ManagedImage[] }> }>(
    `/api/images${params.toString() ? `?${params.toString()}` : ""}`,
  );
}

export async function fetchSystemLogs(filters: { type?: string; start_date?: string; end_date?: string }) {
  const params = new URLSearchParams();
  if (filters.type) params.set("type", filters.type);
  if (filters.start_date) params.set("start_date", filters.start_date);
  if (filters.end_date) params.set("end_date", filters.end_date);
  return httpRequest<{ items: SystemLog[] }>(`/api/logs${params.toString() ? `?${params.toString()}` : ""}`);
}

export async function fetchUsers() {
  return httpRequest<{ items: RegisteredUser[] }>("/api/users");
}

export async function updateUser(
  userId: string,
  updates: {
    enabled?: boolean;
    name?: string;
    password?: string;
    points?: number;
    paid_coins?: number;
    paid_bonus_uses?: number;
    preferred_image_mode?: ImageGenerationMode;
  },
) {
  return httpRequest<{ item: RegisteredUser; items: RegisteredUser[] }>(`/api/users/${userId}`, {
    method: "POST",
    body: updates,
  });
}

export async function deleteUser(userId: string) {
  return httpRequest<{ items: RegisteredUser[] }>(`/api/users/${userId}`, {
    method: "DELETE",
  });
}

export async function fetchRegisterConfig() {
  return httpRequest<{ register: RegisterConfig }>("/api/register");
}

export async function updateRegisterConfig(updates: Partial<RegisterConfig>) {
  return httpRequest<{ register: RegisterConfig }>("/api/register", {
    method: "POST",
    body: updates,
  });
}

export async function startRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/start", { method: "POST" });
}

export async function stopRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/stop", { method: "POST" });
}

export async function resetRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/reset", { method: "POST" });
}

// ── CPA (CLIProxyAPI) ──────────────────────────────────────────────

export type CPAPool = {
  id: string;
  name: string;
  base_url: string;
  import_job?: CPAImportJob | null;
};

export type CPARemoteFile = {
  name: string;
  email: string;
};

export type CPAImportJob = {
  job_id: string;
  status: "pending" | "running" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  total: number;
  completed: number;
  added: number;
  skipped: number;
  refreshed: number;
  failed: number;
  errors: Array<{ name: string; error: string }>;
};

export async function fetchCPAPools() {
  return httpRequest<{ pools: CPAPool[] }>("/api/cpa/pools");
}

export async function createCPAPool(pool: { name: string; base_url: string; secret_key: string }) {
  return httpRequest<{ pool: CPAPool; pools: CPAPool[] }>("/api/cpa/pools", {
    method: "POST",
    body: pool,
  });
}

export async function updateCPAPool(
  poolId: string,
  updates: { name?: string; base_url?: string; secret_key?: string },
) {
  return httpRequest<{ pool: CPAPool; pools: CPAPool[] }>(`/api/cpa/pools/${poolId}`, {
    method: "POST",
    body: updates,
  });
}

export async function deleteCPAPool(poolId: string) {
  return httpRequest<{ pools: CPAPool[] }>(`/api/cpa/pools/${poolId}`, {
    method: "DELETE",
  });
}

export async function fetchCPAPoolFiles(poolId: string) {
  return httpRequest<{ pool_id: string; files: CPARemoteFile[] }>(`/api/cpa/pools/${poolId}/files`);
}

export async function startCPAImport(poolId: string, names: string[]) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/cpa/pools/${poolId}/import`, {
    method: "POST",
    body: { names },
  });
}

export async function fetchCPAPoolImportJob(poolId: string) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/cpa/pools/${poolId}/import`);
}

// ── Sub2API ────────────────────────────────────────────────────────

export type Sub2APIServer = {
  id: string;
  name: string;
  base_url: string;
  email: string;
  has_api_key: boolean;
  group_id: string;
  import_job?: CPAImportJob | null;
};

export type Sub2APIRemoteAccount = {
  id: string;
  name: string;
  email: string;
  plan_type: string;
  status: string;
  expires_at: string;
  has_refresh_token: boolean;
};

export type Sub2APIRemoteGroup = {
  id: string;
  name: string;
  description: string;
  platform: string;
  status: string;
  account_count: number;
  active_account_count: number;
};

export async function fetchSub2APIServers() {
  return httpRequest<{ servers: Sub2APIServer[] }>("/api/sub2api/servers");
}

export async function createSub2APIServer(server: {
  name: string;
  base_url: string;
  email: string;
  password: string;
  api_key: string;
  group_id: string;
}) {
  return httpRequest<{ server: Sub2APIServer; servers: Sub2APIServer[] }>("/api/sub2api/servers", {
    method: "POST",
    body: server,
  });
}

export async function updateSub2APIServer(
  serverId: string,
  updates: {
    name?: string;
    base_url?: string;
    email?: string;
    password?: string;
    api_key?: string;
    group_id?: string;
  },
) {
  return httpRequest<{ server: Sub2APIServer; servers: Sub2APIServer[] }>(`/api/sub2api/servers/${serverId}`, {
    method: "POST",
    body: updates,
  });
}

export async function fetchSub2APIServerGroups(serverId: string) {
  return httpRequest<{ server_id: string; groups: Sub2APIRemoteGroup[] }>(
    `/api/sub2api/servers/${serverId}/groups`,
  );
}

export async function deleteSub2APIServer(serverId: string) {
  return httpRequest<{ servers: Sub2APIServer[] }>(`/api/sub2api/servers/${serverId}`, {
    method: "DELETE",
  });
}

export async function fetchSub2APIServerAccounts(serverId: string) {
  return httpRequest<{ server_id: string; accounts: Sub2APIRemoteAccount[] }>(
    `/api/sub2api/servers/${serverId}/accounts`,
  );
}

export async function startSub2APIImport(serverId: string, accountIds: string[]) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/sub2api/servers/${serverId}/import`, {
    method: "POST",
    body: { account_ids: accountIds },
  });
}

export async function fetchSub2APIImportJob(serverId: string) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/sub2api/servers/${serverId}/import`);
}

// ── Upstream proxy ────────────────────────────────────────────────

export type ProxySettings = {
  enabled: boolean;
  url: string;
};

export type ProxyTestResult = {
  ok: boolean;
  status: number;
  latency_ms: number;
  error: string | null;
};

export async function fetchProxy() {
  return httpRequest<{ proxy: ProxySettings }>("/api/proxy");
}

export async function updateProxy(updates: { enabled?: boolean; url?: string }) {
  return httpRequest<{ proxy: ProxySettings }>("/api/proxy", {
    method: "POST",
    body: updates,
  });
}

export async function testProxy(url?: string) {
  return httpRequest<{ result: ProxyTestResult }>("/api/proxy/test", {
    method: "POST",
    body: { url: url ?? "" },
  });
}
