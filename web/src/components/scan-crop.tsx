"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { BoardRegion } from "@/lib/scan-local";

/**
 * Square crop selector for the screenshot scan: drag to position, corner
 * handle to resize (arrow keys nudge, Shift+arrows resize). Starts as the
 * largest centered square — exactly right when the screenshot IS the board,
 * one drag away otherwise.
 */
export function ScanCrop({
  imageUrl,
  imageW,
  imageH,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  imageUrl: string;
  imageW: number;
  imageH: number;
  busy: boolean;
  error: string;
  onConfirm: (region: BoardRegion) => void;
  onCancel: () => void;
}) {
  // Fit the VIEWPORT, not just the image: a fixed 460px clip cut two files
  // off the board on a 390px phone (measured). The wrapper is width-bounded
  // by the column, so its clientWidth is the real budget.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(460);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setContainerW(el.clientWidth || 460);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const displayW = Math.min(460, imageW, containerW);
  const scale = displayW / imageW;
  const displayH = imageH * scale;

  const initSize = Math.min(imageW, imageH);
  const [region, setRegion] = useState<BoardRegion>({
    x: (imageW - initSize) / 2,
    y: (imageH - initSize) / 2,
    size: initSize,
  });
  const dragRef = useRef<{
    mode: "move" | "resize";
    startX: number;
    startY: number;
    orig: BoardRegion;
  } | null>(null);

  function clamp(r: BoardRegion): BoardRegion {
    const size = Math.max(64, Math.min(r.size, Math.min(imageW, imageH)));
    return {
      size,
      x: Math.max(0, Math.min(r.x, imageW - size)),
      y: Math.max(0, Math.min(r.y, imageH - size)),
    };
  }

  function beginDrag(mode: "move" | "resize", e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, orig: region };
  }

  function onPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (e.clientX - drag.startX) / scale;
    const dy = (e.clientY - drag.startY) / scale;
    if (drag.mode === "move") {
      setRegion(clamp({ ...drag.orig, x: drag.orig.x + dx, y: drag.orig.y + dy }));
    } else {
      setRegion(clamp({ ...drag.orig, size: drag.orig.size + Math.max(dx, dy) }));
    }
  }

  function onPointerUp() {
    dragRef.current = null;
  }

  /** Keyboard fallback for the pointer-only drag: arrows move, Shift+arrows
   * resize — the crop box is otherwise unreachable without a mouse. */
  function onKeyDown(e: React.KeyboardEvent) {
    const step = 8 / scale; // ~8 screen px per press
    let next: BoardRegion | null = null;
    if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      next = { ...region, size: region.size + (e.key === "ArrowDown" ? step : -step) };
    } else if (e.key === "ArrowLeft") next = { ...region, x: region.x - step };
    else if (e.key === "ArrowRight") next = { ...region, x: region.x + step };
    else if (e.key === "ArrowUp") next = { ...region, y: region.y - step };
    else if (e.key === "ArrowDown") next = { ...region, y: region.y + step };
    if (next) {
      e.preventDefault();
      setRegion(clamp(next));
    }
  }

  return (
    <div ref={wrapRef} className="flex w-full flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Position the square over the board, then scan. The image never leaves
        your device.
      </p>
      <div
        className="relative touch-none select-none overflow-hidden rounded-md border"
        style={{ width: displayW, height: displayH }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- local object URL */}
        <img src={imageUrl} alt="Uploaded screenshot" width={displayW} height={displayH} draggable={false} />
        <div
          tabIndex={0}
          aria-label="Board selection — drag or use arrow keys to move, Shift+arrows to resize"
          className="absolute cursor-move border-2 border-green-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-600"
          style={{
            left: region.x * scale,
            top: region.y * scale,
            width: region.size * scale,
            height: region.size * scale,
            boxShadow: "0 0 0 4000px rgba(0,0,0,0.45)",
          }}
          onPointerDown={(e) => beginDrag("move", e)}
          onKeyDown={onKeyDown}
        >
          <div
            role="presentation"
            className="absolute -bottom-2 -right-2 h-4 w-4 cursor-nwse-resize rounded-sm border border-white bg-green-500"
            onPointerDown={(e) => beginDrag("resize", e)}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => onConfirm(region)}>
          {busy ? "Scanning…" : "Scan this area"}
        </Button>
        {/* Cancel stays ENABLED while busy: a stalled model download must
            never trap the user here (the abandoned scan is id-guarded). */}
        <Button size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        {busy && (
          <span className="text-xs text-muted-foreground">
            first scan downloads a small model (~1&nbsp;MB)
          </span>
        )}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
