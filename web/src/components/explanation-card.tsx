"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ExplainState } from "@/lib/explain";

/** Streams the /api/explain response; hidden until an explanation is requested. */
export function ExplanationCard({ state }: { state: ExplainState | null }) {
  if (!state) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Explanation</CardTitle>
      </CardHeader>
      {/* aria-busy while streaming so screen readers announce once, when done. */}
      <CardContent aria-live="polite" aria-busy={state.streaming}>
        {/* A mid-stream failure keeps whatever text already arrived — wiping
            prose the user was reading over a network blip is worse than an
            error line under a truncated explanation. */}
        {(state.text || !state.error) && (
          <p className="whitespace-pre-wrap break-words">
            {state.text}
            {state.streaming && (
              <span className="animate-pulse">
                {state.text ? "▍" : "Thinking…"}
              </span>
            )}
          </p>
        )}
        {state.error && (
          <p className="mt-1 text-xs text-red-600">
            {state.text
              ? `The explanation was cut off: ${state.error}`
              : `Explanation failed: ${state.error}`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
