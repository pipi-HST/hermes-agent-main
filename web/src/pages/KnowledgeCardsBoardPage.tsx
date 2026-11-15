import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  BookOpenText,
  BookMarked,
  Check,
  CircleDot,
  Copy,
  ExternalLink,
  FileText,
  Layers3,
  Loader2,
  Network,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  Workflow,
} from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  api,
  type KnowledgeCard,
  type KnowledgeCardKind,
  type KnowledgeGraphEdge,
  type KnowledgeGraphNode,
  type KnowledgeGraphNodeKind,
  type KnowledgeGraphRelationType,
  type KnowledgeSource,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const KIND_META: Record<
  KnowledgeCardKind,
  {
    label: string;
    description: string;
    icon: React.ComponentType<{ className?: string }>;
    tone: string;
    active: string;
    rail: string;
  }
> = {
  viewpoint: {
    label: "洞察 / 金句",
    description: "有启发的行业判断、核心结论与思考火花",
    icon: Sparkles,
    tone: "border-[#bdd7d2] bg-[#edf5f2] text-[#255f54]",
    active: "border-[#8fbbb2] bg-[#e1eeea] text-[#173f38]",
    rail: "bg-[#5f998e]",
  },
  method: {
    label: "方法 / 框架",
    description: "问题拆解套路、产品框架与面试方法论",
    icon: Workflow,
    tone: "border-[#c9d9bd] bg-[#f0f5eb] text-[#496d35]",
    active: "border-[#adc49a] bg-[#e7efdf] text-[#344f25]",
    rail: "bg-[#7fa66a]",
  },
  fact: {
    label: "新知 / 概念",
    description: "搞懂的技术概念、行业黑话与基础原理",
    icon: BookMarked,
    tone: "border-[#e1d3aa] bg-[#f7f2e6] text-[#725c24]",
    active: "border-[#cbb879] bg-[#f1e8cf] text-[#554419]",
    rail: "bg-[#b99d4a]",
  },
  risk: {
    label: "避坑 / 边界",
    description: "实践误区、适用边界与踩坑反思",
    icon: ShieldAlert,
    tone: "border-[#e1c1bb] bg-[#f7eeeb] text-[#8a3f32]",
    active: "border-[#d4a59c] bg-[#f1e2de] text-[#653026]",
    rail: "bg-[#c87b6d]",
  },
};

const KIND_ORDER: KnowledgeCardKind[] = ["viewpoint", "method", "fact", "risk"];

const RELATION_LABELS: Record<KnowledgeGraphRelationType, string> = {
  semantic_similarity: "相似笔记",
  card_uses_capture: "卡片引用",
  card_links_card: "卡片互链",
  theme_groups_capture: "主题聚合",
};

const NODE_KIND_LABELS: Record<KnowledgeGraphNodeKind, string> = {
  capture: "笔记",
  garden_card: "卡片",
  theme_candidate: "主题",
};

type GraphNodePosition = {
  x: number;
  y: number;
  isFocus: boolean;
};

export default function KnowledgeCardsBoardPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { cardId: routeCardId } = useParams();
  const isDetailRoute = Boolean(routeCardId);
  const currentView = new URLSearchParams(location.search).get("view") === "graph" ? "graph" : "cards";
  const [cards, setCards] = useState<KnowledgeCard[]>([]);
  const [selectedId, setSelectedId] = useState(routeCardId ?? "");
  const [detail, setDetail] = useState<KnowledgeCard | null>(null);
  const [activeKind, setActiveKind] = useState<KnowledgeCardKind | "all">("all");
  const [activeTheme, setActiveTheme] = useState("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadCards = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await api.getKnowledgeCards(200);
      setCards(payload.cards);
      setSelectedId((current) => {
        if (routeCardId) return routeCardId;
        if (current && payload.cards.some((card) => card.id === current)) return current;
        return payload.cards[0]?.id ?? "";
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [routeCardId]);

  const loadDetail = useCallback(async (cardId: string) => {
    if (!cardId) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    setError("");
    try {
      const payload = await api.getKnowledgeCard(cardId);
      setDetail(payload.card);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCards();
  }, [loadCards]);

  useEffect(() => {
    if (routeCardId && routeCardId !== selectedId) {
      setSelectedId(routeCardId);
    }
  }, [routeCardId, selectedId]);

  useEffect(() => {
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  const counts = useMemo(() => {
    return KIND_ORDER.reduce<Record<KnowledgeCardKind, number>>(
      (acc, kind) => {
        acc[kind] = cards.filter((card) => card.kind === kind).length;
        return acc;
      },
      { viewpoint: 0, method: 0, fact: 0, risk: 0 },
    );
  }, [cards]);

  const themes = useMemo(() => {
    const values = new Map<string, number>();
    for (const card of cards) {
      const theme = (card.source_theme || "").trim();
      if (!theme) continue;
      values.set(theme, (values.get(theme) ?? 0) + 1);
    }
    return [...values.entries()].sort((a, b) => b[1] - a[1]);
  }, [cards]);

  const filteredCards = useMemo(() => {
    const text = query.trim().toLowerCase();
    return cards.filter((card) => {
      if (activeKind !== "all" && card.kind !== activeKind) return false;
      if (activeTheme !== "all" && card.source_theme !== activeTheme) return false;
      if (!text) return true;
      return [
        card.title,
        card.summary,
        card.markdown,
        card.source_theme,
        card.sources.map((source) => source.title).join(" "),
        card.key_materials?.map(displayValue).join(" "),
      ]
        .join("\n")
        .toLowerCase()
        .includes(text);
    });
  }, [activeKind, activeTheme, cards, query]);

  useEffect(() => {
    if (isDetailRoute) return;
    if (!filteredCards.length) {
      setSelectedId("");
      return;
    }
    if (!selectedId || !filteredCards.some((card) => card.id === selectedId)) {
      setSelectedId(filteredCards[0].id);
    }
  }, [filteredCards, isDetailRoute, selectedId]);

  const selectedCard = detail && detail.id === selectedId
    ? detail
    : cards.find((card) => card.id === selectedId) ?? null;

  const deleteCard = useCallback(async (card: KnowledgeCard) => {
    const title = card.title || "这张知识卡片";
    const confirmed = window.confirm(`归档知识卡片《${title}》？\n\n归档后将从卡片库隐藏，结构化记录会保留。`);
    if (!confirmed) return;
    setDeletingId(card.id);
    setError("");
    setNotice("");
    try {
      await api.deleteKnowledgeCard(card.id);
      const remaining = filteredCards.filter((item) => item.id !== card.id);
      setCards((current) => current.filter((item) => item.id !== card.id));
      if (selectedId === card.id) {
        setDetail(null);
        setSelectedId(remaining[0]?.id ?? "");
      }
      if (routeCardId === card.id) {
        navigate("/cards-board", { replace: true });
      }
      setNotice(`已归档知识卡片：《${title}》。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId("");
    }
  }, [filteredCards, navigate, routeCardId, selectedId]);

  const switchView = useCallback((view: "cards" | "graph") => {
    navigate(view === "graph" ? "/cards-board?view=graph" : "/cards-board", { replace: true });
  }, [navigate]);

  if (isDetailRoute) {
    return (
      <CardReadingPage
        card={selectedCard}
        deleting={selectedCard ? deletingId === selectedCard.id : false}
        error={error}
        loading={detailLoading || (loading && !selectedCard)}
        notice={notice}
        onDelete={selectedCard ? () => void deleteCard(selectedCard) : undefined}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 text-foreground">
      <header className="shrink-0 overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex flex-col gap-4 px-5 py-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium text-primary">
              <Layers3 className="h-3.5 w-3.5" />
              Knowledge Cards · 个人认知资产
            </div>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal text-foreground md:text-3xl">
              个人知识卡片库
            </h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
              从资料伴读中提炼出的新知概念、方法框架与核心洞察——拒绝“收藏=学会”，只沉淀内化后的个人认知。
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
            <div className="col-span-2 inline-flex rounded-md border border-border bg-background/70 p-1 sm:col-span-1">
              <button
                type="button"
                onClick={() => switchView("cards")}
                className={cn(
                  "rounded px-3 py-1.5 text-sm transition",
                  currentView === "cards" ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                知识卡片
              </button>
              <button
                type="button"
                onClick={() => switchView("graph")}
                className={cn(
                  "rounded px-3 py-1.5 text-sm transition",
                  currentView === "graph" ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                知识图谱
              </button>
            </div>
            <Metric label="总卡片" value={cards.length} />
            <Metric label="来源材料" value={cards.reduce((sum, card) => sum + card.sources.length, 0)} />
            <button
              type="button"
              onClick={() => void loadCards()}
              className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-background/70 px-3 py-2 text-sm text-muted-foreground transition hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
            >
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
              刷新
            </button>
            <Link
              to="/knowledge-chat"
              className="inline-flex items-center justify-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground transition hover:border-primary/55 hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
            >
              🧭 去专题输出
            </Link>
          </div>
        </div>
      </header>

      {error && (
        <div className="flex shrink-0 items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4" />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="flex shrink-0 items-start gap-2 rounded-md border border-success/25 bg-success/10 px-3 py-2 text-sm text-success">
          <Check className="mt-0.5 h-4 w-4" />
          <span>{notice}</span>
        </div>
      )}

      {currentView === "graph" ? (
        <KnowledgeGraphPanel focusCardId={selectedId} />
      ) : (
      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[250px_minmax(0,1fr)_380px]">
        <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background">
          <div className="border-b border-border/80 p-3">
            <label className="flex items-center gap-2 rounded-md border border-border bg-background/70 px-2.5 py-2">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索卡片或来源"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </label>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
            <FilterSection title="卡片类型">
              <FilterButton
                active={activeKind === "all"}
                count={cards.length}
                label="全部卡片"
                onClick={() => setActiveKind("all")}
              />
              {KIND_ORDER.map((kind) => {
                const meta = KIND_META[kind];
                const Icon = meta.icon;
                return (
                  <FilterButton
                    key={kind}
                    active={activeKind === kind}
                    count={counts[kind]}
                    description={meta.description}
                    icon={<Icon className="h-4 w-4" />}
                    label={meta.label}
                    onClick={() => setActiveKind(kind)}
                  />
                );
              })}
            </FilterSection>

            <FilterSection title="所属专题">
              <FilterButton
                active={activeTheme === "all"}
                count={cards.length}
                label="全部专题"
                onClick={() => setActiveTheme("all")}
              />
              {themes.length ? (
                themes.map(([theme, count]) => (
                  <FilterButton
                    key={theme}
                    active={activeTheme === theme}
                    count={count}
                    label={themeTitle(theme)}
                    onClick={() => setActiveTheme(theme)}
                  />
                ))
              ) : (
        <p className="rounded-md border border-dashed border-border bg-background/45 px-3 py-3 text-xs leading-5 text-muted-foreground">
                  暂无专题归属。随专题输出沉淀下来的卡片会显示在这里。
                </p>
              )}
            </FilterSection>
          </div>
        </aside>

        <main className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background">
          <div className="flex shrink-0 items-center justify-between border-b border-border/80 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold tracking-normal text-foreground">卡片库</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                当前显示 {filteredCards.length} / {cards.length} 张
              </p>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {loading ? (
              <LoadingBlock text="读取知识卡片..." />
            ) : cards.length === 0 ? (
              <EmptyState />
            ) : filteredCards.length ? (
              <div className="grid gap-4 2xl:grid-cols-2">
                {filteredCards.map((card) => (
                  <KnowledgeCardTile
                    key={card.id}
                    card={card}
                    selected={selectedId === card.id}
                    onSelect={() => setSelectedId(card.id)}
                  />
                ))}
              </div>
            ) : (
              <EmptyBlock text="没有找到符合条件的知识卡片。" />
            )}
          </div>
        </main>

        <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background">
          {detailLoading && selectedId ? (
            <LoadingBlock text="读取卡片详情..." />
          ) : selectedCard ? (
            <CardInspector
              card={selectedCard}
              deleting={deletingId === selectedCard.id}
              onDelete={() => void deleteCard(selectedCard)}
            />
          ) : (
            <EmptyBlock text="请选择一张卡片查看详情。" />
          )}
        </aside>
      </div>
      )}
    </div>
  );
}

function KnowledgeGraphPanel({ focusCardId }: { focusCardId: string }) {
  const navigate = useNavigate();
  const [graph, setGraph] = useState<{ nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[]; meta?: { focus_kind?: string; focus_id?: string } } | null>(null);
  const [selectedNodeKey, setSelectedNodeKey] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadGraph = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.getKnowledgeGraph(
        focusCardId
          ? { focus_kind: "garden_card", focus_id: focusCardId, depth: 1, limit: 80 }
          : { depth: 1, limit: 80 },
      );
      setGraph(data);
      const focusKind = data.meta.focus_kind as KnowledgeGraphNodeKind | undefined;
      const focusId = data.meta.focus_id;
      const fallback = data.nodes[0];
      setSelectedNodeKey(
        focusKind && focusId
          ? graphNodeKey(focusKind, focusId)
          : fallback
            ? graphNodeKey(fallback.kind, fallback.id)
            : "",
      );
      setSelectedEdgeId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [focusCardId]);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  const nodeByKey = useMemo(() => {
    return new Map((graph?.nodes ?? []).map((node) => [graphNodeKey(node.kind, node.id), node]));
  }, [graph]);

  const filteredEdges = useMemo(() => {
    return graph?.edges ?? [];
  }, [graph]);

  const focusNodeKey = useMemo(() => {
    const focusKind = graph?.meta?.focus_kind as KnowledgeGraphNodeKind | undefined;
    const focusId = graph?.meta?.focus_id;
    if (focusKind && focusId) return graphNodeKey(focusKind, focusId);
    return graph?.nodes[0] ? graphNodeKey(graph.nodes[0].kind, graph.nodes[0].id) : "";
  }, [graph]);

  const selectedNode = selectedNodeKey ? nodeByKey.get(selectedNodeKey) ?? null : null;
  const selectedEdges = useMemo(() => {
    if (!selectedNode) return filteredEdges;
    const key = graphNodeKey(selectedNode.kind, selectedNode.id);
    return filteredEdges.filter((edge) =>
      graphNodeKey(edge.source_kind, edge.source_id) === key ||
      graphNodeKey(edge.target_kind, edge.target_id) === key,
    );
  }, [filteredEdges, selectedNode]);

  const selectedEdge = useMemo(() => {
    return filteredEdges.find((edge) => edge.id === selectedEdgeId) ?? selectedEdges[0] ?? filteredEdges[0] ?? null;
  }, [filteredEdges, selectedEdgeId, selectedEdges]);

  const visibleNodeKeys = useMemo(() => {
    const keys = new Set<string>();
    if (focusNodeKey) keys.add(focusNodeKey);
    if (selectedNodeKey) keys.add(selectedNodeKey);
    for (const edge of filteredEdges) {
      keys.add(graphNodeKey(edge.source_kind, edge.source_id));
      keys.add(graphNodeKey(edge.target_kind, edge.target_id));
    }
    return keys;
  }, [filteredEdges, focusNodeKey, selectedNodeKey]);

  const visibleNodes = useMemo(() => {
    return (graph?.nodes ?? []).filter((node) => visibleNodeKeys.has(graphNodeKey(node.kind, node.id)));
  }, [graph, visibleNodeKeys]);

  const refreshGraph = async () => {
    setRefreshing(true);
    setError("");
    setNotice("");
    try {
      const result = await api.refreshKnowledgeGraph();
      setNotice(`已刷新 ${result.edge_count} 条关系，覆盖 ${result.node_count} 个节点。`);
      await loadGraph();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  const openNode = (node: KnowledgeGraphNode) => {
    if (!node.open_url) return;
    if (node.open_url.startsWith("/")) {
      navigate(node.open_url);
      return;
    }
    window.open(node.open_url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
      <main className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex shrink-0 flex-col gap-3 border-b border-border/80 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold tracking-normal text-foreground">
              <Network className="h-4 w-4 text-primary/80" />
              知识图谱
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              仅展示已入库笔记、知识卡片和可解释主题关系。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded-md border border-border bg-background/70 px-2.5 py-1.5">
              {graph?.nodes.length ?? 0} 节点
            </span>
            <span className="rounded-md border border-border bg-background/70 px-2.5 py-1.5">
              {graph?.edges.length ?? 0} 关系
            </span>
            <button
              type="button"
              onClick={() => void refreshGraph()}
              className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-background/70 px-3 py-2 text-sm text-muted-foreground transition hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
            >
              <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
              刷新图谱
            </button>
          </div>
        </div>

        {error ? (
          <div className="m-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4" />
            <span>{error}</span>
          </div>
        ) : null}
        {notice ? (
          <div className="m-4 flex items-start gap-2 rounded-md border border-success/25 bg-success/10 px-3 py-2 text-sm text-success">
            <Check className="mt-0.5 h-4 w-4" />
            <span>{notice}</span>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {loading ? (
            <div>
              <LoadingBlock text="读取知识图谱..." />
            </div>
          ) : graph && graph.nodes.length ? (
            <>
              <section className="min-h-[520px] rounded-lg border border-border bg-background/60 p-4">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">一跳关系图</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      中心节点与一跳关联，关系类型直接标在连线上。
                    </p>
                  </div>
                </div>
                <GraphCanvas
                  edges={filteredEdges}
                  focusKey={focusNodeKey}
                  nodes={visibleNodes}
                  selectedEdgeId={selectedEdge?.id ?? ""}
                  selectedNodeKey={selectedNodeKey}
                  onSelectEdge={setSelectedEdgeId}
                  onSelectNode={setSelectedNodeKey}
                />
              </section>

              <section className="rounded-lg border border-border bg-background/60 p-4">
                <h3 className="text-sm font-semibold text-foreground">关系证据</h3>
                {selectedEdge ? (
                  <div className="mt-3 rounded-lg border border-primary/25 bg-primary/10 px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-primary">{edgeLabel(selectedEdge)}</span>
                      <span className="text-xs text-muted-foreground">score {formatScore(selectedEdge.score)}</span>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">{graphEvidenceText(selectedEdge)}</p>
                  </div>
                ) : null}
                <div className="mt-3 space-y-3">
                  {selectedEdges.length ? (
                    selectedEdges.map((edge) => (
                      <GraphEdgeRow
                        key={edge.id}
                        edge={edge}
                        nodeByKey={nodeByKey}
                        selected={selectedEdge?.id === edge.id}
                        onSelectEdge={setSelectedEdgeId}
                        onSelectNode={setSelectedNodeKey}
                      />
                    ))
                  ) : (
                    <EmptyInline text="当前筛选下没有可展示的关系。" />
                  )}
                </div>
              </section>
            </>
          ) : (
            <div>
              <GraphEmptyState />
            </div>
          )}
        </div>
      </main>

      <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background">
        {selectedNode ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mb-3 inline-flex rounded-md border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground">
              {NODE_KIND_LABELS[selectedNode.kind]}
            </div>
            <h2 className="text-xl font-semibold leading-7 text-foreground">{selectedNode.title}</h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">{selectedNode.summary || "暂无摘要"}</p>
            {selectedNode.file_path ? (
              <PathLine label="文件" value={selectedNode.file_path} />
            ) : null}
            <div className="mt-5 grid gap-2">
              {selectedNode.open_url ? (
                <button
                  type="button"
                  onClick={() => openNode(selectedNode)}
                  className="inline-flex items-center justify-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground transition hover:border-primary/55 hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
                >
                  <ExternalLink className="h-4 w-4" />
                  打开 Hermes
                </button>
              ) : null}
              {selectedNode.file_url ? (
                <button
                  type="button"
                  onClick={() => { window.location.href = selectedNode.file_url; }}
                  className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-background/70 px-3 py-2 text-sm text-muted-foreground transition hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
                >
                  <ExternalLink className="h-4 w-4" />
                  打开文件
                </button>
              ) : null}
            </div>
            <section className="mt-5 rounded-lg border border-border bg-background p-3">
              <h3 className="text-sm font-semibold text-foreground">相关关系</h3>
              <div className="mt-3 space-y-2">
                {selectedEdges.length ? selectedEdges.map((edge) => (
                  <button
                    key={`${selectedNode.id}-${edge.id}`}
                    type="button"
                    onClick={() => setSelectedEdgeId(edge.id)}
                    className={cn(
                      "w-full rounded-md border px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20",
                      selectedEdge?.id === edge.id ? "border-primary/35 bg-primary/10" : "border-border bg-background/60 hover:border-primary/30",
                    )}
                  >
                    <div className="text-xs font-medium text-foreground">{RELATION_LABELS[edge.relation_type]}</div>
                    <div className="mt-1 text-xs leading-5 text-muted-foreground">{graphEvidenceText(edge)}</div>
                  </button>
                )) : <EmptyInline text="当前节点暂无关系。" />}
              </div>
            </section>
          </div>
        ) : (
          <EmptyBlock text="请选择一个图谱节点查看详情。" />
        )}
      </aside>
    </div>
  );
}

function GraphCanvas({
  edges,
  focusKey,
  nodes,
  selectedEdgeId,
  selectedNodeKey,
  onSelectEdge,
  onSelectNode,
}: {
  edges: KnowledgeGraphEdge[];
  focusKey: string;
  nodes: KnowledgeGraphNode[];
  selectedEdgeId: string;
  selectedNodeKey: string;
  onSelectEdge: (edgeId: string) => void;
  onSelectNode: (nodeKey: string) => void;
}) {
  const positions = useMemo(() => layoutGraphNodes(nodes, edges, focusKey), [edges, focusKey, nodes]);
  const visibleEdges = edges.filter((edge) =>
    positions.has(graphNodeKey(edge.source_kind, edge.source_id)) &&
    positions.has(graphNodeKey(edge.target_kind, edge.target_id)),
  );

  return (
    <div className="relative min-h-[540px] overflow-hidden rounded-lg border border-border bg-[radial-gradient(circle_at_center,rgba(95,153,142,0.08),transparent_58%)]">
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 1000 620"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {visibleEdges.map((edge) => {
          const source = positions.get(graphNodeKey(edge.source_kind, edge.source_id));
          const target = positions.get(graphNodeKey(edge.target_kind, edge.target_id));
          if (!source || !target) return null;
          const selected = selectedEdgeId === edge.id;
          return (
            <line
              key={edge.id}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              className={cn("transition", selected ? "stroke-primary" : "stroke-border")}
              strokeWidth={selected ? 4 : 2}
              strokeLinecap="round"
            />
          );
        })}
      </svg>

      {visibleEdges.map((edge) => {
        const source = positions.get(graphNodeKey(edge.source_kind, edge.source_id));
        const target = positions.get(graphNodeKey(edge.target_kind, edge.target_id));
        if (!source || !target) return null;
        const selected = selectedEdgeId === edge.id;
        const labelPoint = edgeLabelPoint(source, target);
        return (
          <button
            key={`${edge.id}-label`}
            type="button"
            onClick={() => onSelectEdge(edge.id)}
            style={{ left: `${labelPoint.x / 10}%`, top: `${labelPoint.y / 6.2}%` }}
            className={cn(
              "absolute z-20 -translate-x-1/2 -translate-y-1/2 rounded-md border px-2.5 py-1 text-xs font-medium shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20",
              selected
                ? "border-primary/35 bg-primary/15 text-primary"
                : "border-border bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground",
            )}
          >
            {edgeLabel(edge)}
          </button>
        );
      })}

      {nodes.map((node) => {
        const key = graphNodeKey(node.kind, node.id);
        const position = positions.get(key);
        if (!position) return null;
        const selected = selectedNodeKey === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelectNode(key)}
            style={{ left: `${position.x / 10}%`, top: `${position.y / 6.2}%` }}
            className={cn(
              "absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-lg border p-3 text-left shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20",
              position.isFocus ? "w-56" : "w-44",
              selected || position.isFocus
                ? "border-primary/45 bg-background"
                : "border-border bg-background/90 hover:border-primary/30",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className={cn("rounded border px-2 py-0.5 text-xs", graphNodeTone(node.kind))}>
                {position.isFocus ? "中心" : NODE_KIND_LABELS[node.kind]}
              </span>
              <span className="text-xs text-muted-foreground">{relationCountForNode(edges, node)} 条</span>
            </div>
            <div className={cn("mt-2 line-clamp-2 font-semibold leading-5 text-foreground", position.isFocus ? "text-sm" : "text-xs")}>
              {node.title}
            </div>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
              {node.summary || node.file_path || "暂无摘要"}
            </p>
          </button>
        );
      })}

      {!visibleEdges.length && nodes.length ? (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md border border-dashed border-border bg-background/85 px-3 py-2 text-xs text-muted-foreground">
          暂无一跳关系
        </div>
      ) : null}
    </div>
  );
}

function GraphEdgeRow({
  edge,
  nodeByKey,
  selected,
  onSelectEdge,
  onSelectNode,
}: {
  edge: KnowledgeGraphEdge;
  nodeByKey: Map<string, KnowledgeGraphNode>;
  selected: boolean;
  onSelectEdge: (edgeId: string) => void;
  onSelectNode: (key: string) => void;
}) {
  const sourceKey = graphNodeKey(edge.source_kind, edge.source_id);
  const targetKey = graphNodeKey(edge.target_kind, edge.target_id);
  const source = nodeByKey.get(sourceKey);
  const target = nodeByKey.get(targetKey);
  return (
    <div className={cn("rounded-lg border px-3 py-3", selected ? "border-primary/35 bg-primary/10" : "border-border bg-background")}>
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={() => onSelectEdge(edge.id)} className="text-left text-xs font-medium text-primary hover:text-primary/80">
          {edgeLabel(edge)}
        </button>
        <span className="text-xs text-muted-foreground">score {formatScore(edge.score)}</span>
      </div>
      <div className="mt-2 flex items-center gap-2 text-sm text-foreground">
        <button type="button" onClick={() => onSelectNode(sourceKey)} className="min-w-0 truncate text-left hover:text-primary">
          {source?.title || edge.source_id}
        </button>
        <span className="text-muted-foreground">→</span>
        <button type="button" onClick={() => onSelectNode(targetKey)} className="min-w-0 truncate text-left hover:text-primary">
          {target?.title || edge.target_id}
        </button>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{graphEvidenceText(edge)}</p>
    </div>
  );
}

function graphNodeKey(kind: KnowledgeGraphNodeKind, id: string): string {
  return `${kind}:${id}`;
}

function layoutGraphNodes(
  nodes: KnowledgeGraphNode[],
  edges: KnowledgeGraphEdge[],
  focusKey: string,
): Map<string, GraphNodePosition> {
  const positions = new Map<string, GraphNodePosition>();
  if (!nodes.length) return positions;
  const nodeByKey = new Map(nodes.map((node) => [graphNodeKey(node.kind, node.id), node]));
  const centerKey = focusKey && nodeByKey.has(focusKey) ? focusKey : graphNodeKey(nodes[0].kind, nodes[0].id);
  positions.set(centerKey, { x: 500, y: 310, isFocus: true });

  const orderedKeys = nodes
    .map((node) => graphNodeKey(node.kind, node.id))
    .filter((key) => key !== centerKey)
    .sort((left, right) => {
      const leftEdgeIndex = edgeIndexForNode(edges, left, centerKey);
      const rightEdgeIndex = edgeIndexForNode(edges, right, centerKey);
      if (leftEdgeIndex !== rightEdgeIndex) return leftEdgeIndex - rightEdgeIndex;
      return (nodeByKey.get(left)?.title || "").localeCompare(nodeByKey.get(right)?.title || "", "zh-Hans-CN");
    });

  const count = orderedKeys.length;
  orderedKeys.forEach((key, index) => {
    if (count === 1) {
      positions.set(key, { x: 760, y: 310, isFocus: false });
      return;
    }
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / count;
    positions.set(key, {
      x: 500 + Math.cos(angle) * 350,
      y: 310 + Math.sin(angle) * 210,
      isFocus: false,
    });
  });
  return positions;
}

function edgeIndexForNode(edges: KnowledgeGraphEdge[], nodeKey: string, focusKey: string): number {
  const index = edges.findIndex((edge) => {
    const sourceKey = graphNodeKey(edge.source_kind, edge.source_id);
    const targetKey = graphNodeKey(edge.target_kind, edge.target_id);
    return (
      (sourceKey === focusKey && targetKey === nodeKey) ||
      (targetKey === focusKey && sourceKey === nodeKey)
    );
  });
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function edgeLabelPoint(source: GraphNodePosition, target: GraphNodePosition): { x: number; y: number } {
  const midX = (source.x + target.x) / 2;
  const midY = (source.y + target.y) / 2;
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy) || 1;
  const offsetDirection = dy >= 0 ? -1 : 1;
  return {
    x: midX + (-dy / length) * 48 * offsetDirection,
    y: midY + (dx / length) * 48 * offsetDirection,
  };
}

function graphNodeTone(kind: KnowledgeGraphNodeKind): string {
  if (kind === "garden_card") return "border-[#8fbbb2] bg-[#e1eeea] text-[#173f38]";
  if (kind === "theme_candidate") return "border-[#e1d3aa] bg-[#f7f2e6] text-[#725c24]";
  return "border-border bg-background text-muted-foreground";
}

function edgeLabel(edge: KnowledgeGraphEdge): string {
  if (edge.relation_type === "semantic_similarity") return `相似 ${formatScore(edge.score)}`;
  return RELATION_LABELS[edge.relation_type];
}

function relationCountForNode(edges: KnowledgeGraphEdge[], node: KnowledgeGraphNode): number {
  const key = graphNodeKey(node.kind, node.id);
  return edges.filter((edge) =>
    graphNodeKey(edge.source_kind, edge.source_id) === key ||
    graphNodeKey(edge.target_kind, edge.target_id) === key,
  ).length;
}

function formatScore(score: number): string {
  return Number.isFinite(score) ? score.toFixed(2) : "-";
}

function graphEvidenceText(edge: KnowledgeGraphEdge): string {
  const evidence = edge.evidence || {};
  const matches = Array.isArray(evidence.section_matches) ? evidence.section_matches.slice(0, 2).join("；") : "";
  const reasons = Array.isArray(evidence.reasons) ? evidence.reasons.slice(0, 2).join("；") : "";
  const title = typeof evidence.title === "string" ? evidence.title : "";
  const question = typeof evidence.question === "string" ? evidence.question : "";
  return matches || reasons || title || question || "该关系由现有知识库结构确定生成。";
}

function KnowledgeCardTile({
  card,
  onSelect,
  selected,
}: {
  card: KnowledgeCard;
  onSelect: () => void;
  selected: boolean;
}) {
  const meta = KIND_META[card.kind];
  const Icon = meta.icon;
  const claims = normalizedArguments(card.core_arguments).slice(0, 2);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group relative flex min-h-[230px] flex-col overflow-hidden rounded-lg border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20",
        selected
          ? "border-primary/45 bg-primary/10"
          : "border-border bg-background hover:border-primary/30 hover:bg-background/95",
      )}
    >
      <div className={cn("absolute left-0 top-0 h-full w-1", meta.rail)} />
      <div className="flex items-start justify-between gap-3 pl-1">
        <div className="min-w-0">
          <div className={cn("mb-2 inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs", meta.tone)}>
            <Icon className="h-3.5 w-3.5" />
            {meta.label}
          </div>
          <h2 className="line-clamp-3 text-base font-semibold leading-6 text-foreground">
            {card.title}
          </h2>
        </div>
      </div>

      <p className="mt-3 line-clamp-4 pl-1 text-sm leading-6 text-muted-foreground">
        {card.summary || "暂无摘要"}
      </p>

      {claims.length ? (
        <div className="mt-3 space-y-2 pl-1">
          {claims.map((claim, index) => (
            <div key={`${card.id}-claim-${index}`} className="flex gap-2 text-sm leading-5 text-foreground/90">
              <CircleDot className="mt-1 h-3 w-3 shrink-0 text-primary/80" />
              <span className="line-clamp-2">{claim}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-auto pl-1 pt-4">
        <SourcePreview sources={card.sources} />
        {card.citation_count ? (
          <div className="mt-2 inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
            🔥 被引用 {card.citation_count} 次
          </div>
        ) : null}
      </div>
    </button>
  );
}

function CardInspector({
  card,
  deleting,
  onDelete,
}: {
  card: KnowledgeCard;
  deleting: boolean;
  onDelete: () => void;
}) {
  const meta = KIND_META[card.kind];
  const Icon = meta.icon;

  return (
    <>
      <div className="shrink-0 border-b border-border/80 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className={cn("inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs", meta.active)}>
            <Icon className="h-3.5 w-3.5" />
            {meta.label}
          </span>
          <CardActions card={card} deleting={deleting} onDelete={onDelete} />
        </div>
        <h2 className="text-xl font-semibold leading-7 tracking-normal text-foreground">{card.title}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {card.summary || "暂无摘要"}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <section className="rounded-lg border border-border bg-background p-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold tracking-normal text-foreground">
            <BookOpenText className="h-4 w-4 text-primary/80" />
            快速操作
          </h3>
          <Link
            to={cardTopicOutputPath(card)}
            className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-primary bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
          >
            🚀 带着此卡片去「专题输出」
          </Link>
          <Link
            to={`/cards-board/${encodeURIComponent(card.id)}`}
            className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground transition hover:border-primary/55 hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
          >
            <BookOpenText className="h-4 w-4" />
            打开完整详情
          </Link>
        </section>

        {(card.file_path || card.source_theme) ? (
        <section className="mt-4 rounded-lg border border-border bg-background p-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold tracking-normal text-foreground">
            <FileText className="h-4 w-4 text-primary/80" />
            兼容信息
          </h3>
          <div className="mt-2 space-y-2 text-sm leading-6 text-muted-foreground">
            <PathLine label="存储位置" value={card.file_path} />
            <PathLine label="所属专题" value={card.source_theme} />
          </div>
        </section>
        ) : null}

        <section className="mt-4 rounded-lg border border-border bg-background p-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold tracking-normal text-foreground">
            <BookMarked className="h-4 w-4 text-primary/80" />
            来源材料
          </h3>
          {card.sources.length ? (
            <div className="mt-3 space-y-2">
              {card.sources.map((source) => (
                <SourceRow key={`${card.id}-${source.id}`} source={source} />
              ))}
            </div>
          ) : (
            <EmptyInline text="暂无来源材料。后续生成卡片时需要绑定 captures，方便追溯。" />
          )}
        </section>
      </div>
    </>
  );
}

function CardReadingPage({
  card,
  deleting,
  error,
  loading,
  notice,
  onDelete,
}: {
  card: KnowledgeCard | null;
  deleting: boolean;
  error: string;
  loading: boolean;
  notice: string;
  onDelete?: () => void;
}) {
  const kind = card?.kind ?? "viewpoint";
  const meta = KIND_META[kind];
  const Icon = meta.icon;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 text-foreground">
      <div className="shrink-0">
        <Link
          to="/cards-board"
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/70 px-3 py-2 text-sm text-muted-foreground transition hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
        >
          <ArrowLeft className="h-4 w-4" />
          返回卡片库
        </Link>
      </div>

      {error && (
        <div className="flex shrink-0 items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4" />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="flex shrink-0 items-start gap-2 rounded-md border border-success/25 bg-success/10 px-3 py-2 text-sm text-success">
          <Check className="mt-0.5 h-4 w-4" />
          <span>{notice}</span>
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-background">
        {loading ? (
          <LoadingBlock text="读取卡片详情..." />
        ) : card ? (
          <article className="mx-auto flex w-full max-w-[860px] flex-col gap-8 px-5 py-8 sm:px-8 lg:py-10">
            <header className="border-b border-border/80 pb-7">
              <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <span className={cn("inline-flex w-fit items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs", meta.active)}>
                  <Icon className="h-3.5 w-3.5" />
                  {meta.label}
                </span>
                {onDelete ? (
                  <CardActions card={card} deleting={deleting} onDelete={onDelete} />
                ) : null}
              </div>
              <h1 className="max-w-[780px] text-3xl font-semibold leading-tight tracking-normal text-foreground md:text-4xl">
                {card.title}
              </h1>
              <p className="mt-5 max-w-[760px] text-lg leading-8 text-foreground/85">
                {card.payload?.claim || card.summary || "暂无核心判断"}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <SourceChip title={`可信度：${confidenceLabel(card.payload?.confidence)}`} />
                <SourceChip title={`${card.sources.length} 篇来源`} muted={card.sources.length === 0} />
                {card.schema_version ? <SourceChip title={card.schema_version} muted /> : null}
              </div>
              <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center">
                <Link
                  to={cardTopicOutputPath(card)}
                  className="inline-flex items-center justify-center gap-2 rounded-md border border-primary bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-[0_14px_34px_-24px_rgba(47,111,95,0.75)] transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"
                >
                  🚀 带着此卡片去「专题输出」
                </Link>
                <span className="text-xs leading-5 text-muted-foreground">
                  把这张卡片作为选题起点，交给专题输出专区做跨篇 RAG 合成。
                </span>
              </div>
            </header>

            <StructuredCardContent card={card} />
          </article>
        ) : (
          <EmptyBlock text="没有找到这张知识卡片。" />
        )}
      </main>
    </div>
  );
}

function CardActions({
  card,
  deleting,
  onDelete,
}: {
  card: KnowledgeCard;
  deleting: boolean;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const cardText = useMemo(() => cardToPlainText(card), [card]);

  const copyCard = async () => {
    await navigator.clipboard.writeText(cardText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex shrink-0 items-center gap-2">
      <button
        type="button"
        onClick={() => void copyCard()}
        className="inline-flex items-center gap-1.5 rounded-md border border-current/10 bg-background/50 px-2.5 py-1.5 text-xs text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "已复制" : "复制"}
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={deleting}
        className="inline-flex items-center gap-1.5 rounded-md border border-destructive/35 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive transition hover:border-destructive/60 hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        {deleting ? "归档中" : "归档"}
      </button>
    </div>
  );
}

function StructuredCardContent({ card }: { card: KnowledgeCard }) {
  const payload = card.payload;
  if (!payload) {
    return (
      <>
        <DetailSection title="卡片内容" icon={<BookOpenText className="h-4 w-4 text-primary/80" />}>
          {card.markdown?.trim() ? <MarkdownPreview markdown={card.markdown} /> : <FallbackCardContent card={card} />}
        </DetailSection>
        <CardSourceSection card={card} />
      </>
    );
  }
  const judgments = payload.core_judgments ?? [];

  return (
    <>
      <DetailSection title="什么时候用" icon={<Workflow className="h-4 w-4 text-primary/80" />}>
        <TextList empty="暂无适用场景。" items={payload.when_to_use} />
      </DetailSection>

      <DetailSection title="核心判断" icon={<CircleDot className="h-4 w-4 text-primary/80" />}>
        <TextList
          empty="暂无核心判断。"
          items={judgments.map((judgment) => judgment.statement)}
        />
      </DetailSection>

      <DetailSection title="为什么成立" icon={<BookOpenText className="h-4 w-4 text-primary/80" />}>
        <div className="space-y-4">
          {judgments.length ? (
            judgments.map((judgment, index) => (
              <div key={judgment.id || `${card.id}-judgment-${index}`} className="border-t border-border/80 pt-4 first:border-t-0 first:pt-0">
                <h3 className="text-base font-semibold leading-6 text-foreground">
                  {judgment.statement || `判断 ${index + 1}`}
                </h3>
                {judgment.reasoning ? (
                  <p className="mt-2 text-sm leading-7 text-foreground/85">{judgment.reasoning}</p>
                ) : null}
                {judgment.support?.length ? (
                  <div className="mt-3 space-y-2">
                    {judgment.support.map((support, supportIndex) => (
                      <div key={`${judgment.id || index}-support-${supportIndex}`} className="border-l-2 border-primary/20 bg-background/45 px-3 py-2">
                        <p className="text-sm leading-6 text-muted-foreground">{support.summary}</p>
                        {(support.source_ids ?? []).length ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {(support.source_ids ?? []).map((sourceId) => (
                              <SourceChip key={`${judgment.id}-${supportIndex}-${sourceId}`} title={sourceLabel(card.sources, sourceId)} muted />
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))
          ) : (
            <EmptyInline text="暂无推理依据。" />
          )}
        </div>
      </DetailSection>

      <DetailSection title="边界与反例" icon={<ShieldAlert className="h-4 w-4 text-primary/80" />}>
        <TextList empty="暂无边界说明。" items={payload.boundaries} />
      </DetailSection>

      <DetailSection title="行动启发" icon={<Sparkles className="h-4 w-4 text-primary/80" />}>
        <TextList empty="暂无行动启发。" items={payload.action_items} />
      </DetailSection>

      <CardSourceSection card={card} />

      {(card.file_path || card.source_theme || card.markdown?.trim()) ? (
      <DetailSection title="兼容信息" icon={<FileText className="h-4 w-4 text-primary/80" />}>
        {(card.file_path || card.source_theme) ? (
          <div className="space-y-2 text-sm leading-6 text-muted-foreground">
            <PathLine label="存储位置" value={card.file_path} />
            <PathLine label="所属专题" value={card.source_theme} />
          </div>
        ) : null}
        {card.markdown?.trim() ? (
        <details className="mt-4 rounded-md border border-border bg-background p-3">
            <summary className="cursor-pointer text-sm font-medium text-foreground">旧版原始内容</summary>
            <MarkdownPreview markdown={card.markdown} />
          </details>
        ) : null}
      </DetailSection>
      ) : null}
    </>
  );
}

function DetailSection({
  children,
  icon,
  title,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <section className="border-t border-border/80 pt-6 first:border-t-0 first:pt-0">
      <h2 className="flex items-center gap-2 text-lg font-semibold tracking-normal text-foreground">
        {icon}
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function TextList({ empty, items }: { empty: string; items?: string[] }) {
  const values = (items ?? []).map((item) => item.trim()).filter(Boolean);
  if (!values.length) return <EmptyInline text={empty} />;
  return (
    <ul className="space-y-2">
      {values.map((item, index) => (
        <li key={`${index}-${item}`} className="flex gap-2 text-sm leading-7 text-foreground">
          <CircleDot className="mt-2 h-3 w-3 shrink-0 text-primary/80" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function CardSourceSection({ card }: { card: KnowledgeCard }) {
  return (
    <DetailSection title="来源" icon={<BookMarked className="h-4 w-4 text-primary/80" />}>
      {card.sources.length ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {card.sources.map((source) => (
            <SourceRow key={`${card.id}-${source.id}`} source={source} />
          ))}
        </div>
      ) : (
        <EmptyInline text="暂无来源材料。后续生成卡片时需要绑定 captures，方便追溯。" />
      )}
    </DetailSection>
  );
}

function FallbackCardContent({ card }: { card: KnowledgeCard }) {
  const claims = normalizedArguments(card.core_arguments);
  return (
    <div className="mt-3 space-y-4">
      {claims.length ? (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground">内容要点</h4>
          <ul className="mt-2 space-y-2">
            {claims.map((claim, index) => (
              <li key={`${card.id}-detail-${index}`} className="flex gap-2 text-sm leading-6 text-foreground">
                <CircleDot className="mt-1.5 h-3 w-3 shrink-0 text-primary/80" />
                <span>{claim}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <EmptyInline text="暂无内容要点。" />
      )}

      {card.key_materials?.length ? (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground">关键词材料</h4>
          <div className="mt-2 flex flex-wrap gap-2">
            {card.key_materials.map((item, index) => (
              <SourceChip key={`${index}-${displayValue(item)}`} title={displayValue(item)} />
            ))}
          </div>
        </div>
      ) : null}

      {card.my_view ? (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground">适用或启发</h4>
          <p className="mt-2 text-sm leading-6 text-foreground">{card.my_view}</p>
        </div>
      ) : null}
    </div>
  );
}

function MarkdownPreview({ markdown }: { markdown: string }) {
  const lines = stripTrailingSourceSection(markdown)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    <div className="mt-3 space-y-2">
      {lines.map((line, index) => {
        if (line.startsWith("# ")) {
          return null;
        }
        if (line.startsWith("## ")) {
          return (
            <h4 key={index} className="pt-2 text-sm font-semibold text-foreground">
              {line.replace(/^##\s+/, "")}
            </h4>
          );
        }
        if (line.startsWith("- ")) {
          return (
            <div key={index} className="flex gap-2 text-sm leading-6 text-foreground">
              <CircleDot className="mt-1.5 h-3 w-3 shrink-0 text-primary/80" />
              <span>{renderInlineWikiLinks(line.replace(/^-\s+/, ""))}</span>
            </div>
          );
        }
        return (
          <p key={index} className="text-sm leading-6 text-foreground">
            {renderInlineWikiLinks(line)}
          </p>
        );
      })}
    </div>
  );
}

function stripTrailingSourceSection(markdown: string): string {
  const lines = markdown.split("\n");
  const sourceIndex = lines.findIndex((line) =>
    /^#{1,3}\s*(来源|参考来源|引用|references?)\s*[:：]?$/i.test(line.trim())
  );
  if (sourceIndex === -1) return markdown;
  const hasLaterSection = lines
    .slice(sourceIndex + 1)
    .some((line) => /^#{1,3}\s+\S/.test(line.trim()));
  return hasLaterSection ? markdown : lines.slice(0, sourceIndex).join("\n").trim();
}

function renderInlineWikiLinks(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const pattern = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const label = (match[2] || PathStem(match[1] || "")).trim();
    parts.push(
      <span
        key={`${match.index}-${match[0]}`}
        className="rounded border border-current/10 bg-background/60 px-1 py-0.5 text-xs text-muted-foreground"
      >
        {label}
      </span>
    );
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length ? parts : text;
}

function SourcePreview({ sources }: { sources: KnowledgeSource[] }) {
  if (!sources.length) {
    return <SourceChip title="暂无来源" muted />;
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <BookMarked className="h-3.5 w-3.5" />
        {sources.length} 篇来源
      </div>
      <div className="flex flex-wrap gap-1.5">
        {sources.slice(0, 4).map((source) => (
          <SourceChip key={`${source.id}-${source.file_path}`} title={displaySourceTitle(source)} />
        ))}
      </div>
    </div>
  );
}

function SourceRow({ source }: { source: KnowledgeSource }) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <p className="text-sm font-medium leading-5 text-foreground">{displaySourceTitle(source)}</p>
      {source.summary ? (
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{source.summary}</p>
      ) : null}
      {source.file_path ? (
        <p className="mt-2 break-words rounded border border-border bg-background px-2 py-1 text-xs leading-5 text-muted-foreground">
          {knowledgeFileLink(source.file_path, displaySourceTitle(source))}
        </p>
      ) : null}
    </div>
  );
}

function FilterSection({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium tracking-normal text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

function FilterButton({
  active,
  count,
  description,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  count: number;
  description?: string;
  icon?: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20",
        active
          ? "border-primary/50 bg-primary/10 text-foreground"
          : "border-transparent text-muted-foreground hover:border-border hover:bg-background/65 hover:text-foreground",
      )}
    >
      {icon ? <span className="shrink-0">{icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{label}</span>
        {description ? <span className="block truncate text-xs text-muted-foreground">{description}</span> : null}
      </span>
      <span className="shrink-0 rounded-md border border-border bg-background/55 px-2 py-0.5 text-xs">
        {count}
      </span>
    </button>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center justify-center rounded-md border border-border bg-background/60 px-3 py-2 text-sm text-muted-foreground">
      {label} <span className="ml-1 font-medium text-foreground">{value}</span>
    </span>
  );
}

function SourceChip({ muted, title }: { muted?: boolean; title: unknown }) {
  const label = displayValue(title) || "未命名来源";
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-md border px-2 py-0.5 text-[0.72rem] leading-5",
        muted
          ? "border-border bg-background/45 text-muted-foreground"
          : "border-primary/20 bg-primary/10 text-foreground",
      )}
      title={label}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}

function PathLine({ label, value }: { label: string; value?: string }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-words text-foreground">{value || "暂无"}</span>
    </div>
  );
}

function LoadingBlock({ text }: { text: string }) {
  return (
    <div className="space-y-3 p-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">{text}</span>
      <div className="h-4 w-32 animate-pulse rounded bg-muted" />
      <div className="space-y-2">
        <div className="h-20 animate-pulse rounded-md bg-muted/70" />
        <div className="h-20 animate-pulse rounded-md bg-muted/55" />
        <div className="h-20 animate-pulse rounded-md bg-muted/45" />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex min-h-[360px] items-center justify-center">
      <div className="max-w-md rounded-lg border border-dashed border-border bg-background/55 px-6 py-8 text-center">
        <Layers3 className="mx-auto h-8 w-8 text-muted-foreground" />
        <h2 className="mt-3 text-base font-semibold text-foreground">还没有沉淀下来的知识卡片</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          在「📄 资料伴读」里划选重点、让 AI 伴读解惑，再一键提炼卡片；被确认过的洞察、方法、新知与避坑经验会沉淀到这里。
        </p>
        <div className="mt-4 flex justify-center">
          <Link
            to="/knowledge-library"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition hover:bg-muted"
          >
            <BookOpenText className="h-4 w-4" />
            去新建或导入材料
          </Link>
        </div>
      </div>
    </div>
  );
}

function GraphEmptyState() {
  return (
    <div className="flex min-h-[360px] items-center justify-center rounded-md border border-dashed border-border bg-background/45 px-6 py-8 text-center">
      <div className="max-w-md">
        <Network className="mx-auto h-8 w-8 text-muted-foreground" />
        <h2 className="mt-3 text-base font-semibold text-foreground">暂无知识图谱</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          空库或还没有足够关系时不会生成图谱。先新建或导入材料，入库后再刷新图谱。
        </p>
        <div className="mt-4 flex justify-center">
          <Link
            to="/knowledge-library"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition hover:bg-muted"
          >
            <BookOpenText className="h-4 w-4" />
            去新建或导入材料
          </Link>
        </div>
      </div>
    </div>
  );
}

function EmptyBlock({ text }: { text: string }) {
  return (
    <div className="m-4 rounded-md border border-dashed border-border bg-background/45 px-4 py-8 text-center text-sm leading-6 text-muted-foreground">
      {text}
    </div>
  );
}

function EmptyInline({ text }: { text: string }) {
  return (
    <p className="mt-2 rounded-md border border-dashed border-border bg-background/45 px-3 py-4 text-sm leading-6 text-muted-foreground">
      {text}
    </p>
  );
}

function normalizedArguments(items?: Array<Record<string, unknown> | string>): string[] {
  return (items ?? [])
    .map((item) => {
      if (typeof item === "string") return item.trim();
      const claim = displayValue(item.claim).trim();
      const evidence = displayValue(item.evidence).trim();
      const note = displayValue(item.note).trim();
      return [claim, evidence, note].filter(Boolean).join("：");
    })
    .filter(Boolean);
}

function cardTopicOutputPath(card: KnowledgeCard): string {
  const prompt = `请结合我的知识卡片《${card.title}》（专题：${card.source_theme || "核心认知"}）以及知识库中的相关资料，帮我梳理一份结构化的思考与输出框架。`;
  return `/knowledge-chat?prompt=${encodeURIComponent(prompt)}`;
}

function cardToPlainText(card: KnowledgeCard): string {
  if (card.payload) {
    const payload = card.payload;
    const judgments = payload.core_judgments ?? [];
    const lines = [
      `# ${payload.title || card.title}`,
      "",
      payload.claim,
      "",
      "## 什么时候用",
      ...(payload.when_to_use ?? []).map((item) => `- ${item}`),
      "",
      "## 核心判断",
      ...judgments.map((judgment) => `- ${judgment.statement}`),
      "",
      "## 为什么成立",
      ...judgments.flatMap((judgment) => [
        `- ${judgment.statement}`,
        judgment.reasoning ? `  - ${judgment.reasoning}` : "",
        ...(judgment.support ?? []).map((support) => `  - ${support.summary}`),
      ]),
      "",
      "## 边界与反例",
      ...(payload.boundaries ?? []).map((item) => `- ${item}`),
      "",
      "## 行动启发",
      ...(payload.action_items ?? []).map((item) => `- ${item}`),
      "",
      "## 来源",
      ...card.sources.map((source) => `- ${displaySourceTitle(source)}`),
    ];
    return lines.filter(Boolean).join("\n").trim();
  }

  const lines = [
    `# ${card.title}`,
    "",
    card.summary,
    "",
    ...(card.markdown ? [card.markdown] : normalizedArguments(card.core_arguments).map((item) => `- ${item}`)),
    "",
    "## 来源",
    ...card.sources.map((source) => `- ${displaySourceTitle(source)}`),
  ];
  return lines.filter((line) => line !== undefined).join("\n").trim();
}

function confidenceLabel(confidence?: string): string {
  if (confidence === "high") return "高";
  if (confidence === "medium") return "中";
  if (confidence === "low") return "低";
  return confidence || "未标注";
}

function sourceLabel(sources: KnowledgeSource[], sourceId: string): string {
  const source = sources.find((item) => item.id === sourceId);
  return source ? displaySourceTitle(source) : sourceId;
}

function knowledgeFileLink(filePath: string, title: string): string {
  const stem = filePath.replace(/\.md$/, "");
  return `[[${stem}|${title}]]`;
}

function themeTitle(themePath: string): string {
  return PathStem(themePath).replace(/-/g, " ");
}

function PathStem(path: string): string {
  const file = path.split("/").pop() || path;
  return file.replace(/\.md$/, "");
}

function displaySourceTitle(source: KnowledgeSource): string {
  const title = (source.title || "").trim();
  if (!title || title === source.id) {
    return source.file_path ? PathStem(source.file_path) : "未找到来源材料";
  }
  return title;
}

function displayValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join("、");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return String(
      record.content
        ?? record.title
        ?? record.claim
        ?? record.name
        ?? JSON.stringify(record),
    );
  }
  return String(value);
}
