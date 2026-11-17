import type { Page, Route } from "playwright/test";

export type MockCaptureDraft = {
  id: string;
  title: string;
  status: string;
  committed_capture_id: string;
  draft_text: string;
};

export type MockReadingDraft = {
  id: string;
  title: string;
  status: string;
  target_capture_id: string;
  draft_text: string;
};

export type MockLibraryItem = {
  id: string;
  title: string;
  body: string;
};

export type MockPromptScenario = {
  assistantText: string;
  toolName: string;
  captureDraft?: MockCaptureDraft;
};

export type MockKnowledgeState = {
  sessionId: string;
  messages: Array<{ role: string; text: string }>;
  captureDrafts: MockCaptureDraft[];
  readingDrafts: MockReadingDraft[];
  libraryItems?: MockLibraryItem[];
  promptScenario?: MockPromptScenario;
};

export type KnowledgeBrowserProbe = {
  requests: Array<{ method: string; path: string }>;
  failedResponses: string[];
  consoleErrors: string[];
  pageErrors: string[];
  unknownGatewayMethods: string[];
};

function captureDraftPayload(draft: MockCaptureDraft) {
  return {
    ...draft,
    source: "e2e",
    source_type: "note",
    word_count: draft.draft_text.length,
    instruction: "整理后保存",
    summary: "浏览器端到端测试材料",
    tags: ["e2e"],
    capture_intent: {},
    user_intent: "refined_note",
    created_at: "2026-07-11T00:00:00Z",
    updated_at: "2026-07-11T00:00:00Z",
    draft_preview: draft.draft_text,
    raw_preview: draft.draft_text,
    raw_text: draft.draft_text,
  };
}

function readingDraftPayload(draft: MockReadingDraft) {
  return {
    ...draft,
    session_id: "reading-session-e2e",
    output_type: "local_learning_note",
    summary: "浏览器端到端 Reading 草稿",
    created_at: "2026-07-11T00:00:00Z",
    updated_at: "2026-07-11T00:00:00Z",
    draft_preview: draft.draft_text,
    meta: {},
  };
}

function libraryItemPayload(item: MockLibraryItem) {
  return {
    ...item,
    kind: "capture",
    summary: "浏览器端到端已保存材料",
    preview: item.body,
    folder_path: "Inbox",
    tags: ["e2e"],
    source: "e2e",
    source_type: "note",
    status: "processed",
    file_path: `captures/${item.id}.md`,
    raw_path: "",
    word_count: item.body.length,
    created_at: "2026-07-11T00:00:00Z",
    updated_at: "2026-07-11T00:00:00Z",
    indexed: true,
    title_source: "ai",
    garden_card_count: 0,
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

export async function installKnowledgeBrowserFixture(
  page: Page,
  state: MockKnowledgeState,
): Promise<KnowledgeBrowserProbe> {
  const probe: KnowledgeBrowserProbe = {
    requests: [],
    failedResponses: [],
    consoleErrors: [],
    pageErrors: [],
    unknownGatewayMethods: [],
  };

  await page.addInitScript(() => {
    window.__HERMES_SESSION_TOKEN__ = "knowledge-e2e-token";
  });

  page.on("console", (message) => {
    if (message.type() === "error") probe.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    probe.pageErrors.push(error.message);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      probe.failedResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  });

  await page.routeWebSocket("**/api/ws?token=*", (socket) => {
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw)) as {
        id?: string;
        method?: string;
      };
      const id = request.id;
      if (!id) return;
      const respond = (result: unknown) => {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
      };
      if (request.method === "session.resume") {
        respond({
          session_id: "gateway-e2e-session",
          resumed: state.sessionId,
          message_count: state.messages.length,
          messages: state.messages,
          info: {},
        });
        return;
      }
      if (request.method === "session.create") {
        respond({ session_id: "gateway-e2e-session" });
        return;
      }
      if (request.method === "session.history") {
        respond({ messages: state.messages });
        return;
      }
      if (request.method === "session.set_toolsets") {
        respond({ ok: true });
        return;
      }
      if (request.method === "prompt.submit" && state.promptScenario) {
        respond({ accepted: true });
        const scenario = state.promptScenario;
        if (scenario.captureDraft && !state.captureDrafts.some((draft) => draft.id === scenario.captureDraft?.id)) {
          state.captureDrafts.push(scenario.captureDraft);
        }
        state.messages.push({ role: "assistant", text: scenario.assistantText });
        socket.send(JSON.stringify({
          method: "event",
          params: { type: "message.start", session_id: "gateway-e2e-session", payload: {} },
        }));
        socket.send(JSON.stringify({
          method: "event",
          params: {
            type: "tool.start",
            session_id: "gateway-e2e-session",
            payload: { tool_id: "tool-e2e", name: scenario.toolName, context: "knowledge e2e" },
          },
        }));
        socket.send(JSON.stringify({
          method: "event",
          params: {
            type: "tool.complete",
            session_id: "gateway-e2e-session",
            payload: { tool_id: "tool-e2e", name: scenario.toolName, summary: "工具执行成功" },
          },
        }));
        socket.send(JSON.stringify({
          method: "event",
          params: {
            type: "message.complete",
            session_id: "gateway-e2e-session",
            payload: { text: scenario.assistantText },
          },
        }));
        return;
      }
      probe.unknownGatewayMethods.push(request.method || "unknown");
      respond({});
    });
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    probe.requests.push({ method, path });

    if (path === "/api/knowledge/capture-drafts" && method === "GET") {
      await fulfillJson(route, {
        drafts: state.captureDrafts.map(captureDraftPayload),
        total: state.captureDrafts.length,
        open_count: state.captureDrafts.filter((draft) => draft.status !== "committed").length,
      });
      return;
    }
    if (path === "/api/knowledge/reading-drafts" && method === "GET") {
      await fulfillJson(route, {
        drafts: state.readingDrafts.map(readingDraftPayload),
        total: state.readingDrafts.length,
        open_count: state.readingDrafts.filter((draft) => draft.status === "open").length,
      });
      return;
    }

    const captureCommit = path.match(/^\/api\/knowledge\/capture-drafts\/([^/]+)\/commit$/);
    if (captureCommit && method === "POST") {
      const draft = state.captureDrafts.find((item) => item.id === captureCommit[1]);
      if (!draft) {
        await fulfillJson(route, { detail: "Capture draft not found" }, 404);
        return;
      }
      draft.status = "committed";
      draft.committed_capture_id = `capture-${draft.id}`;
      await fulfillJson(route, {
        ok: true,
        status: "success",
        meta: { draft_id: draft.id, capture_id: draft.committed_capture_id },
      });
      return;
    }

    const readingCommit = path.match(/^\/api\/knowledge\/reading-drafts\/([^/]+)\/commit$/);
    if (readingCommit && method === "POST") {
      const draft = state.readingDrafts.find((item) => item.id === readingCommit[1]);
      if (!draft) {
        await fulfillJson(route, { detail: "Reading draft not found" }, 404);
        return;
      }
      draft.status = "committed";
      draft.target_capture_id = `capture-${draft.id}`;
      await fulfillJson(route, {
        ok: true,
        status: "success",
        meta: { reading_draft_id: draft.id, capture_id: draft.target_capture_id },
      });
      return;
    }

    const captureDetail = path.match(/^\/api\/knowledge\/capture-drafts\/([^/]+)$/);
    if (captureDetail && method === "GET") {
      const draft = state.captureDrafts.find((item) => item.id === captureDetail[1]);
      await fulfillJson(
        route,
        draft ? { draft: captureDraftPayload(draft) } : { detail: "Capture draft not found" },
        draft ? 200 : 404,
      );
      return;
    }
    const readingDetail = path.match(/^\/api\/knowledge\/reading-drafts\/([^/]+)$/);
    if (readingDetail && method === "GET") {
      const draft = state.readingDrafts.find((item) => item.id === readingDetail[1]);
      await fulfillJson(
        route,
        draft ? { draft: readingDraftPayload(draft) } : { detail: "Reading draft not found" },
        draft ? 200 : 404,
      );
      return;
    }

    if (path === "/api/knowledge/library/folders") {
      await fulfillJson(route, { folders: [], smart_views: [] });
      return;
    }
    if (path === "/api/knowledge/library/items" && method === "GET") {
      const items = (state.libraryItems || []).map(libraryItemPayload);
      await fulfillJson(route, { items, total: items.length });
      return;
    }
    const libraryDetail = path.match(/^\/api\/knowledge\/library\/items\/capture\/([^/]+)$/);
    if (libraryDetail && method === "GET") {
      const item = (state.libraryItems || []).find((candidate) => candidate.id === libraryDetail[1]);
      await fulfillJson(
        route,
        item ? { item: libraryItemPayload(item) } : { detail: "Library item not found" },
        item ? 200 : 404,
      );
      return;
    }
    if (path === "/api/knowledge/automation-boundaries") {
      await fulfillJson(route, { boundaries: [] });
      return;
    }
    if (path === "/api/knowledge/object-events") {
      await fulfillJson(route, { events: [], related_ids: [], total: 0 });
      return;
    }
    if (path === "/api/sessions") {
      await fulfillJson(route, {
        sessions: [{ id: state.sessionId, title: "知识测试会话", message_count: state.messages.length }],
      });
      return;
    }
    if (path === "/api/dashboard/plugins") {
      await fulfillJson(route, []);
      return;
    }
    if (path === "/api/dashboard/themes") {
      await fulfillJson(route, { themes: [] });
      return;
    }
    if (path === "/api/status") {
      await fulfillJson(route, { status: "ok" });
      return;
    }

    await fulfillJson(route, { detail: `Unhandled E2E API route: ${method} ${path}` }, 501);
  });

  return probe;
}
