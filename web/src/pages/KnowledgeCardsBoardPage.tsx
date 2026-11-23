import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  BookOpenText,
  Check,
  Copy,
  Layers3,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Send,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Markdown } from "@/components/Markdown";
import {
  api,
  type KnowledgeCard,
  type KnowledgeCardKind,
  type KnowledgeCardUpdateRequest,
  type KnowledgeGardenDraftItem,
  type KnowledgeGardenDraftUpdateRequest,
  type KnowledgeSource,
} from "@/lib/api";
import type { AttachedTopicCard } from "@/pages/knowledge-chat/GatewayChat";
import { cn } from "@/lib/utils";

const KIND_LABELS: Record<KnowledgeCardKind, string> = {
  viewpoint: "洞察",
  method: "方法",
  fact: "概念",
  risk: "避坑",
};

const KIND_ORDER: KnowledgeCardKind[] = ["viewpoint", "method", "fact", "risk"];

type SortKey = "recent" | "cited";

type DrawerTarget =
  | { type: "card"; id: string }
  | { type: "draft"; id: string }
  | null;

export default function KnowledgeCardsBoardPage() {
  const navigate = useNavigate();
  const { cardId: routeCardId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [cards, setCards] = useState<KnowledgeCard[]>([]);
  const [pendingDrafts, setPendingDrafts] = useState<KnowledgeGardenDraftItem[]>([]);
  const [drawer, setDrawer] = useState<DrawerTarget>(() => {
    const draftParam = searchParams.get("draft");
    if (draftParam) return { type: "draft", id: draftParam };
    if (routeCardId) return { type: "card", id: routeCardId };
    return null;
  });
  const autoOpenedDraftRef = useRef(false);
  const [activeKind, setActiveKind] = useState<KnowledgeCardKind | "all">("all");
  const [activeTheme, setActiveTheme] = useState("all");
  const [sortBy, setSortBy] = useState<SortKey>("recent");
  const [query, setQuery] = useState("");
  const [basketIds, setBasketIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [draftsLoading, setDraftsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<"" | "save" | "commit" | "discard" | "revise" | "delete">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadCards = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await api.getKnowledgeCards(200);
      setCards(payload.cards);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPendingDrafts = useCallback(async () => {
    setDraftsLoading(true);
    try {
      const payload = await api.listKnowledgeGardenDrafts(50, "draft_ready");
      setPendingDrafts(payload.items);
      const requestedDraft = searchParams.get("draft");
      if (requestedDraft && payload.items.some((d) => d.id === requestedDraft)) {
        setDrawer({ type: "draft", id: requestedDraft });
        autoOpenedDraftRef.current = true;
        setSearchParams(
          (current) => {
            const next = new URLSearchParams(current);
            next.delete("draft");
            return next;
          },
          { replace: true },
        );
      } else if (!routeCardId && !autoOpenedDraftRef.current && payload.items.length > 0) {
        autoOpenedDraftRef.current = true;
        setDrawer({ type: "draft", id: payload.items[0].id });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftsLoading(false);
    }
  }, [routeCardId, searchParams, setSearchParams]);

  useEffect(() => {
    void loadCards();
    void loadPendingDrafts();
  }, [loadCards, loadPendingDrafts]);

  useEffect(() => {
    if (routeCardId) {
      setDrawer({ type: "card", id: routeCardId });
    }
  }, [routeCardId]);

  useEffect(() => {
    if (!drawer) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrawer(null);
        if (routeCardId) navigate("/cards-board", { replace: true });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawer, navigate, routeCardId]);

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
    const list = cards.filter((card) => {
      if (activeKind !== "all" && card.kind !== activeKind) return false;
      if (activeTheme !== "all" && card.source_theme !== activeTheme) return false;
      if (!text) return true;
      return [
        card.title,
        card.summary,
        cardBodyMarkdown(card),
        card.source_theme,
        card.sources.map((source) => source.title).join(" "),
      ]
        .join("\n")
        .toLowerCase()
        .includes(text);
    });
    if (sortBy === "cited") {
      return [...list].sort((a, b) => (b.citation_count || 0) - (a.citation_count || 0));
    }
    return list;
  }, [activeKind, activeTheme, cards, query, sortBy]);

  const filteredDrafts = useMemo(() => {
    const text = query.trim().toLowerCase();
    return pendingDrafts.filter((draft) => {
      if (activeKind !== "all" && draft.card_kind !== activeKind) return false;
      if (activeTheme !== "all") return false;
      if (!text) return true;
      return [draft.title, draft.one_liner, draftBodyMarkdown(draft)]
        .join("\n")
        .toLowerCase()
        .includes(text);
    });
  }, [activeKind, activeTheme, pendingDrafts, query]);

  const activeDraft = useMemo(
    () => (drawer?.type === "draft" ? pendingDrafts.find((d) => d.id === drawer.id) ?? null : null),
    [drawer, pendingDrafts],
  );

  const activeCard = useMemo(
    () => (drawer?.type === "card" ? cards.find((c) => c.id === drawer.id) ?? null : null),
    [cards, drawer],
  );

  const basketCards = useMemo(() => {
    const byId = new Map(cards.map((card) => [card.id, card]));
    return basketIds.map((id) => byId.get(id)).filter((card): card is KnowledgeCard => Boolean(card));
  }, [basketIds, cards]);

  const toggleBasket = useCallback((cardId: string) => {
    setBasketIds((current) =>
      current.includes(cardId) ? current.filter((id) => id !== cardId) : [...current, cardId],
    );
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawer(null);
    if (routeCardId) navigate("/cards-board", { replace: true });
  }, [navigate, routeCardId]);

  const sendCardsToTopicStudio = useCallback(
    (selected: KnowledgeCard[]) => {
      if (!selected.length) return;
      const attachedCards: AttachedTopicCard[] = selected.map((card) => ({
        id: card.id,
        title: card.title,
        summary: card.payload?.claim || card.summary,
        theme: card.source_theme ? themeTitle(card.source_theme) : "",
      }));
      const prompt =
        selected.length === 1
          ? "请结合这张卡片和资料库相关材料，帮我展开一份结构化的思考与输出提纲。"
          : `请串联这 ${selected.length} 张知识卡片的内在逻辑，并结合资料库相关材料，帮我梳理一个专题观点与输出框架。`;
      navigate("/knowledge-chat", { state: { attachedCards, prompt } });
    },
    [navigate],
  );

  const saveCardEdits = useCallback(
    async (card: KnowledgeCard, updates: KnowledgeCardUpdateRequest): Promise<KnowledgeCard | null> => {
      if (busyAction) return null;
      setBusyAction("save");
      setError("");
      setNotice("");
      try {
        const res = await api.updateKnowledgeCard(card.id, updates);
        setCards((current) => current.map((item) => (item.id === card.id ? res.card : item)));
        setNotice(`已更新卡片：《${res.card.title}》。`);
        return res.card;
      } catch (err) {
        setError(`保存卡片失败：${err instanceof Error ? err.message : String(err)}`);
        return null;
      } finally {
        setBusyAction("");
      }
    },
    [busyAction],
  );

  const archiveCard = useCallback(
    async (card: KnowledgeCard) => {
      const title = card.title || "这张知识卡片";
      if (!window.confirm(`归档知识卡片《${title}》？\n\n归档后将从卡片库隐藏。`)) return;
      setBusyAction("delete");
      setError("");
      setNotice("");
      try {
        await api.deleteKnowledgeCard(card.id);
        setCards((current) => current.filter((item) => item.id !== card.id));
        setBasketIds((current) => current.filter((id) => id !== card.id));
        closeDrawer();
        setNotice(`已归档卡片：《${title}》。`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyAction("");
      }
    },
    [closeDrawer],
  );

  const saveDraftEdits = useCallback(
    async (
      draft: KnowledgeGardenDraftItem,
      updates: KnowledgeGardenDraftUpdateRequest,
    ): Promise<KnowledgeGardenDraftItem | null> => {
      if (busyAction) return null;
      setBusyAction("save");
      setError("");
      setNotice("");
      try {
        const res = await api.updateKnowledgeGardenDraft(draft.id, updates);
        setPendingDrafts((current) =>
          current.map((item) => (item.id === draft.id ? res.item : item)),
        );
        setNotice(`已保存草稿：《${res.item.title || draft.title}》。`);
        return res.item;
      } catch (err) {
        setError(`保存草稿失败：${err instanceof Error ? err.message : String(err)}`);
        return null;
      } finally {
        setBusyAction("");
      }
    },
    [busyAction],
  );

  const reviseDraftWithAi = useCallback(
    async (draft: KnowledgeGardenDraftItem, instruction: string): Promise<KnowledgeGardenDraftItem | null> => {
      if (busyAction || !instruction.trim()) return null;
      setBusyAction("revise");
      setError("");
      setNotice("");
      try {
        const res = await api.reviseKnowledgeGardenDraft(draft.id, instruction.trim());
        if (res.ok === false || res.status === "error" || res.error || res.errors?.length) {
          throw new Error(res.error || res.errors?.[0] || "AI 改写失败。");
        }
        if (res.item) {
          setPendingDrafts((current) =>
            current.map((item) => (item.id === draft.id ? res.item! : item)),
          );
          setNotice(`已按你的意见润色草稿：《${res.item.title || draft.title}》。`);
          return res.item;
        }
        await loadPendingDrafts();
        return null;
      } catch (err) {
        setError(`AI 润色失败：${err instanceof Error ? err.message : String(err)}`);
        return null;
      } finally {
        setBusyAction("");
      }
    },
    [busyAction, loadPendingDrafts],
  );

  const commitDraft = useCallback(
    async (
      draft: KnowledgeGardenDraftItem,
      pendingUpdates?: KnowledgeGardenDraftUpdateRequest | null,
    ) => {
      if (busyAction) return;
      const title = pendingUpdates?.title || draft.title || "未命名卡片";
      setBusyAction("commit");
      setError("");
      setNotice("");
      try {
        if (pendingUpdates) {
          await api.updateKnowledgeGardenDraft(draft.id, pendingUpdates);
        }
        const result = await api.commitKnowledgeGardenDraft(draft.id);
        if (result.ok === false || result.status === "error" || result.error || result.errors?.length) {
          throw new Error(result.error || result.errors?.[0] || "入库失败。");
        }
        const newCardId =
          (typeof result.card_id === "string" && result.card_id) ||
          (typeof result.meta?.card_id === "string" ? result.meta.card_id : "");
        setPendingDrafts((current) => current.filter((item) => item.id !== draft.id));
        const cardsPayload = await api.getKnowledgeCards(200);
        setCards(cardsPayload.cards);
        setDrawer(newCardId ? { type: "card", id: newCardId } : null);
        setNotice(`已存入卡片库：《${title}》。`);
      } catch (err) {
        setError(`确认入卡失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusyAction("");
      }
    },
    [busyAction],
  );

  const discardDraft = useCallback(
    async (draft: KnowledgeGardenDraftItem) => {
      if (busyAction) return;
      setBusyAction("discard");
      setError("");
      setNotice("");
      try {
        await api.discardKnowledgeGardenDraft(draft.id);
        setPendingDrafts((current) => current.filter((item) => item.id !== draft.id));
        setDrawer(null);
        setNotice(`已舍弃草稿：《${draft.title || "未命名草稿"}》。`);
      } catch (err) {
        setError(`舍弃草稿失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusyAction("");
      }
    },
    [busyAction],
  );

  const openSourceInLibrary = useCallback(
    (source: KnowledgeSource) => {
      if (!source.id) return;
      navigate(`/knowledge-library?kind=capture&item=${encodeURIComponent(source.id)}`);
    },
    [navigate],
  );

  const refreshBoard = useCallback(() => {
    void loadCards();
    void loadPendingDrafts();
  }, [loadCards, loadPendingDrafts]);

  const totalVisible = filteredDrafts.length + filteredCards.length;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col text-foreground">
      {/* Top minimal header */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 pb-3">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">知识卡片</h1>
          <span className="text-xs text-muted-foreground">
            {cards.length} 张{pendingDrafts.length > 0 ? ` · ${pendingDrafts.length} 张待确认` : ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refreshBoard}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2.5 text-xs text-muted-foreground transition hover:border-foreground/20 hover:text-foreground"
            title="刷新"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", (loading || draftsLoading) && "animate-spin")} />
            刷新
          </button>
          <Link
            to="/knowledge-chat"
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90"
          >
            去专题输出
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </header>

      {/* Single-row calm filter toolbar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 py-3">
        {/* Topic tabs */}
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <FilterTab
            active={activeTheme === "all"}
            label={`全部 (${cards.length})`}
            onClick={() => setActiveTheme("all")}
          />
          {themes.map(([theme, count]) => (
            <FilterTab
              key={theme}
              active={activeTheme === theme}
              label={`${themeTitle(theme)} (${count})`}
              onClick={() => setActiveTheme(theme)}
            />
          ))}
        </div>

        {/* Kind + Sort + Search */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center rounded-lg bg-muted/55 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setActiveKind("all")}
              className={cn(
                "rounded-md px-2.5 py-1 transition",
                activeKind === "all"
                  ? "bg-background font-medium text-foreground shadow-2xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              全部
            </button>
            {KIND_ORDER.map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => setActiveKind(kind)}
                className={cn(
                  "rounded-md px-2.5 py-1 transition",
                  activeKind === kind
                    ? "bg-background font-medium text-foreground shadow-2xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {KIND_LABELS[kind]}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setSortBy((s) => (s === "recent" ? "cited" : "recent"))}
            className="h-8 rounded-lg border border-border/70 bg-background px-2.5 text-xs text-muted-foreground transition hover:text-foreground"
            title="切换排序方式"
          >
            {sortBy === "recent" ? "按最新" : "按常用"}
          </button>

          <label className="flex h-8 w-44 items-center gap-1.5 rounded-lg border border-border/70 bg-background px-2.5 focus-within:border-foreground/30 sm:w-52">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索卡片..."
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="text-muted-foreground hover:text-foreground"
                aria-label="清空搜索"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </label>
        </div>
      </div>

      {error && (
        <div className="mb-3 flex shrink-0 items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3.5 py-2 text-xs text-destructive">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
          <button type="button" onClick={() => setError("")} className="opacity-70 hover:opacity-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {notice && (
        <div className="mb-3 flex shrink-0 items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/45 px-3.5 py-2 text-xs text-foreground">
          <div className="flex items-center gap-2">
            <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span>{notice}</span>
          </div>
          <button type="button" onClick={() => setNotice("")} className="text-muted-foreground hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Full-width paper card gallery */}
      <main className={cn("min-h-0 flex-1 overflow-y-auto pt-1", basketCards.length > 0 ? "pb-24" : "pb-6")}>
        {loading && cards.length === 0 && pendingDrafts.length === 0 ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {Array.from({ length: 6 }).map((_, idx) => (
              <div key={idx} className="h-44 animate-pulse rounded-xl bg-muted/50" />
            ))}
          </div>
        ) : totalVisible === 0 ? (
          cards.length === 0 && pendingDrafts.length === 0 ? (
            <EmptyGallery />
          ) : (
            <div className="flex min-h-[260px] items-center justify-center">
              <p className="text-sm text-muted-foreground">当前筛选条件下没有卡片。</p>
            </div>
          )
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {filteredDrafts.map((draft) => (
              <DraftGalleryCard
                key={`draft-${draft.id}`}
                draft={draft}
                active={drawer?.type === "draft" && drawer.id === draft.id}
                onOpen={() => setDrawer({ type: "draft", id: draft.id })}
              />
            ))}
            {filteredCards.map((card) => (
              <CardGalleryTile
                key={card.id}
                card={card}
                active={drawer?.type === "card" && drawer.id === card.id}
                inBasket={basketIds.includes(card.id)}
                onOpen={() => setDrawer({ type: "card", id: card.id })}
                onToggleBasket={() => toggleBasket(card.id)}
              />
            ))}
          </div>
        )}
      </main>

      {/* Floating Topic Basket for multi-card picking */}
      {basketCards.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-30 flex justify-center px-4">
          <div className="pointer-events-auto flex max-w-3xl flex-wrap items-center gap-2.5 rounded-full border border-border bg-foreground px-4 py-2 text-background shadow-xl">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium">
              <Layers3 className="h-3.5 w-3.5" />
              已挑 {basketCards.length} 张
            </span>
            <div className="hidden max-w-md items-center gap-1.5 sm:flex">
              {basketCards.slice(0, 3).map((card) => (
                <span
                  key={card.id}
                  className="inline-flex max-w-[140px] items-center gap-1 rounded-full bg-background/15 px-2.5 py-0.5 text-[11px]"
                >
                  <span className="truncate">{card.title}</span>
                  <button
                    type="button"
                    onClick={() => toggleBasket(card.id)}
                    className="opacity-70 hover:opacity-100"
                    aria-label={`移出 ${card.title}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {basketCards.length > 3 && (
                <span className="text-[11px] opacity-75">+{basketCards.length - 3}</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setBasketIds([])}
              className="text-xs opacity-70 transition hover:opacity-100"
            >
              清空
            </button>
            <button
              type="button"
              onClick={() => sendCardsToTopicStudio(basketCards)}
              className="inline-flex items-center gap-1.5 rounded-full bg-background px-3.5 py-1 text-xs font-medium text-foreground transition hover:opacity-90"
            >
              带着去专题输出
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Slide-over full reading & editing drawer */}
      {(activeDraft || activeCard) && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <div
            className="absolute inset-0 bg-black/15 backdrop-blur-[1px]"
            onClick={closeDrawer}
          />
          <aside className="relative z-10 flex h-full w-full max-w-[620px] flex-col border-l border-border/80 bg-background shadow-2xl">
            {activeDraft ? (
              <UnifiedCardDrawer
                key={`draft-${activeDraft.id}-${activeDraft.updated_at}`}
                mode="draft"
                title={activeDraft.title || "未命名卡片"}
                kind={normalizeKind(activeDraft.card_kind)}
                claim={activeDraft.payload?.claim || activeDraft.one_liner || ""}
                markdown={draftBodyMarkdown(activeDraft)}
                theme=""
                sources={[]}
                inBasket={false}
                busyAction={busyAction}
                onClose={closeDrawer}
                onSave={(updates) => saveDraftEdits(activeDraft, updates)}
                onCommit={(updates) => void commitDraft(activeDraft, updates)}
                onDiscard={() => void discardDraft(activeDraft)}
                onRevise={(instruction) => reviseDraftWithAi(activeDraft, instruction)}
              />
            ) : activeCard ? (
              <UnifiedCardDrawer
                key={`card-${activeCard.id}-${activeCard.updated_at}`}
                mode="card"
                title={activeCard.title}
                kind={normalizeKind(activeCard.kind)}
                claim={activeCard.payload?.claim || activeCard.summary || ""}
                markdown={cardBodyMarkdown(activeCard)}
                theme={activeCard.source_theme ? themeTitle(activeCard.source_theme) : ""}
                sources={activeCard.sources}
                citationCount={activeCard.citation_count}
                inBasket={basketIds.includes(activeCard.id)}
                busyAction={busyAction}
                onClose={closeDrawer}
                onSave={(updates) => saveCardEdits(activeCard, updates)}
                onArchive={() => void archiveCard(activeCard)}
                onOpenSource={openSourceInLibrary}
                onSendSingle={() => sendCardsToTopicStudio([activeCard])}
                onToggleBasket={() => toggleBasket(activeCard.id)}
              />
            ) : null}
          </aside>
        </div>
      )}
    </div>
  );
}

function DraftGalleryCard({
  active,
  draft,
  onOpen,
}: {
  active: boolean;
  draft: KnowledgeGardenDraftItem;
  onOpen: () => void;
}) {
  const claim = draft.payload?.claim || draft.one_liner || "点击查看并编辑完整草稿内容";
  const anchors = useMemo(() => extractHighlightAnchors(draftBodyMarkdown(draft)), [draft]);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "group flex min-h-[192px] cursor-pointer flex-col rounded-xl border bg-amber-50/45 p-6 text-left transition hover:bg-amber-50/75 hover:shadow-sm dark:bg-amber-950/15",
        active ? "border-amber-500/70 ring-1 ring-amber-500/30" : "border-amber-400/50",
      )}
    >
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-300">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          待确认 · {KIND_LABELS[normalizeKind(draft.card_kind)]}
        </span>
        <span className="text-amber-700/80 transition group-hover:text-amber-900">
          审阅编辑 →
        </span>
      </div>

      <h2 className="mt-3 line-clamp-2 text-[16px] font-semibold leading-snug tracking-tight text-foreground">
        {draft.title || "未命名卡片草稿"}
      </h2>

      <p className="mt-2.5 line-clamp-3 text-[13.5px] leading-[1.7] text-foreground/80">
        {claim}
      </p>

      {anchors.length > 0 && (
        <p className="mt-auto truncate pt-4 text-[11.5px] text-amber-900/70 dark:text-amber-200/75">
          {anchors.join(" · ")}
        </p>
      )}
    </div>
  );
}

function CardGalleryTile({
  active,
  card,
  inBasket,
  onOpen,
  onToggleBasket,
}: {
  active: boolean;
  card: KnowledgeCard;
  inBasket: boolean;
  onOpen: () => void;
  onToggleBasket: () => void;
}) {
  const claim = card.payload?.claim || card.summary || "";
  const anchors = useMemo(() => extractHighlightAnchors(cardBodyMarkdown(card)), [card]);
  const firstSource = card.sources[0] ? displaySourceTitle(card.sources[0]) : "";
  const metaText = [
    KIND_LABELS[normalizeKind(card.kind)],
    card.source_theme ? themeTitle(card.source_theme) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "group relative flex min-h-[192px] cursor-pointer flex-col rounded-xl border bg-white/95 p-6 text-left transition hover:shadow-[0_6px_20px_-12px_rgba(15,23,20,0.18)] dark:bg-card",
        inBasket
          ? "border-foreground/50 ring-1 ring-foreground/20"
          : active
            ? "border-foreground/35 shadow-xs"
            : "border-black/[0.08] hover:border-black/[0.18] dark:border-border/70 dark:hover:border-border",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11.5px] font-medium text-muted-foreground">
          {metaText}
        </span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleBasket();
          }}
          aria-label={inBasket ? "移出已选" : "挑选此卡片"}
          title={inBasket ? "移出已选" : "勾选用于专题输出"}
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition",
            inBasket
              ? "border-foreground bg-foreground text-background"
              : "border-border/90 bg-background text-transparent opacity-0 hover:border-foreground/50 group-hover:opacity-100 focus:opacity-100",
          )}
        >
          <Check className="h-3 w-3" />
        </button>
      </div>

      <h2 className="mt-3 line-clamp-2 text-[16px] font-semibold leading-snug tracking-tight text-foreground">
        {card.title}
      </h2>

      <p className="mt-2.5 line-clamp-3 text-[13.5px] leading-[1.7] text-foreground/80">
        {claim}
      </p>

      {anchors.length > 0 && (
        <p className="mt-3 truncate text-[11.5px] text-muted-foreground/90">
          {anchors.join(" · ")}
        </p>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 pt-4 text-[11px] text-muted-foreground/80">
        <span className="truncate">{firstSource || "个人卡片"}</span>
        {card.citation_count ? (
          <span className="shrink-0 text-muted-foreground">引用 {card.citation_count}</span>
        ) : null}
      </div>
    </div>
  );
}

function UnifiedCardDrawer({
  mode,
  title: initialTitle,
  kind: initialKind,
  claim: initialClaim,
  markdown: initialMarkdown,
  theme,
  sources,
  citationCount,
  inBasket,
  busyAction,
  onClose,
  onSave,
  onCommit,
  onDiscard,
  onArchive,
  onRevise,
  onOpenSource,
  onSendSingle,
  onToggleBasket,
}: {
  mode: "draft" | "card";
  title: string;
  kind: KnowledgeCardKind;
  claim: string;
  markdown: string;
  theme: string;
  sources: KnowledgeSource[];
  citationCount?: number;
  inBasket: boolean;
  busyAction: "" | "save" | "commit" | "discard" | "revise" | "delete";
  onClose: () => void;
  onSave: (updates: {
    title?: string;
    card_kind?: KnowledgeCardKind;
    claim?: string;
    markdown?: string;
  }) => Promise<unknown>;
  onCommit?: (updates?: KnowledgeGardenDraftUpdateRequest | null) => void;
  onDiscard?: () => void;
  onArchive?: () => void;
  onRevise?: (instruction: string) => Promise<unknown>;
  onOpenSource?: (source: KnowledgeSource) => void;
  onSendSingle?: () => void;
  onToggleBasket?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(initialTitle);
  const [kind, setKind] = useState<KnowledgeCardKind>(initialKind);
  const [claim, setClaim] = useState(initialClaim);
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [dirty, setDirty] = useState(false);
  const [copied, setCopied] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const busy = Boolean(busyAction);

  const displayBody = useMemo(
    () => stripRedundantHeader(markdown, title, claim),
    [claim, markdown, title],
  );

  const buildUpdates = () => ({
    title: title.trim() || initialTitle,
    card_kind: kind,
    claim: claim.trim(),
    markdown: markdown.trim(),
  });

  const handleSave = async () => {
    const res = await onSave(buildUpdates());
    if (res) {
      setDirty(false);
      setEditing(false);
    }
  };

  const handleCopy = async () => {
    const text = [`# ${title}`, "", claim, "", displayBody].filter(Boolean).join("\n");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const handleAiRevise = async () => {
    if (!onRevise || !aiInstruction.trim() || busy) return;
    const res = await onRevise(aiInstruction);
    if (res) {
      setAiInstruction("");
      setDirty(false);
      setEditing(false);
    }
  };

  return (
    <>
      {/* Drawer Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-6 py-3.5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {mode === "draft" ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-300">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              待确认草稿
            </span>
          ) : (
            <span>
              {KIND_LABELS[kind]}
              {theme ? ` · ${theme}` : ""}
              {citationCount ? ` · 引用 ${citationCount} 次` : ""}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {!editing ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing(true)}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                <Pencil className="h-3.5 w-3.5" />
                编辑
              </button>
              <button
                type="button"
                onClick={() => void handleCopy()}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "已复制" : "复制"}
              </button>
              {mode === "card" && onArchive ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onArchive}
                  className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                  title="归档卡片"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setTitle(initialTitle);
                setKind(initialKind);
                setClaim(initialClaim);
                setMarkdown(initialMarkdown);
                setDirty(false);
                setEditing(false);
              }}
              className="inline-flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              取消编辑
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Drawer Content */}
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
        {!editing ? (
          <article className="space-y-6">
            <div>
              <h2 className="text-[22px] font-semibold leading-snug tracking-tight text-foreground">
                {title || "未命名卡片"}
              </h2>
              {claim ? (
                <p className="mt-4 rounded-xl bg-muted/45 px-4 py-3.5 text-[15px] leading-[1.75] text-foreground/90">
                  {claim}
                </p>
              ) : null}
            </div>

            {displayBody ? (
              <div
                className={cn(
                  "pt-1",
                  "[&_[data-markdown-root]]:space-y-4 [&_[data-markdown-root]]:text-[15px] [&_[data-markdown-root]]:leading-[1.85] [&_[data-markdown-root]]:text-foreground/88",
                  "[&_[data-markdown-root]_ul]:space-y-3 [&_[data-markdown-root]_ul]:pl-5 [&_[data-markdown-root]_ul]:text-[15px]",
                  "[&_[data-markdown-root]_ol]:space-y-3 [&_[data-markdown-root]_ol]:pl-5 [&_[data-markdown-root]_ol]:text-[15px]",
                  "[&_[data-markdown-root]_li]:leading-[1.8]",
                  "[&_[data-markdown-root]_strong]:font-semibold [&_[data-markdown-root]_strong]:text-foreground",
                  "[&_[data-markdown-root]_blockquote]:rounded-xl [&_[data-markdown-root]_blockquote]:border-0 [&_[data-markdown-root]_blockquote]:bg-amber-50/70 [&_[data-markdown-root]_blockquote]:px-4 [&_[data-markdown-root]_blockquote]:py-3 [&_[data-markdown-root]_blockquote]:text-[14px] [&_[data-markdown-root]_blockquote]:leading-[1.75] [&_[data-markdown-root]_blockquote]:text-foreground/85 dark:[&_[data-markdown-root]_blockquote]:bg-amber-950/25",
                  "[&_[data-markdown-root]_h2]:pt-2 [&_[data-markdown-root]_h2]:text-[15px] [&_[data-markdown-root]_h3]:pt-2 [&_[data-markdown-root]_h3]:text-[14.5px]",
                )}
              >
                <Markdown content={displayBody} />
              </div>
            ) : null}

            {sources.length > 0 && (
              <section className="border-t border-border/50 pt-5">
                <h3 className="mb-2.5 text-xs font-medium text-muted-foreground">来源原文</h3>
                <div className="space-y-2">
                  {sources.map((source) => (
                    <button
                      key={source.id}
                      type="button"
                      onClick={() => onOpenSource?.(source)}
                      className="flex w-full items-start gap-2.5 rounded-lg border border-border/60 bg-muted/25 px-3 py-2.5 text-left transition hover:border-foreground/25 hover:bg-muted/50"
                    >
                      <BookOpenText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-foreground">
                          {displaySourceTitle(source)}
                        </div>
                        {source.summary ? (
                          <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                            {source.summary}
                          </p>
                        ) : null}
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </article>
        ) : (
          <div className="flex h-full flex-col gap-4">
            <div className="flex items-center gap-1.5">
              {KIND_ORDER.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setKind(k);
                    setDirty(true);
                  }}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs transition",
                    kind === k
                      ? "bg-foreground font-medium text-background"
                      : "bg-muted/60 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {KIND_LABELS[k]}
                </button>
              ))}
            </div>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">标题</span>
              <input
                value={title}
                disabled={busy}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setDirty(true);
                }}
                placeholder="短标题（14字以内）"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-base font-semibold text-foreground outline-none focus:border-foreground/40"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">一句话结论</span>
              <textarea
                value={claim}
                disabled={busy}
                rows={2}
                onChange={(e) => {
                  setClaim(e.target.value);
                  setDirty(true);
                }}
                placeholder="整张卡最值得记住的那一句话..."
                className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm leading-6 text-foreground outline-none focus:border-foreground/40"
              />
            </label>

            <label className="flex min-h-[260px] flex-1 flex-col space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">正文（支持 Markdown，像笔记一样自由写）</span>
              <textarea
                value={markdown}
                disabled={busy}
                onChange={(e) => {
                  setMarkdown(e.target.value);
                  setDirty(true);
                }}
                placeholder="写清底层逻辑、做法步骤或你自己的随手心得..."
                className="min-h-[240px] flex-1 resize-y rounded-lg border border-border bg-background px-3 py-2.5 text-sm leading-7 text-foreground outline-none focus:border-foreground/40"
              />
            </label>
          </div>
        )}
      </div>

      {/* Drawer Footer */}
      <div className="shrink-0 space-y-2.5 border-t border-border/60 bg-background/95 px-6 py-3.5">
        {mode === "draft" && onRevise && (
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center gap-2 rounded-lg border border-border/80 bg-background px-3 py-1.5 focus-within:border-foreground/35">
              <Wand2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                value={aiInstruction}
                disabled={busy}
                onChange={(e) => setAiInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleAiRevise();
                  }
                }}
                placeholder="不满意？说一句让 AI 润色（如：说人话、再精简一点）"
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            </div>
            <button
              type="button"
              disabled={busy || !aiInstruction.trim()}
              onClick={() => void handleAiRevise()}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-border/80 bg-background px-3 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-45"
            >
              {busyAction === "revise" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              AI 润色
            </button>
          </div>
        )}

        {mode === "draft" ? (
          <div className="flex items-center gap-2">
            {editing && dirty ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleSave()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-background px-3.5 text-xs font-medium text-foreground transition hover:bg-muted disabled:opacity-45"
                >
                  {busyAction === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  暂存草稿
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onCommit?.(buildUpdates())}
                  className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-foreground px-4 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-45"
                >
                  {busyAction === "commit" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  保存并存入卡片库
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => onCommit?.(dirty ? buildUpdates() : null)}
                className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-foreground px-4 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-45"
              >
                {busyAction === "commit" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                确认存入卡片库
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={onDiscard}
              className="inline-flex h-9 items-center gap-1 rounded-lg border border-border/80 px-3 text-xs text-muted-foreground transition hover:border-destructive/40 hover:text-destructive disabled:opacity-45"
            >
              {busyAction === "discard" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              舍弃
            </button>
          </div>
        ) : editing ? (
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={busy || !dirty}
              onClick={() => void handleSave()}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-foreground px-4 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-45"
            >
              {busyAction === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              保存修改
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onSendSingle}
              className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-foreground px-4 text-xs font-medium text-background transition hover:opacity-90"
            >
              带着此卡去专题输出
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onToggleBasket}
              className={cn(
                "inline-flex h-9 items-center gap-1.5 rounded-lg border px-3.5 text-xs font-medium transition",
                inBasket
                  ? "border-foreground bg-foreground/8 text-foreground"
                  : "border-border/80 bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              {inBasket ? <Check className="h-3.5 w-3.5" /> : null}
              {inBasket ? "已挑中" : "加入已选"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function FilterTab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg px-3 py-1.5 text-xs transition",
        active
          ? "bg-foreground font-medium text-background"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function EmptyGallery() {
  return (
    <div className="flex min-h-[380px] items-center justify-center">
      <div className="max-w-sm text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl border border-border/70 bg-muted/40 text-muted-foreground">
          <Layers3 className="h-5 w-5" />
        </div>
        <h2 className="mt-4 text-base font-semibold text-foreground">你的卡片库还是空的</h2>
        <p className="mt-1.5 text-xs leading-6 text-muted-foreground">
          在「资料伴读」中读完文章后点击顶部「提炼卡片」，提炼出的自然人话卡片会整齐摊开在这里，方便随时翻阅与挑选拼装。
        </p>
        <div className="mt-5 flex justify-center">
          <Link
            to="/knowledge-library"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-foreground px-4 text-xs font-medium text-background transition hover:opacity-90"
          >
            <BookOpenText className="h-3.5 w-3.5" />
            去资料伴读提炼第一张卡
          </Link>
        </div>
      </div>
    </div>
  );
}

function normalizeKind(kind?: string): KnowledgeCardKind {
  return KIND_ORDER.includes(kind as KnowledgeCardKind) ? (kind as KnowledgeCardKind) : "viewpoint";
}

function cardBodyMarkdown(card: KnowledgeCard): string {
  return (
    card.markdown ||
    card.content_markdown ||
    card.payload?.content_markdown ||
    ""
  ).trim();
}

function draftBodyMarkdown(draft: KnowledgeGardenDraftItem): string {
  return (
    draft.markdown ||
    draft.payload?.content_markdown ||
    ""
  ).trim();
}

function stripRedundantHeader(markdown: string, title: string, claim: string): string {
  const lines = markdown.trim().split("\n");
  let idx = 0;
  while (idx < lines.length && !lines[idx].trim()) idx += 1;
  if (idx < lines.length && lines[idx].trim().startsWith("# ")) {
    const heading = lines[idx].trim().replace(/^#\s+/, "").trim();
    if (!title || heading === title.trim()) {
      idx += 1;
    }
  }
  while (idx < lines.length && !lines[idx].trim()) idx += 1;
  if (idx < lines.length && lines[idx].trim().startsWith("> ")) {
    const quote = lines[idx].trim().replace(/^>\s+/, "").trim();
    if (claim && quote === claim.trim()) {
      idx += 1;
    }
  }
  return lines.slice(idx).join("\n").trim();
}

function extractHighlightAnchors(markdown: string): string[] {
  if (!markdown) return [];
  const anchors: string[] = [];
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    const match = line.match(/^(?:[-*+]|\d+\.)\s+\*\*([^*]{2,16})\*\*/);
    if (match?.[1]) {
      const label = match[1].replace(/[：:]+$/, "").trim();
      if (label && !anchors.includes(label)) {
        anchors.push(label);
      }
      if (anchors.length >= 3) break;
    }
  }
  return anchors;
}

function themeTitle(themePath: string): string {
  const file = themePath.split("/").pop() || themePath;
  return file.replace(/\.md$/, "").replace(/-/g, " ");
}

function displaySourceTitle(source: KnowledgeSource): string {
  const title = (source.title || "").trim();
  if (!title || title === source.id) {
    const file = (source.file_path || "").split("/").pop() || "";
    return file ? file.replace(/\.md$/, "") : "未命名来源";
  }
  return title;
}
