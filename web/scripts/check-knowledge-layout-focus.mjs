import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const appPath = fileURLToPath(new URL("../src/App.tsx", import.meta.url));
const contextPath = fileURLToPath(new URL("../src/contexts/WorkspaceChromeContext.tsx", import.meta.url));
const libraryPath = fileURLToPath(new URL("../src/pages/KnowledgeLibraryPage.tsx", import.meta.url));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function componentBody(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert(start >= 0, `Expected ${name} component`);
  const next = source.indexOf("\nfunction ", start + marker.length);
  return source.slice(start, next >= 0 ? next : source.length);
}

const appSource = readFileSync(appPath, "utf8");
const contextSource = readFileSync(contextPath, "utf8");
const librarySource = readFileSync(libraryPath, "utf8");

assert(contextSource.includes("useWorkspaceChrome"), "Workspace chrome context should expose useWorkspaceChrome");
assert(contextSource.includes("sidebarCollapsed") && contextSource.includes("setSidebarCollapsed"), "Workspace chrome context should expose sidebar state");
assert(appSource.includes("WorkspaceChromeProvider"), "App should provide workspace chrome state");
assert(appSource.includes("sidebarCollapsed") && appSource.includes("setSidebarCollapsed"), "App should keep owning sidebar collapsed state");
assert(appSource.includes("lg:w-2") && !appSource.includes("lg:w-16"), "Collapsed app sidebar should be a thin edge, not a wide rail");

assert(librarySource.includes("useWorkspaceChrome"), "Knowledge library should use workspace chrome context");
assert(librarySource.includes("hermes.knowledgeLibrary.leftPaneCollapsed"), "Knowledge library should persist internal left pane collapsed state");
assert(librarySource.includes("leftPaneCollapsed"), "Knowledge library should track internal left pane collapsed state");
assert(librarySource.includes("readingFullscreen"), "Knowledge library should track immersive reading mode");
assert(librarySource.includes("toggleAllSidebars"), "Knowledge library should expose a unified sidebar toggle");
assert(librarySource.includes("setAiPanelMode(\"collapsed\")"), "Unified sidebar collapse should close the AI panel");
assert(librarySource.includes("收起全部侧栏") && librarySource.includes("展开侧栏"), "Knowledge library should expose sidebar toggle labels");
assert(librarySource.includes("viewMenuOpen") && librarySource.includes("视图"), "Knowledge library layout controls should be grouped under a view menu");
assert(librarySource.includes("进入沉浸阅读") && librarySource.includes("退出沉浸阅读"), "Knowledge library should expose immersive reading labels");
assert(librarySource.includes("ImmersiveReadingOverlay"), "Knowledge library should render an immersive reading overlay");
assert(!librarySource.includes("grid-cols-[44px_minmax(0,1fr)]"), "Collapsed left pane should not keep a 44px rail");
assert(!librarySource.includes("xl:grid-cols-[minmax(0,1fr)_44px]"), "Collapsed AI pane should not keep a 44px rail");

const collapsedRail = componentBody(librarySource, "CollapsedKnowledgeLeftRail");
assert(collapsedRail.includes("展开侧栏"), "Collapsed left rail should expose an expand action");
assert(!collapsedRail.includes("FolderNode") && !collapsedRail.includes("FileListItem"), "Collapsed left rail should not render the full folder tree or file list");
assert(!collapsedRail.includes("activeLabel") && !collapsedRail.includes("count"), "Collapsed left rail should not render label/count content");

const collapsedAiRail = componentBody(librarySource, "CollapsedAIPanelRail");
assert(collapsedAiRail.includes("展开 AI 面板"), "Collapsed AI rail should expose an expand action");
assert(!collapsedAiRail.includes("writing-mode"), "Collapsed AI rail should not render a vertical label");

const articleAiPanel = componentBody(librarySource, "ArticleAIPanel");
assert(articleAiPanel.includes("xl:flex"), "Expanded AI panel should be visible at xl width");
assert(!articleAiPanel.includes("2xl:flex"), "Expanded AI panel should not require 2xl width");

const immersive = componentBody(librarySource, "ImmersiveReadingOverlay");
assert(immersive.includes("fixed inset-0"), "Immersive reading should be a page-level overlay");
assert(immersive.includes("退出沉浸阅读"), "Immersive reading should include an exit action");
assert(immersive.includes("<Markdown"), "Immersive reading should render the article body");
assert(!immersive.includes("ArticleAIPanel") && !immersive.includes("EditableCaptureWorkbench"), "Immersive reading should not render side panels or editor workbench");
assert(!immersive.includes("新建"), "Immersive reading should not include the top new button");

console.log("knowledge layout focus contract: ok");
