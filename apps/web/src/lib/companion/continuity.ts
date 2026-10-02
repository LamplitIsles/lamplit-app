import type { ContextUsage, Compaction } from "@lamplit/contracts";
export type ContextPressureProjection = ContextUsage;
export type CompactionLifecycleState = NonNullable<Compaction>;
export interface ContextCapacity {
  readonly usedTokens: number;
  readonly contextWindow: number;
  readonly percentage: number;
}
/** Missing native usage renders an empty ring while known capacity is retained. */
export function resolveContextCapacity(
  value: ContextUsage | undefined,
): ContextCapacity {
  const usedTokens = value?.tokens ?? 0;
  const contextWindow = value?.capacity ?? 0;
  return {
    usedTokens,
    contextWindow,
    percentage:
      contextWindow > 0
        ? Math.min(100, Math.round((usedTokens / contextWindow) * 100))
        : 0,
  };
}

/** Round a token estimate to a quiet, human-scale value for Companion copy. */
export function roundTokenEstimate(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return undefined;
  const unit = value >= 1_000 ? 1_000 : 100;
  return Math.round(value / unit) * unit;
}

/** Format an already-validated token count for the compact capacity display. */
export function formatTokenCount(value: unknown): string | undefined {
  const rounded = roundTokenEstimate(value);
  if (rounded === undefined) return undefined;
  if (rounded >= 1_000) return `${Math.round(rounded / 1_000)}k`;
  return String(rounded);
}

export interface ContinuityRecord {
  readonly id: string;
  /** Stable source contribution key used by the canonical message-unit projection. */
  readonly messageKey: string;
  readonly kind: "continuity";
  readonly side: "incoming";
  readonly tone: "success";
  readonly compactionId: string;
  readonly text: string;
  readonly time?: number;
  readonly anchorSeq: number;
}
