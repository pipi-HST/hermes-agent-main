import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
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
  Workflow,
} from "lucide-react";
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
    tone: "border-sky-500/35 bg-sky-500/10 text-sky-100",
    active: "border-sky-400/70 bg-sky-400/15 text-sky-50",
    rail: "bg-sky-400",
  },
  method: {
    label: "方法",
    description: "流程、策略、操作方式",
    icon: Workflow,
    tone: "border-emerald-500/35 bg-emerald-500/10 text-emerald-100",
    active: "border-emerald-400/70 bg-emerald-400/15 text-emerald-50",
    rail: "bg-emerald-400",
  },
  fact: {
    label: "事实",
    description: "事实材料、定义、背景知识",
    icon: BookMarked,
    tone: "border-amber-500/35 bg-amber-500/10 text-amber-100",
    active: "border-amber-400/70 bg-amber-400/15 text-amber-50",
    rail: "bg-amber-400",
  },
  risk: {
    label: "风险",
    description: "误区、边界、失败模式",
    icon: ShieldAlert,
    tone: "border-rose-500/35 bg-rose-500/10 text-rose-100",
    active: "border-rose-400/70 bg-rose-400/15 text-rose-50",
    rail: "bg-rose-400",
  },
};

const KIND_ORDER: KnowledgeCardKind[] = ["viewpoint", "method", "fact", "risk"];

export default function KnowledgeCardsBoardPage() {
  const [cards, setCards] = useState<KnowledgeCard[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<KnowledgeCard | null>(null);
  const [activeKind, setActiveKind] = useState<KnowledgeCardKind | "all">("all");
  const [activeTheme, setActiveTheme] = useState("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");

  const loadCards = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await api.getKnowledgeCards(200);
      setCards(payload.cards);
      setSelectedId((current) => {
        if (current && payload.cards.some((card) => card.id === current)) return current;
        return payload.cards[0]?.id ?? "";
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

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
    if (!filteredCards.length) {
      setSelectedId("");
      return;
    }
    if (!selectedId || !filteredCards.some((card) => card.id === selectedId)) {
      setSelectedId(filteredCards[0].id);
    }
  }, [filteredCards, selectedId]);

  const selectedCard = detail && detail.id === selectedId
    ? detail
    : cards.find((card) => card.id === selectedId) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 normal-case text-foreground">
      <header className="shrink-0 overflow-hidden rounded-lg border border-current/10 bg-background-base/85 shadow-[0_18px_60px_rgba(0,0,0,0.18)] backdrop-blur">
        <div className="flex flex-col gap-4 px-4 py-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-primary/80">
              <Layers3 className="h-3.5 w-3.5" />
              Knowledge Cards
            </div>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal text-foreground">
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
              className="inline-flex items-center justify-center gap-1.5 rounded-md border border-current/10 bg-background/55 px-3 py-2 text-sm text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
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

      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[260px_minmax(0,1fr)_430px]">
        <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-current/10 bg-background-base/75 shadow-[0_18px_70px_rgba(0,0,0,0.14)] backdrop-blur">
          <div className="border-b border-current/10 p-3">
            <label className="flex items-center gap-2 rounded-md border border-current/10 bg-background/55 px-2.5 py-2">
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
                <p className="rounded-md border border-dashed border-current/15 bg-background/35 px-3 py-3 text-xs leading-5 text-muted-foreground">
                  暂无 Theme 来源。由主题方向生成的卡片会显示在这里。
                </p>
              )}
            </FilterSection>
          </div>
        </aside>

        <main className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-current/10 bg-background-base/75 shadow-[0_18px_70px_rgba(0,0,0,0.14)] backdrop-blur">
          <div className="flex shrink-0 items-center justify-between border-b border-current/10 px-4 py-3">
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

        <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-current/10 bg-background-base/75 shadow-[0_18px_70px_rgba(0,0,0,0.14)] backdrop-blur">
          {detailLoading && selectedId ? (
            <LoadingBlock text="读取卡片详情..." />
          ) : selectedCard ? (
            <CardDetail card={selectedCard} />
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
        "group relative flex min-h-[260px] flex-col overflow-hidden rounded-lg border p-4 text-left transition",
        selected
          ? "border-primary/55 bg-primary/10 shadow-[0_16px_50px_rgba(0,0,0,0.20)]"
          : "border-current/10 bg-background/45 hover:border-primary/30 hover:bg-background/70",
      )}
    >
      <div className={cn("absolute left-0 top-0 h-full w-1", meta.rail)} />
      <div className="flex items-start justify-between gap-3 pl-1">
        <div className="min-w-0">
          <div className={cn("mb-2 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs", meta.tone)}>
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

function CardDetail({ card }: { card: KnowledgeCard }) {
  const meta = KIND_META[card.kind];
  const Icon = meta.icon;
  const [copied, setCopied] = useState(false);
  const cardText = useMemo(() => cardToPlainText(card), [card]);

  const copyCard = async () => {
    await navigator.clipboard.writeText(cardText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <div className="shrink-0 border-b border-current/10 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs", meta.active)}>
            <Icon className="h-3.5 w-3.5" />
            {meta.label}
          </span>
          <button
            type="button"
            onClick={() => void copyCard()}
            className="inline-flex items-center gap-1.5 rounded-md border border-current/10 bg-background/50 px-2.5 py-1.5 text-xs text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
        <h2 className="text-xl font-semibold leading-7 tracking-normal text-foreground">{card.title}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {card.summary || "暂无摘要"}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <section className="rounded-lg border border-current/10 bg-background/40 p-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold tracking-normal text-foreground">
            <BookOpenText className="h-4 w-4 text-primary/80" />
            卡片内容
          </h3>
          {card.markdown?.trim() ? (
            <MarkdownPreview markdown={card.markdown} />
          ) : (
            <FallbackCardContent card={card} />
          )}
        </section>

        <section className="mt-4 rounded-lg border border-current/10 bg-background/40 p-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold tracking-normal text-foreground">
            <FileText className="h-4 w-4 text-primary/80" />
            文件与主题
          </h3>
          <div className="mt-2 space-y-2 text-sm leading-6 text-muted-foreground">
            <PathLine label="卡片文件" value={card.file_path} />
            <PathLine label="来源主题" value={card.source_theme} />
          </div>
        </section>

        <section className="mt-4 rounded-lg border border-current/10 bg-background/40 p-3">
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
  const lines = markdown
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
              <span>{line.replace(/^-\s+/, "")}</span>
            </div>
          );
        }
        return (
          <p key={index} className="text-sm leading-6 text-foreground">
            {line}
          </p>
        );
      })}
    </div>
  );
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
    <div className="rounded-md border border-current/10 bg-background/45 p-3">
      <p className="text-sm font-medium leading-5 text-foreground">{displaySourceTitle(source)}</p>
      {source.summary ? (
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{source.summary}</p>
      ) : null}
      {source.file_path ? (
        <p className="mt-2 break-words rounded border border-current/10 bg-background/40 px-2 py-1 text-xs leading-5 text-muted-foreground">
          {obsidianWikiLink(source.file_path, displaySourceTitle(source))}
        </p>
      ) : null}
    </div>
  );
}

function FilterSection({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
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
        "flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left transition",
        active
          ? "border-primary/50 bg-primary/10 text-foreground"
          : "border-transparent text-muted-foreground hover:border-current/10 hover:bg-background/55 hover:text-foreground",
      )}
    >
      {icon ? <span className="shrink-0">{icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{label}</span>
        {description ? <span className="block truncate text-xs text-muted-foreground">{description}</span> : null}
      </span>
      <span className="shrink-0 rounded-full border border-current/10 bg-background/45 px-2 py-0.5 text-xs">
        {count}
      </span>
    </button>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center justify-center rounded-md border border-current/10 bg-background/50 px-3 py-2 text-sm text-muted-foreground">
      {label} <span className="ml-1 font-medium text-foreground">{value}</span>
    </span>
  );
}

function SourceChip({ muted, title }: { muted?: boolean; title: unknown }) {
  const label = displayValue(title) || "未命名来源";
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[0.72rem] leading-5",
        muted
          ? "border-current/10 bg-background/40 text-muted-foreground"
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
    <div className="flex min-h-32 items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {text}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex min-h-[360px] items-center justify-center">
      <div className="max-w-md rounded-lg border border-dashed border-current/15 bg-background/40 px-6 py-8 text-center">
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
    <div className="m-4 rounded-md border border-dashed border-current/15 bg-background/35 px-4 py-8 text-center text-sm leading-6 text-muted-foreground">
      {text}
    </div>
  );
}

function EmptyInline({ text }: { text: string }) {
  return (
    <p className="mt-2 rounded-md border border-dashed border-current/15 bg-background/35 px-3 py-4 text-sm leading-6 text-muted-foreground">
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
