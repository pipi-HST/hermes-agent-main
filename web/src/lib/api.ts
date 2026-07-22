// The dashboard can be served either at the root of its host (e.g.
// https://kanban.tilos.com/) or under a URL prefix when reverse-proxied
// (e.g. https://mission-control.tilos.com/hermes/). The Python backend
// injects ``window.__HERMES_BASE_PATH__`` into index.html based on the
// incoming ``X-Forwarded-Prefix`` header so the SPA can address its own
// ``/api/...`` and ``/dashboard-plugins/...`` URLs correctly without a
// rebuild. Empty string means "served at root".
function readBasePath(): string {
  if (typeof window === "undefined") return "";
  const raw = window.__HERMES_BASE_PATH__ ?? "";
  if (!raw) return "";
  // Normalise: ensure leading slash, strip trailing slash.
  const withLead = raw.startsWith("/") ? raw : `/${raw}`;
  return withLead.replace(/\/+$/, "");
}

export const HERMES_BASE_PATH = readBasePath();
const BASE = HERMES_BASE_PATH;

import type { DashboardTheme } from "@/themes/types";

// Ephemeral session token for protected endpoints.
// Injected into index.html by the server — never fetched via API.
declare global {
  interface Window {
    __HERMES_SESSION_TOKEN__?: string;
    __HERMES_BASE_PATH__?: string;
  }
}
let _sessionToken: string | null = null;
const SESSION_HEADER = "X-Hermes-Session-Token";
export const AI_OPERATION_HEADER = "X-Hermes-AI-Operation-Id";

export interface AiOperationOptions {
  operationId?: string;
  signal?: AbortSignal;
}

function setSessionHeader(headers: Headers, token: string): void {
  if (!headers.has(SESSION_HEADER)) {
    headers.set(SESSION_HEADER, token);
  }
}

export async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  // Inject the session token into all /api/ requests.
  const headers = new Headers(init?.headers);
  const token = window.__HERMES_SESSION_TOKEN__;
  if (token) {
    setSessionHeader(headers, token);
  }
  const res = await fetch(`${BASE}${url}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

function requireKnowledgeBusinessSuccess<T extends Record<string, unknown>>(result: T): T {
  const errors = Array.isArray(result.errors)
    ? result.errors.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const error = typeof result.error === "string" ? result.error.trim() : "";
  if (result.ok === false || result.status === "error" || result.error || errors.length) {
    throw new Error(error || errors[0] || "知识库入库失败，请重试。");
  }
  return result;
}

export function createAiOperationId(prefix = "ai"): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

function withAiOperation(init: RequestInit, options?: AiOperationOptions): RequestInit {
  const headers = new Headers(init.headers);
  if (options?.operationId) {
    headers.set(AI_OPERATION_HEADER, options.operationId);
  }
  return {
    ...init,
    headers,
    signal: options?.signal ?? init.signal,
  };
}

async function getSessionToken(): Promise<string> {
  if (_sessionToken) return _sessionToken;
  const injected = window.__HERMES_SESSION_TOKEN__;
  if (injected) {
    _sessionToken = injected;
    return _sessionToken;
  }
  throw new Error("Session token not available — page must be served by the Hermes dashboard server");
}

export const api = {
  getStatus: () => fetchJSON<StatusResponse>("/api/status"),
  uploadDashboardFile: (body: DashboardUploadRequest) =>
    fetchJSON<DashboardUploadResponse>("/api/dashboard/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  getSessions: (limit = 20, offset = 0) =>
    fetchJSON<PaginatedSessions>(`/api/sessions?limit=${limit}&offset=${offset}`),
  getSessionMessages: (id: string) =>
    fetchJSON<SessionMessagesResponse>(`/api/sessions/${encodeURIComponent(id)}/messages`),
  getSessionLatestDescendant: (id: string) =>
    fetchJSON<SessionLatestDescendantResponse>(
      `/api/sessions/${encodeURIComponent(id)}/latest-descendant`,
    ),
  deleteSession: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  getLogs: (params: { file?: string; lines?: number; level?: string; component?: string }) => {
    const qs = new URLSearchParams();
    if (params.file) qs.set("file", params.file);
    if (params.lines) qs.set("lines", String(params.lines));
    if (params.level && params.level !== "ALL") qs.set("level", params.level);
    if (params.component && params.component !== "all") qs.set("component", params.component);
    return fetchJSON<LogsResponse>(`/api/logs?${qs.toString()}`);
  },
  getAnalytics: (days: number) =>
    fetchJSON<AnalyticsResponse>(`/api/analytics/usage?days=${days}`),
  getModelsAnalytics: (days: number) =>
    fetchJSON<ModelsAnalyticsResponse>(`/api/analytics/models?days=${days}`),
  getConfig: () => fetchJSON<Record<string, unknown>>("/api/config"),
  getDefaults: () => fetchJSON<Record<string, unknown>>("/api/config/defaults"),
  getSchema: () => fetchJSON<{ fields: Record<string, unknown>; category_order: string[] }>("/api/config/schema"),
  getModelInfo: () => fetchJSON<ModelInfoResponse>("/api/model/info"),
  getModelOptions: () => fetchJSON<ModelOptionsResponse>("/api/model/options"),
  getAuxiliaryModels: () => fetchJSON<AuxiliaryModelsResponse>("/api/model/auxiliary"),
  setModelAssignment: (body: ModelAssignmentRequest) =>
    fetchJSON<ModelAssignmentResponse>("/api/model/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  saveConfig: (config: Record<string, unknown>) =>
    fetchJSON<{ ok: boolean }>("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config }),
    }),
  getConfigRaw: () => fetchJSON<{ yaml: string }>("/api/config/raw"),
  saveConfigRaw: (yaml_text: string) =>
    fetchJSON<{ ok: boolean }>("/api/config/raw", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yaml_text }),
    }),
  getEnvVars: () => fetchJSON<Record<string, EnvVarInfo>>("/api/env"),
  setEnvVar: (key: string, value: string) =>
    fetchJSON<{ ok: boolean }>("/api/env", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    }),
  deleteEnvVar: (key: string) =>
    fetchJSON<{ ok: boolean }>("/api/env", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    }),
  revealEnvVar: async (key: string) => {
    const token = await getSessionToken();
    return fetchJSON<{ key: string; value: string }>("/api/env/reveal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SESSION_HEADER]: token,
      },
      body: JSON.stringify({ key }),
    });
  },

  // Cron jobs
  getCronJobs: () => fetchJSON<CronJob[]>("/api/cron/jobs"),
  createCronJob: (job: { prompt: string; schedule: string; name?: string; deliver?: string }) =>
    fetchJSON<CronJob>("/api/cron/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(job),
    }),
  pauseCronJob: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/api/cron/jobs/${id}/pause`, { method: "POST" }),
  resumeCronJob: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/api/cron/jobs/${id}/resume`, { method: "POST" }),
  triggerCronJob: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/api/cron/jobs/${id}/trigger`, { method: "POST" }),
  deleteCronJob: (id: string) =>
    fetchJSON<{ ok: boolean }>(`/api/cron/jobs/${id}`, { method: "DELETE" }),

  // Profiles (minimal)
  getProfiles: () =>
    fetchJSON<{ profiles: ProfileInfo[] }>("/api/profiles"),
  createProfile: (body: { name: string; clone_from_default: boolean }) =>
    fetchJSON<{ ok: boolean; name: string; path: string }>("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  renameProfile: (name: string, newName: string) =>
    fetchJSON<{ ok: boolean; name: string; path: string }>(
      `/api/profiles/${encodeURIComponent(name)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_name: newName }),
      },
    ),
  deleteProfile: (name: string) =>
    fetchJSON<{ ok: boolean }>(
      `/api/profiles/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),
  getProfileSetupCommand: (name: string) =>
    fetchJSON<{ command: string }>(
      `/api/profiles/${encodeURIComponent(name)}/setup-command`,
    ),
  getProfileSoul: (name: string) =>
    fetchJSON<{ content: string; exists: boolean }>(
      `/api/profiles/${encodeURIComponent(name)}/soul`,
    ),
  updateProfileSoul: (name: string, content: string) =>
    fetchJSON<{ ok: boolean }>(
      `/api/profiles/${encodeURIComponent(name)}/soul`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      },
    ),

  // Skills & Toolsets
  getSkills: () => fetchJSON<SkillInfo[]>("/api/skills"),
  toggleSkill: (name: string, enabled: boolean) =>
    fetchJSON<{ ok: boolean }>("/api/skills/toggle", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, enabled }),
    }),
  getToolsets: () => fetchJSON<ToolsetInfo[]>("/api/tools/toolsets"),

  // Session search (FTS5)
  searchSessions: (q: string) =>
    fetchJSON<SessionSearchResponse>(`/api/sessions/search?q=${encodeURIComponent(q)}`),

  // OAuth provider management
  getOAuthProviders: () =>
    fetchJSON<OAuthProvidersResponse>("/api/providers/oauth"),
  disconnectOAuthProvider: async (providerId: string) => {
    const token = await getSessionToken();
    return fetchJSON<{ ok: boolean; provider: string }>(
      `/api/providers/oauth/${encodeURIComponent(providerId)}`,
      {
        method: "DELETE",
        headers: { [SESSION_HEADER]: token },
      },
    );
  },
  startOAuthLogin: async (providerId: string) => {
    const token = await getSessionToken();
    return fetchJSON<OAuthStartResponse>(
      `/api/providers/oauth/${encodeURIComponent(providerId)}/start`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [SESSION_HEADER]: token,
        },
        body: "{}",
      },
    );
  },
  submitOAuthCode: async (providerId: string, sessionId: string, code: string) => {
    const token = await getSessionToken();
    return fetchJSON<OAuthSubmitResponse>(
      `/api/providers/oauth/${encodeURIComponent(providerId)}/submit`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [SESSION_HEADER]: token,
        },
        body: JSON.stringify({ session_id: sessionId, code }),
      },
    );
  },
  pollOAuthSession: (providerId: string, sessionId: string) =>
    fetchJSON<OAuthPollResponse>(
      `/api/providers/oauth/${encodeURIComponent(providerId)}/poll/${encodeURIComponent(sessionId)}`,
    ),
  cancelOAuthSession: async (sessionId: string) => {
    const token = await getSessionToken();
    return fetchJSON<{ ok: boolean }>(
      `/api/providers/oauth/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "DELETE",
        headers: { [SESSION_HEADER]: token },
      },
    );
  },

  // Gateway / update actions
  restartGateway: () =>
    fetchJSON<ActionResponse>("/api/gateway/restart", { method: "POST" }),
  updateHermes: () =>
    fetchJSON<ActionResponse>("/api/hermes/update", { method: "POST" }),
  getActionStatus: (name: string, lines = 200) =>
    fetchJSON<ActionStatusResponse>(
      `/api/actions/${encodeURIComponent(name)}/status?lines=${lines}`,
    ),

  // Dashboard plugins
  getPlugins: () =>
    fetchJSON<PluginManifestResponse[]>("/api/dashboard/plugins"),
  rescanPlugins: () =>
    fetchJSON<{ ok: boolean; count: number }>("/api/dashboard/plugins/rescan"),

  getPluginsHub: () => fetchJSON<PluginsHubResponse>("/api/dashboard/plugins/hub"),

  installAgentPlugin: (body: AgentPluginInstallRequest) =>
    fetchJSON<AgentPluginInstallResponse>("/api/dashboard/agent-plugins/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body }),
    }),

  enableAgentPlugin: (name: string) =>
    fetchJSON<{ ok: boolean; name: string; unchanged?: boolean }>(
      `/api/dashboard/agent-plugins/${encodeURIComponent(name)}/enable`,
      { method: "POST" },
    ),

  disableAgentPlugin: (name: string) =>
    fetchJSON<{ ok: boolean; name: string; unchanged?: boolean }>(
      `/api/dashboard/agent-plugins/${encodeURIComponent(name)}/disable`,
      { method: "POST" },
    ),

  updateAgentPlugin: (name: string) =>
    fetchJSON<AgentPluginUpdateResponse>(
      `/api/dashboard/agent-plugins/${encodeURIComponent(name)}/update`,
      { method: "POST" },
    ),

  removeAgentPlugin: (name: string) =>
    fetchJSON<{ ok: boolean; name: string }>(
      `/api/dashboard/agent-plugins/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),

  savePluginProviders: (body: PluginProvidersPutRequest) =>
    fetchJSON<{ ok: boolean }>("/api/dashboard/plugin-providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  setPluginVisibility: (name: string, hidden: boolean) =>
    fetchJSON<{ ok: boolean; name: string; hidden: boolean }>(
      `/api/dashboard/plugins/${encodeURIComponent(name)}/visibility`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden }),
      },
    ),

  // Dashboard themes
  getThemes: () =>
    fetchJSON<DashboardThemesResponse>("/api/dashboard/themes"),
  setTheme: (name: string) =>
    fetchJSON<{ ok: boolean; theme: string }>("/api/dashboard/theme", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),

  // Hermes Knowledge
  getKnowledgeAutomationBoundaries: () =>
    fetchJSON<KnowledgeAutomationBoundariesResponse>(
      "/api/knowledge/automation-boundaries",
    ),
  getKnowledgeLibraryFolders: () =>
    fetchJSON<KnowledgeLibraryFoldersResponse>("/api/knowledge/library/folders"),
  createKnowledgeLibraryFolder: (name: string) =>
    fetchJSON<KnowledgeLibraryFolderCreateResponse>("/api/knowledge/library/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  updateKnowledgeLibraryFolder: (folderPath: string, name: string) =>
    fetchJSON<KnowledgeLibraryFolderUpdateResponse>(
      `/api/knowledge/library/folders/${encodeURIComponent(folderPath)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
    ),
  getKnowledgeLibraryItems: (params: { folder?: string; view?: string; search?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.folder) qs.set("folder", params.folder);
    if (params.view) qs.set("view", params.view);
    if (params.search) qs.set("search", params.search);
    if (params.limit) qs.set("limit", String(params.limit));
    return fetchJSON<KnowledgeLibraryItemsResponse>(
      `/api/knowledge/library/items?${qs.toString()}`,
    );
  },
  getKnowledgeLibraryItem: (kind: KnowledgeLibraryItemKind, itemId: string) =>
    fetchJSON<KnowledgeLibraryItemResponse>(
      `/api/knowledge/library/items/${encodeURIComponent(kind)}/${encodeURIComponent(itemId)}`,
    ),
  getKnowledgeLibraryItemDependencies: (kind: KnowledgeLibraryItemKind, itemId: string) =>
    fetchJSON<KnowledgeLibraryDependenciesResponse>(
      `/api/knowledge/library/items/${encodeURIComponent(kind)}/${encodeURIComponent(itemId)}/dependencies`,
    ),
  openKnowledgeLibraryItemLocal: (kind: KnowledgeLibraryItemKind, itemId: string) =>
    fetchJSON<KnowledgeLibraryOpenLocalResponse>(
      `/api/knowledge/library/items/${encodeURIComponent(kind)}/${encodeURIComponent(itemId)}/open-local`,
      { method: "POST" },
    ),
  selectionChatKnowledgeLibraryItem: (
    kind: KnowledgeLibraryItemKind,
    itemId: string,
    body: KnowledgeLibrarySelectionChatRequest,
  ) =>
    fetchJSON<KnowledgeLibrarySelectionChatResponse>(
      `/api/knowledge/library/items/${encodeURIComponent(kind)}/${encodeURIComponent(itemId)}/selection-chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  streamSelectionChatKnowledgeLibraryItem: async (
    kind: KnowledgeLibraryItemKind,
    itemId: string,
    body: KnowledgeLibrarySelectionChatRequest,
    onEvent: (event: KnowledgeLibrarySelectionChatStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<KnowledgeLibrarySelectionChatResponse> => {
    const headers = new Headers({ "Content-Type": "application/json", Accept: "text/event-stream" });
    const token = window.__HERMES_SESSION_TOKEN__;
    if (token) {
      setSessionHeader(headers, token);
    }
    const res = await fetch(
      `${BASE}/api/knowledge/library/items/${encodeURIComponent(kind)}/${encodeURIComponent(itemId)}/selection-chat/stream`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`${res.status}: ${text}`);
    }
    if (!res.body) {
      throw new Error("Selection chat stream returned an empty body");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResponse: KnowledgeLibrarySelectionChatResponse | null = null;
    const flush = (chunk: string) => {
      buffer += chunk;
      const frames = buffer.split(/\n\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split(/\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
          .trim();
        if (!data) continue;
        const event = JSON.parse(data) as KnowledgeLibrarySelectionChatStreamEvent;
        onEvent(event);
        if (event.event === "complete" && event.response) {
          finalResponse = event.response;
        }
        if (event.event === "error") {
          throw new Error(event.message || event.error || "Selection chat stream failed");
        }
      }
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) {
          flush(decoder.decode(value, { stream: !done }));
        }
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
    flush(decoder.decode());
    if (!finalResponse) {
      throw new Error("Selection chat stream ended without a final answer");
    }
    return finalResponse;
  },
  createKnowledgeLibraryItem: (body: KnowledgeLibraryCreateRequest) =>
    fetchJSON<KnowledgeLibraryCreateResponse>("/api/knowledge/library/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  updateKnowledgeLibraryItem: (kind: KnowledgeLibraryItemKind, itemId: string, body: KnowledgeLibraryUpdateRequest) =>
    fetchJSON<KnowledgeLibraryUpdateResponse>(
      `/api/knowledge/library/items/${encodeURIComponent(kind)}/${encodeURIComponent(itemId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  deleteKnowledgeLibraryItem: (kind: KnowledgeLibraryItemKind, itemId: string) =>
    fetchJSON<KnowledgeLibraryDeleteResponse>(
      `/api/knowledge/library/items/${encodeURIComponent(kind)}/${encodeURIComponent(itemId)}`,
      { method: "DELETE" },
    ),
  deleteKnowledgeLibraryItemPermanent: (kind: KnowledgeLibraryItemKind, itemId: string) =>
    fetchJSON<KnowledgeLibraryPermanentDeleteResponse>(
      `/api/knowledge/library/items/${encodeURIComponent(kind)}/${encodeURIComponent(itemId)}/permanent`,
      { method: "DELETE" },
    ),
  cancelKnowledgeAiOperation: (operationId: string) =>
    fetchJSON<{ ok: boolean; operation_id: string; status: string }>(
      `/api/knowledge/ai-operations/${encodeURIComponent(operationId)}/cancel`,
      { method: "POST" },
    ),
  getKnowledgeCaptureDrafts: (limit = 50) =>
    fetchJSON<KnowledgeCaptureDraftsResponse>(
      `/api/knowledge/capture-drafts?limit=${limit}`,
    ),
  getKnowledgeCaptureDraft: (draftId: string) =>
    fetchJSON<KnowledgeCaptureDraftResponse>(
      `/api/knowledge/capture-drafts/${encodeURIComponent(draftId)}`,
    ),
  createKnowledgeEditableCaptureDraft: (body: KnowledgeEditableCaptureDraftRequest, options?: AiOperationOptions) =>
    fetchJSON<Record<string, unknown>>("/api/knowledge/capture-drafts/editable", withAiOperation({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, options)),
  updateKnowledgeEditableCaptureDraft: (draftId: string, body: KnowledgeEditableCaptureDraftUpdateRequest, options?: AiOperationOptions) =>
    fetchJSON<Record<string, unknown>>(
      `/api/knowledge/capture-drafts/${encodeURIComponent(draftId)}/editable`,
      withAiOperation({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, options),
    ),
  commitKnowledgeCaptureDraft: (draftId: string, options?: AiOperationOptions) =>
    fetchJSON<Record<string, unknown>>(
      `/api/knowledge/capture-drafts/${encodeURIComponent(draftId)}/commit`,
      withAiOperation({ method: "POST" }, options),
    ).then(requireKnowledgeBusinessSuccess),
  reviseKnowledgeCaptureDraft: (draftId: string, instruction: string, options?: AiOperationOptions) =>
    fetchJSON<Record<string, unknown>>(
      `/api/knowledge/capture-drafts/${encodeURIComponent(draftId)}/revise`,
      withAiOperation({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction }),
      }, options),
    ),
  reviseKnowledgeCapture: (captureId: string, instruction: string) =>
    fetchJSON<KnowledgeCaptureRevisionResponse>(
      `/api/knowledge/captures/${encodeURIComponent(captureId)}/revise`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction }),
      },
    ),
  deleteKnowledgeCaptureDraft: (draftId: string) =>
    fetchJSON<Record<string, unknown>>(
      `/api/knowledge/capture-drafts/${encodeURIComponent(draftId)}`,
      { method: "DELETE" },
    ),
  updateKnowledgeCapture: (captureId: string, body: KnowledgeCaptureUpdateRequest) =>
    fetchJSON<Record<string, unknown>>(
      `/api/knowledge/captures/${encodeURIComponent(captureId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  createKnowledgeAnswerDraft: (body: KnowledgeAnswerDraftRequest, options?: AiOperationOptions) =>
    fetchJSON<{
      ok: boolean;
      USER_VISIBLE_REPLY?: string;
      chat_preview?: string;
      meta?: Record<string, unknown>;
    }>("/api/knowledge/answer-drafts", withAiOperation({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, options)),
  createKnowledgeGardenDraft: (body: KnowledgeGardenDraftRequest, options?: AiOperationOptions) =>
    fetchJSON<KnowledgeGardenDraftResponse>("/api/knowledge/garden-drafts", withAiOperation({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, options)),
  getKnowledgeReadingDraft: (draftId: string) =>
    fetchJSON<KnowledgeReadingDraftResponse>(
      `/api/knowledge/reading-drafts/${encodeURIComponent(draftId)}`,
    ),
  getKnowledgeReadingDrafts: (limit = 50) =>
    fetchJSON<KnowledgeReadingDraftsResponse>(
      `/api/knowledge/reading-drafts?limit=${limit}`,
    ),
  getKnowledgeObjectEvents: (objectType: KnowledgeObjectEventType, objectId: string, limit = 30) =>
    fetchJSON<KnowledgeObjectEventsResponse>(
      `/api/knowledge/object-events?object_type=${encodeURIComponent(objectType)}&object_id=${encodeURIComponent(objectId)}&limit=${limit}`,
    ),
  commitKnowledgeReadingDraft: (draftId: string, options?: AiOperationOptions) =>
    fetchJSON<Record<string, unknown>>(
      `/api/knowledge/reading-drafts/${encodeURIComponent(draftId)}/commit`,
      withAiOperation({ method: "POST" }, options),
    ),
  reviseKnowledgeReadingDraft: (draftId: string, instruction: string, options?: AiOperationOptions) =>
    fetchJSON<Record<string, unknown>>(
      `/api/knowledge/reading-drafts/${encodeURIComponent(draftId)}/revise`,
      withAiOperation({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction }),
      }, options),
    ),
  deleteKnowledgeReadingDraft: (draftId: string) =>
    fetchJSON<Record<string, unknown>>(
      `/api/knowledge/reading-drafts/${encodeURIComponent(draftId)}`,
      { method: "DELETE" },
    ),
  getKnowledgeCards: (limit = 100) =>
    fetchJSON<KnowledgeCardsResponse>(`/api/knowledge/cards?limit=${limit}`),
  getKnowledgeCard: (cardId: string) =>
    fetchJSON<KnowledgeCardResponse>(
      `/api/knowledge/cards/${encodeURIComponent(cardId)}`,
    ),
  deleteKnowledgeCard: (cardId: string) =>
    fetchJSON<Record<string, unknown>>(
      `/api/knowledge/cards/${encodeURIComponent(cardId)}`,
      { method: "DELETE" },
    ),
  getKnowledgeGraph: (params: {
    focus_kind?: KnowledgeGraphNodeKind;
    focus_id?: string;
    depth?: number;
    limit?: number;
  } = {}) => {
    const qs = new URLSearchParams();
    if (params.focus_kind) qs.set("focus_kind", params.focus_kind);
    if (params.focus_id) qs.set("focus_id", params.focus_id);
    if (params.depth !== undefined) qs.set("depth", String(params.depth));
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return fetchJSON<KnowledgeGraphResponse>(`/api/knowledge/graph${suffix}`);
  },
  refreshKnowledgeGraph: () =>
    fetchJSON<KnowledgeGraphRefreshResult>("/api/knowledge/graph/refresh", {
      method: "POST",
    }),
};

export interface ActionResponse {
  name: string;
  ok: boolean;
  pid: number;
}

export interface ActionStatusResponse {
  exit_code: number | null;
  lines: string[];
  name: string;
  pid: number | null;
  running: boolean;
}

export interface PlatformStatus {
  error_code?: string;
  error_message?: string;
  state: string;
  updated_at: string;
}

export interface StatusResponse {
  active_sessions: number;
  config_path: string;
  config_version: number;
  env_path: string;
  gateway_exit_reason: string | null;
  gateway_health_url: string | null;
  gateway_pid: number | null;
  gateway_platforms: Record<string, PlatformStatus>;
  gateway_running: boolean;
  gateway_state: string | null;
  gateway_status_stale: boolean;
  gateway_updated_at: string | null;
  hermes_home: string;
  latest_config_version: number;
  release_date: string;
  version: string;
}

export interface DashboardUploadRequest {
  name: string;
  mime_type: string;
  content_base64: string;
}

export interface DashboardUploadResponse {
  ok: boolean;
  name: string;
  path: string;
  mime_type: string;
  size: number;
}

export type AutomationBoundaryKind =
  | "cron"
  | "launchagent"
  | "gateway_ticker"
  | "tool"
  | "watcher"
  | "repair";

export type AutomationBoundaryReadWrite =
  | "readonly"
  | "state_write"
  | "knowledge_storage_write"
  | "external_write"
  | "mixed";

export interface KnowledgeAutomationBoundary {
  id: string;
  name: string;
  kind: AutomationBoundaryKind;
  enabled: boolean;
  runtime_status: string;
  next_run_at: string;
  last_run_at: string;
  last_status: string;
  read_write: AutomationBoundaryReadWrite;
  writes_tables: string[];
  writes_paths: string[];
  toolsets: string[];
  risk_level: "low" | "medium" | "high" | string;
  description: string;
  pid?: number | null;
  source_path: string;
}

export interface KnowledgeAutomationBoundariesResponse {
  items: KnowledgeAutomationBoundary[];
  total: number;
  generated_at: number;
}

export interface KnowledgeLibraryFolder {
  path: string;
  name: string;
  count: number;
}

export interface KnowledgeLibrarySmartView {
  key: "recent" | "review" | "suggestions" | "unindexed" | string;
  label: string;
  count: number;
}

export interface KnowledgeLibraryFoldersResponse {
  folders: KnowledgeLibraryFolder[];
  smart_views: KnowledgeLibrarySmartView[];
}

export interface KnowledgeLibraryFolderCreateResponse {
  ok: boolean;
  folder: KnowledgeLibraryFolder;
}

export interface KnowledgeLibraryFolderUpdateResponse {
  ok: boolean;
  folder: KnowledgeLibraryFolder;
  updated_items: number;
}

export type KnowledgeLibraryItemKind = "capture" | "capture_draft";

export interface KnowledgeLibraryItem {
  id: string;
  kind: KnowledgeLibraryItemKind;
  title: string;
  summary: string;
  preview: string;
  body: string;
  folder_path: string;
  tags: string[];
  source: string;
  source_type: string;
  status: string;
  file_path: string;
  raw_path: string;
  word_count: number;
  created_at: string;
  updated_at: string;
  indexed: boolean;
  title_source: string;
  garden_card_count: number;
  committed_capture_id?: string;
}

export interface KnowledgeLibraryItemsResponse {
  items: KnowledgeLibraryItem[];
  total: number;
}

export interface KnowledgeLibraryItemResponse {
  item: KnowledgeLibraryItem;
}

export interface KnowledgeLibraryOpenLocalResponse {
  ok: boolean;
  path: string;
}

export interface KnowledgeLibraryCreateRequest {
  title?: string;
  body?: string;
  folder_path?: string;
  source?: string;
  source_type?: string;
}

export interface KnowledgeLibraryUpdateRequest {
  title?: string;
  body?: string | null;
  folder_path?: string | null;
  summary?: string | null;
  tags?: string[] | null;
  folder_suggestion?: Record<string, unknown> | null;
  card_suggestion?: Record<string, unknown> | null;
}

export interface KnowledgeLibraryCreateResponse {
  ok: boolean;
  item?: KnowledgeLibraryItem;
  result?: Record<string, unknown>;
}

export interface KnowledgeLibraryUpdateResponse {
  ok: boolean;
  item: KnowledgeLibraryItem;
  backup_path?: string;
}

export interface KnowledgeLibraryDependencies {
  garden_cards?: Array<{ id: string; title: string; status: string }>;
  garden_drafts?: Array<{ id: string; title: string; status: string }>;
  committed_drafts?: Array<{ id: string; title: string; status: string }>;
  backlinks?: Array<{ path: string; title: string }>;
  event_count?: number;
  policy?: Record<string, string>;
}

export interface KnowledgeLibraryDependenciesResponse {
  ok?: boolean;
  id?: string;
  dependencies?: KnowledgeLibraryDependencies;
}

export interface KnowledgeLibraryDeleteResponse {
  ok?: boolean;
  status?: string;
  id?: string;
  message?: string;
  dependencies?: KnowledgeLibraryDependencies;
}

export interface KnowledgeLibraryPermanentDeleteResponse {
  ok?: boolean;
  status?: string;
  id?: string;
  message?: string;
  deleted?: {
    knowledge_file?: string;
    raw_file?: string;
    rows?: Record<string, number>;
  };
}

export type KnowledgeResearchMode = "current_article_only" | "local_only" | "local_web" | "web_only";

export interface KnowledgeResearchSource {
  ref?: string;
  type?: string;
  id?: string;
  item_kind?: KnowledgeLibraryItemKind;
  item_id?: string;
  title?: string;
  path?: string;
  file_path?: string;
  open_url?: string;
  file_url?: string;
  url?: string;
  domain?: string;
  search_backend?: string;
  fallback_candidate?: boolean;
  section?: string;
  excerpt?: string;
  description?: string;
  extract_status?: string;
  rank_score?: number;
  source_role?: "evidence" | "clue" | "rejected" | string;
  evidence_role?: string;
  source_authority?: string;
  allowed_usage?: string[];
  confidence?: string;
  supports_claims?: string[];
  source_score?: number;
  quality_reason?: string;
  entity_match?: boolean;
  quality_tags?: string[];
}

export interface KnowledgeResearchTrace {
  plan_status?: string;
  intent_label?: string;
  mode?: KnowledgeResearchMode;
  web_search_attempted?: boolean;
  web_queries?: string[];
  rewritten_web_queries?: string[];
  query_intent?: string;
  answer_depth?: "brief" | "normal" | "detailed" | string;
  search_quality?: Record<string, unknown>;
  provider_status?: Record<string, unknown>;
  retrieval_health?: Record<string, unknown>;
  fallback_attempts?: Array<Record<string, unknown>>;
  knowledge_sources?: KnowledgeResearchSource[];
  web_sources?: KnowledgeResearchSource[];
  candidate_sources?: KnowledgeResearchSource[];
  retrieved_web_sources?: KnowledgeResearchSource[];
  evidence_sources?: KnowledgeResearchSource[];
  clue_sources?: KnowledgeResearchSource[];
  rejected_sources?: KnowledgeResearchSource[];
  source_counts?: Record<string, number>;
  [key: string]: unknown;
}

export interface KnowledgeChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface KnowledgeReasoningTrace {
  api_reasoning?: string | Record<string, unknown> | unknown[];
  reasoning_summary?: string;
  fallback_reason?: string;
  source?: "api" | "fallback" | "missing" | string;
  [key: string]: unknown;
}

export interface KnowledgeLibrarySelectionChatRequest {
  question: string;
  selected_text?: string;
  surrounding_before?: string;
  surrounding_after?: string;
  heading_path?: string[];
  selection_start?: number;
  selection_end?: number;
  selection_confidence?: "offset" | "text_only" | "none";
  mode?: KnowledgeResearchMode;
  history?: KnowledgeChatHistoryMessage[];
  history_summary?: string;
  history_summary_version?: number;
  history_overflow?: KnowledgeChatHistoryMessage[];
  force_web?: boolean;
}

export interface KnowledgeLibrarySelectionChatResponse {
  ok: boolean;
  answer: string;
  used_selection: boolean;
  citations?: Array<{ label: string; excerpt: string }>;
  mode?: KnowledgeResearchMode;
  sources?: {
    knowledge?: KnowledgeResearchSource[];
    web?: KnowledgeResearchSource[];
  };
  warnings?: string[];
  meta?: {
    web_queries?: string[];
    query_intent?: string;
    search_quality?: Record<string, unknown>;
    rewritten_web_queries?: string[];
    provider_status?: Record<string, unknown>;
    research_trace?: KnowledgeResearchTrace;
    reasoning_trace?: KnowledgeReasoningTrace;
    web_search_attempted?: boolean;
    updated_history_summary?: string;
    updated_history_summary_version?: number;
    history_summary_failed?: boolean;
    history_summary_error?: string;
  };
}

export interface KnowledgeLibrarySelectionChatStreamEvent {
  event: "start" | "progress" | "complete" | "error" | "summary_updated";
  type?: string;
  mode?: KnowledgeResearchMode;
  plan_status?: string;
  intent_label?: string;
  needs_web?: boolean;
  needs_local?: boolean;
  complexity?: string;
  question_type?: string;
  search_budget?: number;
  queries?: string[];
  query?: string;
  query_count?: number;
  query_status?: Record<string, unknown>;
  result_count?: number;
  candidate_count?: number;
  material_count?: number;
  opened_pages?: number;
  extracted_pages?: number;
  summary_only_pages?: number;
  web_sources?: KnowledgeResearchSource[];
  knowledge_sources?: KnowledgeResearchSource[];
  candidate_sources?: KnowledgeResearchSource[];
  evidence_sources?: KnowledgeResearchSource[];
  clue_sources?: KnowledgeResearchSource[];
  rejected_sources?: KnowledgeResearchSource[];
  rewritten_queries?: string[];
  search_quality?: Record<string, unknown>;
  provider_status?: Record<string, unknown>;
  backend?: string;
  reason?: string;
  new_result_count?: number;
  warnings?: string[];
  error?: string;
  message?: string;
  stage?: string;
  delta?: string;
  updated_history_summary?: string;
  updated_history_summary_version?: number;
  response?: KnowledgeLibrarySelectionChatResponse;
}

export type KnowledgeCardKind = "viewpoint" | "method" | "fact" | "risk";

export interface KnowledgeCaptureDraft {
  id: string;
  title: string;
  status: string;
  source: string;
  source_type: string;
  word_count: number;
  instruction: string;
  summary: string;
  tags: string[];
  capture_intent: Record<string, unknown>;
  user_intent: string;
  committed_capture_id: string;
  created_at: string;
  updated_at: string;
  draft_preview: string;
  raw_preview: string;
  draft_text?: string;
  raw_text?: string;
  historical_draft_text?: string;
  file_path?: string;
  raw_path?: string;
  capture_note_missing?: boolean;
}

export interface KnowledgeCaptureDraftsResponse {
  drafts: KnowledgeCaptureDraft[];
  total: number;
  open_count: number;
}

export interface KnowledgeCaptureDraftResponse {
  draft: KnowledgeCaptureDraft;
}

export interface KnowledgeEditableCaptureDraftRequest {
  content: string;
  source?: string;
  source_type?: string;
  instruction?: string;
  title?: string;
  title_source?: "ai" | "user";
  folder_path?: string;
  organize?: boolean;
  existing_folders?: string[];
}

export interface KnowledgeEditableCaptureDraftUpdateRequest {
  content: string;
  title?: string;
  title_source?: "ai" | "user";
  summary?: string | null;
  tags?: string[] | null;
  folder_path?: string;
  folder_suggestion?: Record<string, unknown> | null;
  card_suggestion?: Record<string, unknown> | null;
  organize?: boolean;
  existing_folders?: string[];
}

export interface KnowledgeCaptureUpdateRequest {
  body?: string;
  title?: string;
  folder_path?: string | null;
}

export interface KnowledgeCaptureRevisionResponse {
  ok: boolean;
  capture_id: string;
  title: string;
  body: string;
  summary: string;
  tags: string[];
  source: "ai_revision" | string;
}

export interface KnowledgeAnswerDraftSource {
  type?: string;
  id?: string;
  source_id?: string;
  title?: string;
  label?: string;
  url?: string;
  excerpt?: string;
}

export interface KnowledgeReadingDraft {
  id: string;
  session_id: string;
  output_type: "local_learning_note" | "knowledge_card" | "enhance_capture" | string;
  target_capture_id: string;
  title: string;
  summary: string;
  status: string;
  created_at: string;
  updated_at: string;
  draft_preview: string;
  draft_text?: string;
  meta?: Record<string, unknown>;
}

export interface KnowledgeReadingDraftResponse {
  draft: KnowledgeReadingDraft;
}

export interface KnowledgeReadingDraftsResponse {
  drafts: KnowledgeReadingDraft[];
  total: number;
  open_count: number;
}

export interface KnowledgeAnswerDraftRequest {
  hermes_session_id: string;
  user_message: string;
  assistant_answer: string;
  instruction: string;
  output_type: "auto" | "local_learning_note" | "knowledge_card" | "enhance_capture";
  assistant_message_id: string;
  sources: KnowledgeAnswerDraftSource[];
  target_capture_id?: string;
  answer_source?: "auto" | "provided" | "latest_rag_full_answer";
}

export interface KnowledgeGardenDraftRequest {
  capture_ids: string[];
  title?: string;
  card_kind?: string;
  instruction?: string;
}

export interface KnowledgeGardenDraftResponse {
  ok?: boolean;
  status?: string;
  USER_VISIBLE_REPLY?: string;
  chat_preview?: string;
  error?: string;
  errors?: string[];
  meta?: Record<string, unknown>;
  durable_artifacts?: Array<Record<string, unknown>>;
  warnings?: string[];
}

export type KnowledgeObjectEventType = "conversation" | "reading_draft" | "capture_draft" | "capture" | "garden_draft" | "garden_card";

export interface KnowledgeObjectEvent {
  id: string;
  agent: string;
  intent: string;
  trigger: string;
  status: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  evidence: Record<string, unknown>;
  warnings: string[];
  errors: string[];
  created_at: string;
  updated_at: string;
  completed_at: string;
}

export interface KnowledgeObjectEventsResponse {
  events: KnowledgeObjectEvent[];
  related_ids: string[];
  total: number;
}

export interface KnowledgeSource {
  id: string;
  title: string;
  file_path: string;
  summary: string;
}

export interface KnowledgeCard {
  id: string;
  title: string;
  kind: KnowledgeCardKind;
  summary: string;
  status: string;
  updated_at: string;
  created_at: string;
  file_path: string;
  source_theme: string;
  sources: KnowledgeSource[];
  source_count: number;
  schema_version?: string;
  payload?: KnowledgeCardPayload;
  core_arguments?: Array<Record<string, unknown> | string>;
  knowledge_links?: string[];
  key_materials?: string[];
  my_view?: string;
  markdown?: string;
}

export interface KnowledgeCardPayload {
  schema_version: string;
  title: string;
  card_kind: KnowledgeCardKind;
  claim: string;
  confidence?: "low" | "medium" | "high" | string;
  when_to_use: string[];
  core_judgments: KnowledgeCardJudgment[];
  boundaries: string[];
  action_items: string[];
  related_card_ids: string[];
  source_ids: string[];
}

export interface KnowledgeCardJudgment {
  id: string;
  statement: string;
  reasoning: string;
  support: KnowledgeCardSupport[];
}

export interface KnowledgeCardSupport {
  summary: string;
  source_ids: string[];
}

export interface KnowledgeCardsResponse {
  cards: KnowledgeCard[];
  groups: Record<KnowledgeCardKind, number>;
  total: number;
}

export interface KnowledgeCardResponse {
  card: KnowledgeCard;
}

export type KnowledgeGraphNodeKind = "capture" | "garden_card" | "theme_candidate";

export type KnowledgeGraphRelationType =
  | "semantic_similarity"
  | "card_uses_capture"
  | "card_links_card"
  | "theme_groups_capture";

export interface KnowledgeGraphNode {
  id: string;
  kind: KnowledgeGraphNodeKind;
  title: string;
  summary: string;
  file_path: string;
  open_url: string;
  file_url: string;
}

export interface KnowledgeGraphEdge {
  id: string;
  source_kind: KnowledgeGraphNodeKind;
  source_id: string;
  target_kind: KnowledgeGraphNodeKind;
  target_id: string;
  relation_type: KnowledgeGraphRelationType;
  score: number;
  evidence: Record<string, unknown>;
  generated_by: string;
  updated_at: string;
}

export interface KnowledgeGraphResponse {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  meta: {
    focus_kind: string;
    focus_id: string;
    depth: number;
    edge_count: number;
  };
}

export interface KnowledgeGraphRefreshResult {
  node_count: number;
  edge_count: number;
  relation_counts: Record<string, number>;
}

export interface SessionInfo {
  id: string;
  source: string | null;
  model: string | null;
  title: string | null;
  started_at: number;
  ended_at: number | null;
  last_active: number;
  is_active: boolean;
  message_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  preview: string | null;
  parent_session_id?: string | null;
}

export interface SessionLatestDescendantResponse {
  requested_session_id: string;
  session_id: string;
  path: string[];
  changed: boolean;
}

export interface PaginatedSessions {
  sessions: SessionInfo[];
  total: number;
  limit: number;
  offset: number;
}

export interface EnvVarInfo {
  is_set: boolean;
  redacted_value: string | null;
  description: string;
  url: string | null;
  category: string;
  is_password: boolean;
  tools: string[];
  advanced: boolean;
}

export interface SessionMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  tool_name?: string;
  tool_call_id?: string;
  timestamp?: number;
}

export interface SessionMessagesResponse {
  session_id: string;
  messages: SessionMessage[];
}

export interface LogsResponse {
  file: string;
  lines: string[];
}

export interface AnalyticsDailyEntry {
  day: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  reasoning_tokens: number;
  estimated_cost: number;
  actual_cost: number;
  sessions: number;
  api_calls: number;
}

export interface AnalyticsModelEntry {
  model: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
  sessions: number;
  api_calls: number;
}

export interface AnalyticsSkillEntry {
  skill: string;
  view_count: number;
  manage_count: number;
  total_count: number;
  percentage: number;
  last_used_at: number | null;
}

export interface AnalyticsSkillsSummary {
  total_skill_loads: number;
  total_skill_edits: number;
  total_skill_actions: number;
  distinct_skills_used: number;
}

export interface AnalyticsResponse {
  daily: AnalyticsDailyEntry[];
  by_model: AnalyticsModelEntry[];
  totals: {
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_reasoning: number;
    total_estimated_cost: number;
    total_actual_cost: number;
    total_sessions: number;
    total_api_calls: number;
  };
  skills: {
    summary: AnalyticsSkillsSummary;
    top_skills: AnalyticsSkillEntry[];
  };
}

export interface ProfileInfo {
  name: string;
  path: string;
  is_default: boolean;
  model: string | null;
  provider: string | null;
  has_env: boolean;
  skill_count: number;
}

export interface ModelsAnalyticsModelEntry {
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  reasoning_tokens: number;
  estimated_cost: number;
  actual_cost: number;
  sessions: number;
  api_calls: number;
  tool_calls: number;
  last_used_at: number;
  avg_tokens_per_session: number;
  capabilities: {
    supports_tools?: boolean;
    supports_vision?: boolean;
    supports_reasoning?: boolean;
    context_window?: number;
    max_output_tokens?: number;
    model_family?: string;
  };
}

export interface ModelsAnalyticsResponse {
  models: ModelsAnalyticsModelEntry[];
  totals: {
    distinct_models: number;
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_reasoning: number;
    total_estimated_cost: number;
    total_actual_cost: number;
    total_sessions: number;
    total_api_calls: number;
  };
  period_days: number;
}

export interface CronJob {
  id: string;
  name?: string | null;
  prompt?: string | null;
  script?: string | null;
  schedule?: { kind?: string; expr?: string; display?: string };
  schedule_display?: string | null;
  enabled: boolean;
  state?: string | null;
  deliver?: string | null;
  last_run_at?: string | null;
  next_run_at?: string | null;
  last_error?: string | null;
}

export interface SkillInfo {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
}

export interface ToolsetInfo {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  tools: string[];
}

export interface SessionSearchResult {
  session_id: string;
  snippet: string;
  role: string | null;
  source: string | null;
  model: string | null;
  session_started: number | null;
}

export interface SessionSearchResponse {
  results: SessionSearchResult[];
}

// ── Model info types ──────────────────────────────────────────────────

export interface ModelInfoResponse {
  model: string;
  provider: string;
  auto_context_length: number;
  config_context_length: number;
  effective_context_length: number;
  capabilities: {
    supports_tools?: boolean;
    supports_vision?: boolean;
    supports_reasoning?: boolean;
    context_window?: number;
    max_output_tokens?: number;
    model_family?: string;
  };
}

// ── Model options / assignment types ──────────────────────────────────

export interface ModelOptionProvider {
  name: string;
  slug: string;
  models?: string[];
  total_models?: number;
  is_current?: boolean;
  is_user_defined?: boolean;
  source?: string;
  warning?: string;
}

export interface ModelOptionsResponse {
  model?: string;
  provider?: string;
  providers?: ModelOptionProvider[];
}

export interface AuxiliaryTaskAssignment {
  task: string;
  provider: string;
  model: string;
  base_url: string;
}

export interface AuxiliaryModelsResponse {
  tasks: AuxiliaryTaskAssignment[];
  main: { provider: string; model: string };
}

export interface ModelAssignmentRequest {
  scope: "main" | "auxiliary";
  provider: string;
  model: string;
  /** For auxiliary: task slot name, "" for all, "__reset__" to reset all. */
  task?: string;
}

export interface ModelAssignmentResponse {
  ok: boolean;
  scope?: string;
  provider?: string;
  model?: string;
  tasks?: string[];
  reset?: boolean;
}

// ── OAuth provider types ────────────────────────────────────────────────

export interface OAuthProviderStatus {
  logged_in: boolean;
  source?: string | null;
  source_label?: string | null;
  token_preview?: string | null;
  expires_at?: string | null;
  has_refresh_token?: boolean;
  last_refresh?: string | null;
  error?: string;
}

export interface OAuthProvider {
  id: string;
  name: string;
  /** "pkce" (browser redirect + paste code), "device_code" (show code + URL),
   *  or "external" (delegated to a separate CLI like Claude Code or Qwen). */
  flow: "pkce" | "device_code" | "external";
  cli_command: string;
  docs_url: string;
  status: OAuthProviderStatus;
}

export interface OAuthProvidersResponse {
  providers: OAuthProvider[];
}

/** Discriminated union — the shape of /start depends on the flow. */
export type OAuthStartResponse =
  | {
      session_id: string;
      flow: "pkce";
      auth_url: string;
      expires_in: number;
    }
  | {
      session_id: string;
      flow: "device_code";
      user_code: string;
      verification_url: string;
      expires_in: number;
      poll_interval: number;
    };

export interface OAuthSubmitResponse {
  ok: boolean;
  status: "approved" | "error";
  message?: string;
}

export interface OAuthPollResponse {
  session_id: string;
  status: "pending" | "approved" | "denied" | "expired" | "error";
  error_message?: string | null;
  expires_at?: number | null;
}

// ── Dashboard theme types ──────────────────────────────────────────────

export interface DashboardThemeSummary {
  description: string;
  label: string;
  name: string;
  /** Full theme definition for user themes; undefined for built-ins
   *  (which the frontend already has locally). */
  definition?: DashboardTheme;
}

export interface DashboardThemesResponse {
  active: string;
  themes: DashboardThemeSummary[];
}

// ── Dashboard plugin types ─────────────────────────────────────────────

export interface PluginManifestResponse {
  name: string;
  label: string;
  description: string;
  icon: string;
  version: string;
  tab: {
    path: string;
    position?: string;
    override?: string;
    hidden?: boolean;
  };
  slots?: string[];
  entry: string;
  css?: string | null;
  has_api: boolean;
  source: string;
}

export interface HubAgentPluginRow {
  name: string;
  version: string;
  description: string;
  source: string;
  runtime_status: "disabled" | "enabled" | "inactive";
  has_dashboard_manifest: boolean;
  dashboard_manifest: PluginManifestResponse | null;
  path: string;
  can_remove: boolean;
  can_update_git: boolean;
  auth_required: boolean;
  auth_command: string;
  user_hidden: boolean;
}

export interface PluginsHubProviders {
  memory_provider: string;
  memory_options: Array<{ name: string; description: string }>;
  context_engine: string;
  context_options: Array<{ name: string; description: string }>;
}

export interface PluginsHubResponse {
  plugins: HubAgentPluginRow[];
  orphan_dashboard_plugins: PluginManifestResponse[];
  providers: PluginsHubProviders;
}

export interface AgentPluginInstallRequest {
  identifier: string;
  force?: boolean;
  enable?: boolean;
}

export interface AgentPluginInstallResponse {
  ok: boolean;
  plugin_name?: string;
  warnings?: string[];
  missing_env?: string[];
  after_install_path?: string | null;
  enabled?: boolean;
  error?: string;
}

export interface AgentPluginUpdateResponse {
  ok: boolean;
  name?: string;
  output?: string;
  unchanged?: boolean;
  error?: string;
}

export interface PluginProvidersPutRequest {
  memory_provider?: string;
  context_engine?: string;
}
