import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  BookOpenText,
  BookMarked,
  Check,
  CircleDot,
  Copy,
  FileText,
  Layers3,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  Workflow,
} from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type KnowledgeCard, type KnowledgeCardKind, type KnowledgeSource } from "@/lib/api";
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
    label: "观点",
    description: "判断、解释框架、可复用看法",
    icon: Sparkles,
    tone: "border-[#bdd7d2] bg-[#edf5f2] text-[#255f54]",
    active: "border-[#8fbbb2] bg-[#e1eeea] text-[#173f38]",
    rail: "bg-[#5f998e]",
  },
  method: {
    label: "方法",
    description: "流程、策略、操作方式",
    icon: Workflow,
    tone: "border-[#c9d9bd] bg-[#f0f5eb] text-[#496d35]",
    active: "border-[#adc49a] bg-[#e7efdf] text-[#344f25]",
    rail: "bg-[#7fa66a]",
  },
  fact: {
    label: "事实",
    description: "事实材料、定义、背景知识",
    icon: BookMarked,
    tone: "border-[#e1d3aa] bg-[#f7f2e6] text-[#725c24]",
    active: "border-[#cbb879] bg-[#f1e8cf] text-[#554419]",
    rail: "bg-[#b99d4a]",
  },
  risk: {
    label: "风险",
    description: "误区、边界、失败模式",
    icon: ShieldAlert,
    tone: "border-[#e1c1bb] bg-[#f7eeeb] text-[#8a3f32]",
    active: "border-[#d4a59c] bg-[#f1e2de] text-[#653026]",
    rail: "bg-[#c87b6d]",
  },
};

const KIND_ORDER: KnowledgeCardKind[] = ["viewpoint", "method", "fact", "risk"];

export default function KnowledgeCardsBoardPage() {
  const navigate = useNavigate();
  const { cardId: routeCardId } = useParams();
  const isDetailRoute = Boolean(routeCardId);
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
    const confirmed = window.confirm(`归档知识卡片《${title}》？\n\n归档后将从卡片库隐藏，Obsidian 文件会保留。`);
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
              Knowledge Cards
            </div>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal text-foreground md:text-3xl">
              可复用知识卡片
            </h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
              这里展示已经沉淀的观点、方法、事实和风险。卡片服务于复用，Theme 页面服务于关系地图。
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
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

            <FilterSection title="来源主题">
              <FilterButton
                active={activeTheme === "all"}
                count={cards.length}
                label="全部来源"
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
                  暂无 Theme 来源。由主题方向生成的卡片会显示在这里。
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
    </div>
  );
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
            to={`/cards-board/${encodeURIComponent(card.id)}`}
            className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-foreground transition hover:border-primary/55 hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
          >
            <BookOpenText className="h-4 w-4" />
            打开完整详情
          </Link>
        </section>

        <section className="mt-4 rounded-lg border border-border bg-background p-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold tracking-normal text-foreground">
            <FileText className="h-4 w-4 text-primary/80" />
            文件与主题
          </h3>
          <div className="mt-2 space-y-2 text-sm leading-6 text-muted-foreground">
            <PathLine label="卡片文件" value={card.file_path} />
            <PathLine label="来源主题" value={card.source_theme} />
          </div>
        </section>

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

      <DetailSection title="文件与原文" icon={<FileText className="h-4 w-4 text-primary/80" />}>
        <div className="space-y-2 text-sm leading-6 text-muted-foreground">
          <PathLine label="卡片文件" value={card.file_path} />
          <PathLine label="来源主题" value={card.source_theme} />
        </div>
        {card.markdown?.trim() ? (
        <details className="mt-4 rounded-md border border-border bg-background p-3">
            <summary className="cursor-pointer text-sm font-medium text-foreground">Obsidian 原文</summary>
            <MarkdownPreview markdown={card.markdown} />
          </details>
        ) : null}
      </DetailSection>
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
          {obsidianWikiLink(source.file_path, displaySourceTitle(source))}
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
        <h2 className="mt-3 text-base font-semibold text-foreground">暂无知识卡片</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          当你从材料、阅读讨论或 Theme 方向中确认沉淀 Knowledge Card 后，它们会出现在这里。
        </p>
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

function obsidianWikiLink(filePath: string, title: string): string {
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
