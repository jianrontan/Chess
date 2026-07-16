"use client";

import { Card, CardContent } from "@/components/ui/card";
import type { ExplainState } from "@/lib/explain";

/** Streams the /api/explain response; hidden until an explanation is requested. */
export function ExplanationCard({ state }: { state: ExplainState | null }) {
  if (!state) return null;
  return (
    <Card>
      <CardContent className="pt-4 text-sm">
        {state.error ? (
          <p className="text-xs text-red-600">Explanation failed: {state.error}</p>
        ) : (
          <p className="whitespace-pre-wrap">
            {state.text}
            {state.streaming && <span className="animate-pulse">▍</span>}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
