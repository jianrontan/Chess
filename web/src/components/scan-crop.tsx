"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { BoardRegion } from "@/lib/scan-local";

/**
 * Square crop selector for the screenshot scan: drag to position, corner
 * handle to resize. Starts as the largest centered square — exactly right
 * when the screenshot IS the board, one drag away otherwise.
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
  const displayW = Math.min(460, imageW);
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

  return (
    <div className="flex flex-col gap-3">
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
          role="presentation"
          className="absolute cursor-move border-2 border-green-500"
          style={{
            left: region.x * scale,
            top: region.y * scale,
            width: region.size * scale,
            height: region.size * scale,
            boxShadow: "0 0 0 4000px rgba(0,0,0,0.45)",
          }}
          onPointerDown={(e) => beginDrag("move", e)}
        >
          <div
            role="presentation"
            className="absolute -bottom-2 -right-2 h-4 w-4 cursor-nwse-resize rounded-sm border border-white bg-green-500"
            onPointerDown={(e) => beginDrag("resize", e)}
          />
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => onConfirm(region)}>
          {busy ? "Scanning…" : "Scan this area"}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
