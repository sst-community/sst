import { Input, output } from "@pulumi/pulumi";
import { DurationMinutes, toSeconds } from "../../duration";

/**
 * The event source mapping settings for a subscription's `filters`: each
 * filter becomes a pattern, and a record is delivered when it matches one.
 */
export function filterCriteria(
  filters?: Input<Input<Record<string, any>>[]>,
) {
  if (!filters) return undefined;
  return {
    filters: output(filters).apply((filters) =>
      filters.map((filter) => ({ pattern: JSON.stringify(filter) })),
    ),
  };
}

/**
 * The event source mapping settings for a subscription's `batch`: how many
 * records to deliver at once, how long to wait for them, and whether the
 * function can report the ones that failed.
 */
export function batchSettings(
  batch?: Input<{
    size?: Input<number>;
    window?: Input<DurationMinutes>;
    partialResponses?: Input<boolean>;
  }>,
) {
  const settings = output(batch);
  return {
    batchSize: settings.apply((batch) => batch?.size ?? 10),
    maximumBatchingWindowInSeconds: settings.apply((batch) =>
      batch?.window ? toSeconds(batch.window) : 0,
    ),
    functionResponseTypes: settings.apply((batch) =>
      batch?.partialResponses ? ["ReportBatchItemFailures"] : [],
    ),
  };
}
