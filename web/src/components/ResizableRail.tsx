import { useCallback, useRef, type RefObject } from "react";
import { cn } from "@/lib/utils";

type ResizeEdge = "left" | "right";

export function ResizableRail({
  className,
  containerRef,
  defaultWidth,
  edge = "right",
  maxWidth,
  minWidth,
  onCommit,
  storageKey,
  variableName,
}: {
  className?: string;
  containerRef: RefObject<HTMLElement | null>;
  defaultWidth: number;
  edge?: ResizeEdge;
  maxWidth: number;
  minWidth: number;
  onCommit?: (width: number) => void;
  storageKey: string;
  variableName: string;
}) {
  const dragRef = useRef({
    frame: 0,
    startX: 0,
    startWidth: defaultWidth,
    width: defaultWidth,
  });

  const writeWidth = useCallback((width: number) => {
    const clamped = clamp(width, minWidth, maxWidth);
    dragRef.current.width = clamped;
    if (dragRef.current.frame) return;
    dragRef.current.frame = window.requestAnimationFrame(() => {
      dragRef.current.frame = 0;
      containerRef.current?.style.setProperty(variableName, `${dragRef.current.width}px`);
    });
  }, [containerRef, maxWidth, minWidth, variableName]);

  const commitWidth = useCallback((width: number) => {
    const clamped = clamp(width, minWidth, maxWidth);
    containerRef.current?.style.setProperty(variableName, `${clamped}px`);
    window.localStorage.setItem(storageKey, String(clamped));
    onCommit?.(clamped);
  }, [containerRef, maxWidth, minWidth, onCommit, storageKey, variableName]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className={cn(
        "group hidden min-h-0 cursor-col-resize touch-none select-none items-stretch justify-center lg:flex",
        className,
      )}
      onDoubleClick={() => commitWidth(defaultWidth)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const current = readCssPixel(containerRef.current, variableName) ?? readStoredWidth(storageKey, defaultWidth);
        dragRef.current.startX = event.clientX;
        dragRef.current.startWidth = clamp(current, minWidth, maxWidth);
        dragRef.current.width = dragRef.current.startWidth;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.dragging = "true";
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.dataset.dragging !== "true") return;
        const delta = event.clientX - dragRef.current.startX;
        writeWidth(edge === "right" ? dragRef.current.startWidth + delta : dragRef.current.startWidth - delta);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.dataset.dragging !== "true") return;
        event.currentTarget.dataset.dragging = "false";
        event.currentTarget.releasePointerCapture(event.pointerId);
        commitWidth(dragRef.current.width);
      }}
      onPointerCancel={(event) => {
        event.currentTarget.dataset.dragging = "false";
        if (dragRef.current.frame) {
          window.cancelAnimationFrame(dragRef.current.frame);
          dragRef.current.frame = 0;
        }
        containerRef.current?.style.setProperty(variableName, `${dragRef.current.startWidth}px`);
      }}
      title="拖拽调整宽度，双击恢复默认"
    >
      <div className="my-2 w-px rounded-full bg-border/40 transition-colors group-hover:bg-primary/45 group-data-[dragging=true]:bg-primary" />
    </div>
  );
}

export function readStoredWidth(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const value = Number(window.localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readCssPixel(element: HTMLElement | null, variableName: string): number | null {
  if (!element) return null;
  const value = window.getComputedStyle(element).getPropertyValue(variableName);
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
