import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  Routes,
  Route,
  NavLink,
  Navigate,
  useLocation,
} from "react-router-dom";
import {
  BookOpen,
  ChevronRight,
  Layers3,
  Menu,
  PanelLeftClose,
  PenLine,
  X,
} from "lucide-react";
import { Button } from "@nous-research/ui/ui/components/button";
import { SelectionSwitcher } from "@nous-research/ui/ui/components/selection-switcher";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Typography } from "@/components/NouiTypography";
import { cn } from "@/lib/utils";
import { Backdrop } from "@/components/Backdrop";
import { PageHeaderProvider } from "@/contexts/PageHeaderProvider";
import { WorkspaceChromeProvider } from "@/contexts/WorkspaceChromeContext";
import ConfigPage from "@/pages/ConfigPage";
import DocsPage from "@/pages/DocsPage";
import EnvPage from "@/pages/EnvPage";
import SessionsPage from "@/pages/SessionsPage";
import LogsPage from "@/pages/LogsPage";
import AnalyticsPage from "@/pages/AnalyticsPage";
import ModelsPage from "@/pages/ModelsPage";
import CronPage from "@/pages/CronPage";
import ProfilesPage from "@/pages/ProfilesPage";
import SkillsPage from "@/pages/SkillsPage";
import PluginsPage from "@/pages/PluginsPage";
import ChatPage from "@/pages/ChatPage";
import KnowledgeChatPage from "@/pages/KnowledgeChatPage";
import KnowledgeLibraryPage from "@/pages/KnowledgeLibraryPage";
import KnowledgeCardsBoardPage from "@/pages/KnowledgeCardsBoardPage";
import { useI18n } from "@/i18n";
import type { Translations } from "@/i18n/types";
import { PluginPage, PluginSlot, usePlugins } from "@/plugins";
import type { PluginManifest } from "@/plugins";
import { useTheme } from "@/themes";
import { isDashboardEmbeddedChatEnabled } from "@/lib/dashboard-flags";

function RootRedirect() {
  return <Navigate to="/knowledge-chat" replace />;
}

function UnknownRouteFallback({ pluginsLoading }: { pluginsLoading: boolean }) {
  if (pluginsLoading) {
    // Render nothing during the plugin-load window — a spinner here would just flash.
    return null;
  }
  return <Navigate to="/knowledge-chat" replace />;
}

// The three knowledge routes are one learning loop, so the sidebar keeps them
// in learning order: read the source material, distill cards, then output a topic.
const KNOWLEDGE_LIBRARY_NAV_ITEM: NavItem = {
  path: "/knowledge-library",
  label: "资料伴读",
  icon: BookOpen,
};

const CARDS_BOARD_NAV_ITEM: NavItem = {
  path: "/cards-board",
  label: "知识卡片",
  icon: Layers3,
};

const WORKBENCH_NAV_ITEM: NavItem = {
  path: "/knowledge-chat",
  label: "专题输出",
  icon: PenLine,
};

/**
 * Built-in routes except /chat.  Chat is rendered persistently (outside
 * <Routes>) when embedded — see the persistent chat host block rendered
 * inline near the bottom of this file — so the PTY child, WebSocket,
 * and xterm instance survive when the user visits another tab and comes
 * back.  A `display:none` toggle hides the terminal without unmounting.
 * Routing still owns the URL so /chat deep-links, browser back/forward,
 * and nav highlight keep working.
 */
const BUILTIN_ROUTES_CORE: Record<string, ComponentType> = {
  "/": RootRedirect,
  "/sessions": SessionsPage,
  "/analytics": AnalyticsPage,
  "/models": ModelsPage,
  "/logs": LogsPage,
  "/cron": CronPage,
  "/skills": SkillsPage,
  "/plugins": PluginsPage,
  "/profiles": ProfilesPage,
  "/knowledge-library": KnowledgeLibraryPage,
  "/knowledge-chat": KnowledgeChatPage,
  "/capture-review": KnowledgeChatPage,
  "/cards-board": KnowledgeCardsBoardPage,
  "/cards-board/:cardId": KnowledgeCardsBoardPage,
  "/config": ConfigPage,
  "/env": EnvPage,
  "/docs": DocsPage,
};

// Route placeholder for /chat.  The persistent ChatPage host (rendered
// outside <Routes> when embedded chat is on) paints on top; this empty
// element just claims the path so the `*` catch-all redirect doesn't
// fire when the user navigates to /chat.
function ChatRouteSink() {
  return null;
}

const KNOWLEDGE_NAV_ITEMS: NavItem[] = [
  KNOWLEDGE_LIBRARY_NAV_ITEM,
  CARDS_BOARD_NAV_ITEM,
  WORKBENCH_NAV_ITEM,
];

function buildRoutes(
  builtinRoutes: Record<string, ComponentType>,
  manifests: PluginManifest[],
): Array<{
  key: string;
  path: string;
  element: ReactNode;
}> {
  const byOverride = new Map<string, PluginManifest>();
  const addons: PluginManifest[] = [];

  for (const m of manifests) {
    if (m.tab.override) {
      byOverride.set(m.tab.override, m);
    } else {
      addons.push(m);
    }
  }

  const routes: Array<{
    key: string;
    path: string;
    element: ReactNode;
  }> = [];

  for (const [path, Component] of Object.entries(builtinRoutes)) {
    const om = byOverride.get(path);
    if (om) {
      routes.push({
        key: `override:${om.name}`,
        path,
        element: <PluginPage name={om.name} />,
      });
    } else {
      routes.push({ key: `builtin:${path}`, path, element: <Component /> });
    }
  }

  for (const m of addons) {
    if (m.tab.hidden) continue;
    if (m.tab.path === "/plugins") continue;
    if (builtinRoutes[m.tab.path]) continue;
    routes.push({
      key: `plugin:${m.name}`,
      path: m.tab.path,
      element: <PluginPage name={m.name} />,
    });
  }

  for (const m of manifests) {
    if (!m.tab.hidden) continue;
    if (m.tab.path === "/plugins") continue;
    if (builtinRoutes[m.tab.path] || m.tab.override) continue;
    routes.push({
      key: `plugin:hidden:${m.name}`,
      path: m.tab.path,
      element: <PluginPage name={m.name} />,
    });
  }

  return routes;
}

export default function App() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const { manifests, loading: pluginsLoading } = usePlugins();
  const { theme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => (
    window.localStorage.getItem("hermes.sidebarCollapsed") === "true"
  ));
  const closeMobile = useCallback(() => setMobileOpen(false), []);
  const isDocsRoute = pathname === "/docs" || pathname === "/docs/";
  const normalizedPath = pathname.replace(/\/$/, "") || "/";
  const isChatRoute = normalizedPath === "/chat";
  const isKnowledgeWorkspaceRoute =
    normalizedPath === "/knowledge-chat" ||
    normalizedPath === "/knowledge-library" ||
    normalizedPath === "/capture-review" ||
    normalizedPath === "/cards-board" ||
    normalizedPath.startsWith("/cards-board/");
  const embeddedChat = isDashboardEmbeddedChatEnabled();

  // A plugin can replace the built-in /chat page via `tab.override: "/chat"`
  // in its manifest.  When one does, `buildRoutes` already swaps the route
  // element for <PluginPage /> — but we also have to suppress the
  // persistent ChatPage host below, or the plugin's page and the built-in
  // terminal would paint on top of each other.  The override is niche
  // (nothing ships overriding /chat today) but it's an advertised
  // extension point, so preserve the pre-persistence contract: when a
  // plugin owns /chat, the built-in chat UI is entirely absent.
  //
  // Waiting on `pluginsLoading` is load-bearing: manifests arrive
  // asynchronously from /api/dashboard/plugins, so on initial render
  // `chatOverriddenByPlugin` is always false.  Without the loading
  // gate, the persistent host would mount, spawn a PTY, and THEN get
  // yanked out from under the user when the plugin's manifest resolves
  // — killing the session mid-paint.  Delaying host mount by the
  // plugin-load window (typically <50ms, worst case 2s safety timeout)
  // is the cheaper trade-off.
  const chatOverriddenByPlugin = useMemo(
    () => manifests.some((m) => m.tab.override === "/chat"),
    [manifests],
  );

  const builtinRoutes = useMemo(
    () => ({
      ...BUILTIN_ROUTES_CORE,
      ...(embeddedChat ? { "/chat": ChatRouteSink } : {}),
    }),
    [embeddedChat],
  );

  const routes = useMemo(
    () => buildRoutes(builtinRoutes, manifests),
    [builtinRoutes, manifests],
  );
  const workspaceChrome = useMemo(
    () => ({ sidebarCollapsed, setSidebarCollapsed }),
    [sidebarCollapsed],
  );
  const pluginTabMeta = useMemo(
    () =>
      manifests
        .filter((m) => !m.tab.hidden)
        .map((m) => ({
          path: m.tab.override ?? m.tab.path,
          label: m.label,
        })),
    [manifests],
  );

  const layoutVariant = theme.layoutVariant ?? "standard";

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [mobileOpen]);

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setMobileOpen(false);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("hermes.sidebarCollapsed", sidebarCollapsed ? "true" : "false");
  }, [sidebarCollapsed]);

  return (
    <div
      data-layout-variant={layoutVariant}
      className="flex h-dvh max-h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground antialiased"
    >
      <SelectionSwitcher />
      <Backdrop />
      <PluginSlot name="backdrop" />

      <header
        className={cn(
          "lg:hidden fixed top-0 left-0 right-0 z-40 h-12",
          "flex items-center gap-2 px-3",
          "border-b border-border/80",
          "bg-background/92 backdrop-blur-md",
        )}
        style={{
          background: "var(--component-header-background)",
          borderImage: "var(--component-header-border-image)",
          clipPath: "var(--component-header-clip-path)",
        }}
      >
        <Button
          ghost
          size="icon"
          onClick={() => setMobileOpen(true)}
          aria-label={t.app.openNavigation}
          aria-expanded={mobileOpen}
          aria-controls="app-sidebar"
          className="text-muted-foreground hover:text-foreground"
        >
          <Menu />
        </Button>

        <Typography
          className="text-sm font-semibold leading-none tracking-normal text-foreground"
        >
          {t.app.brand}
        </Typography>
      </header>

      {mobileOpen && (
        <Button
          ghost
          aria-label={t.app.closeNavigation}
          onClick={closeMobile}
          className={cn(
            "lg:hidden fixed inset-0 z-40 p-0 block",
            "bg-black/60 backdrop-blur-sm",
          )}
        />
      )}

      <PluginSlot name="header-banner" />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pt-12 lg:pt-0">
        <div className="flex min-h-0 min-w-0 flex-1">
          <aside
            id="app-sidebar"
            aria-label={t.app.navigation}
            className={cn(
              "fixed top-0 left-0 z-50 flex h-dvh max-h-dvh w-52 min-h-0 flex-col",
              "border-r border-border/70",
              "bg-background/95 backdrop-blur-md",
              "transition-[width,transform] duration-200 ease-out",
              mobileOpen ? "translate-x-0" : "-translate-x-full",
              "lg:sticky lg:top-0 lg:translate-x-0 lg:shrink-0",
              sidebarCollapsed
                ? "lg:w-2 lg:overflow-visible lg:border-r lg:border-border/60 lg:bg-transparent lg:backdrop-blur-0"
                : "lg:w-52",
            )}
            style={{
              background: sidebarCollapsed ? "transparent" : "var(--component-sidebar-background)",
              clipPath: sidebarCollapsed ? "none" : "var(--component-sidebar-clip-path)",
              borderImage: sidebarCollapsed ? "none" : "var(--component-sidebar-border-image)",
            }}
          >
            <div
              className={cn(
                "relative flex h-14 shrink-0 items-center justify-between gap-2 px-4",
                sidebarCollapsed && "lg:h-0 lg:overflow-visible lg:border-0 lg:p-0",
              )}
            >
              <div className={cn("flex items-center gap-2", sidebarCollapsed && "lg:hidden")}>
                <PluginSlot name="header-left" />

                <Typography
                  className="text-[15px] font-semibold tracking-tight text-foreground"
                >
                  Hermes
                </Typography>
              </div>

              <Button
                ghost
                size="icon"
                onClick={() => setSidebarCollapsed((value) => !value)}
                aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
                title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
                className={cn(
                  "hidden text-muted-foreground hover:text-foreground lg:inline-flex",
                  sidebarCollapsed
                    && "lg:absolute lg:left-1 lg:top-4 lg:z-20 lg:h-8 lg:w-8 lg:opacity-0 lg:shadow-sm lg:transition lg:hover:opacity-100 lg:focus:opacity-100",
                )}
              >
                {sidebarCollapsed ? <ChevronRight /> : <PanelLeftClose />}
              </Button>

              <Button
                ghost
                size="icon"
                onClick={closeMobile}
                aria-label={t.app.closeNavigation}
                className="lg:hidden text-muted-foreground hover:text-foreground"
              >
                <X />
              </Button>
            </div>

            <nav
              className={cn(
                "min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden py-2",
                sidebarCollapsed && "lg:hidden",
              )}
              aria-label={t.app.navigation}
            >
              <ul className="flex flex-col gap-0.5 px-2.5">
                {KNOWLEDGE_NAV_ITEMS.map((item) => (
                  <SidebarNavLink
                    closeMobile={closeMobile}
                    collapsed={sidebarCollapsed}
                    item={item}
                    key={item.path}
                    t={t}
                  />
                ))}
              </ul>
            </nav>
          </aside>

          <WorkspaceChromeProvider value={workspaceChrome}>
            <PageHeaderProvider pluginTabs={pluginTabMeta}>
              <div
                className={cn(
                  "relative z-2 flex min-w-0 min-h-0 flex-1 flex-col",
                  "px-3 sm:px-6 lg:px-8",
                  isChatRoute
                    ? "pb-3 pt-1 sm:pb-4 sm:pt-2 lg:pt-4"
                    : "pt-2 sm:pt-4 lg:pt-6 pb-4 sm:pb-8",
                  (isDocsRoute || isKnowledgeWorkspaceRoute) && "min-h-0 flex-1",
                )}
              >
                <PluginSlot name="pre-main" />
                <div
                  className={cn(
                    "w-full min-w-0",
                    (isDocsRoute || isChatRoute || isKnowledgeWorkspaceRoute) &&
                      "min-h-0 flex flex-1 flex-col",
                  )}
                >
                  <Routes>
                    {routes.map(({ key, path, element }) => (
                      <Route key={key} path={path} element={element} />
                    ))}
                    <Route
                      path="*"
                      element={
                        <UnknownRouteFallback pluginsLoading={pluginsLoading} />
                      }
                    />
                  </Routes>

                  {embeddedChat &&
                    !chatOverriddenByPlugin &&
                    (pluginsLoading ? (
                      isChatRoute ? (
                        <div
                          className="flex min-h-0 min-w-0 flex-1 items-center justify-center"
                          aria-busy="true"
                          aria-live="polite"
                        >
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Spinner />
                            <span>Loading chat…</span>
                          </div>
                        </div>
                      ) : null
                    ) : (
                      <div
                        data-chat-active={isChatRoute ? "true" : "false"}
                        className={cn(
                          "min-h-0 min-w-0",
                          isChatRoute ? "flex flex-1 flex-col" : "hidden",
                        )}
                        aria-hidden={!isChatRoute}
                      >
                        <ChatPage isActive={isChatRoute} />
                      </div>
                    ))}
                </div>
                <PluginSlot name="post-main" />
              </div>
            </PageHeaderProvider>
          </WorkspaceChromeProvider>
        </div>
      </div>

      <PluginSlot name="overlay" />
    </div>
  );
}

function SidebarNavLink({ closeMobile, collapsed, item, t }: SidebarNavLinkProps) {
  const { path, label, labelKey, icon: Icon } = item;

  const navLabel = labelKey
    ? ((t.app.nav as Record<string, string>)[labelKey] ?? label)
    : label;

  return (
    <li>
      <NavLink
        to={path}
        end={path === "/sessions"}
        onClick={closeMobile}
        title={collapsed ? navLabel : undefined}
        className={({ isActive }) =>
          cn(
            "group relative flex items-center gap-2.5",
            "rounded-lg px-3 py-2",
            "text-[13.5px] tracking-normal",
            "whitespace-nowrap transition cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20",
            isActive
              ? "bg-white font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.06] dark:bg-card"
              : "text-muted-foreground hover:bg-black/[0.04] hover:text-foreground",
            collapsed && "lg:justify-center lg:px-2",
          )
        }
        style={{
          clipPath: "var(--component-tab-clip-path)",
        }}
      >
        {({ isActive }) => (
          <>
            <Icon className={cn("h-4 w-4 shrink-0", isActive ? "text-foreground" : "text-muted-foreground")} />
            <span className={cn("truncate", collapsed && "lg:hidden")}>{navLabel}</span>
          </>
        )}
      </NavLink>
    </li>
  );
}

interface NavItem {
  icon: ComponentType<{ className?: string }>;
  label: string;
  labelKey?: string;
  path: string;
}

interface SidebarNavLinkProps {
  closeMobile: () => void;
  collapsed: boolean;
  item: NavItem;
  t: Translations;
}
