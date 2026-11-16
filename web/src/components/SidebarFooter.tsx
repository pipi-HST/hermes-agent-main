import { Typography } from "@/components/NouiTypography";
import { useSidebarStatus } from "@/hooks/useSidebarStatus";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

export function SidebarFooter() {
  const { status } = useSidebarStatus();
  const { t } = useI18n();

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-between gap-2",
        "px-5 py-2.5",
        "border-t border-border/80",
      )}
    >
      <Typography
        className="font-mono-ui text-xs tabular-nums tracking-normal text-muted-foreground lowercase"
      >
        {status?.version != null ? `v${status.version}` : "—"}
      </Typography>

      <a
        href="https://nousresearch.com"
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "text-xs font-medium tracking-normal text-muted-foreground",
          "transition-colors hover:text-foreground",
          "focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25",
        )}
      >
        {t.app.footer.org}
      </a>
    </div>
  );
}
