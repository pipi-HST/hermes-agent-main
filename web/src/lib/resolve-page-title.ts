import type { Translations } from "@/i18n/types";

const BUILTIN: Record<string, keyof Translations["app"]["nav"]> = {
  "/chat": "chat",
  "/sessions": "sessions",
  "/analytics": "analytics",
  "/models": "models",
  "/logs": "logs",
  "/cron": "cron",
  "/skills": "skills",
  "/plugins": "plugins",
  "/profiles": "profiles",
  "/config": "config",
  "/env": "keys",
  "/docs": "documentation",
};

const CUSTOM_TITLES: Record<string, string> = {
  "/knowledge-library": "资料库",
  "/knowledge-chat": "工作台",
  "/capture-review": "Capture Review",
  "/cards-board": "知识卡片",
};

export function resolvePageTitle(
  pathname: string,
  t: Translations,
  pluginTabs: { path: string; label: string }[],
): string {
  const normalized = pathname.replace(/\/$/, "") || "/";
  if (normalized === "/") {
    return "工作台";
  }
  const plugin = pluginTabs.find((p) => p.path === normalized);
  if (plugin) {
    return plugin.label;
  }
  if (normalized.startsWith("/cards-board/")) {
    return "知识卡片";
  }
  const customTitle = CUSTOM_TITLES[normalized];
  if (customTitle) {
    return customTitle;
  }
  const key = BUILTIN[normalized];
  if (key) {
    return t.app.nav[key];
  }
  // Derive title from pathname: "/profiles" → "Profiles"
  const segment = normalized.slice(1);
  if (segment) {
    return segment.charAt(0).toUpperCase() + segment.slice(1);
  }
  return t.app.webUi;
}
