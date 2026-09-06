// Focus telemetry: sample frontmost app before/during/after a call.

import { getFrontmostBundleId } from "./identity.js";

export interface FocusTelemetry {
  beforeFrontmost: string | null;
  afterFrontmost: string | null;
  targetBecameFrontmost: boolean;
  unrelatedFocusChanges: number;
  backgroundPreserved: boolean | null;
  stop(): void;
}

export function startFocusTelemetry(
  targetBundleId: string | null
): { telemetry: Promise<FocusTelemetry>; stop: () => void } {
  let stopped = false;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  const samples: string[] = [];
  let beforeFrontmost: string | null = null;

  const ready = getFrontmostBundleId().then((bid) => {
    beforeFrontmost = bid;
  });

  intervalHandle = setInterval(async () => {
    if (stopped) return;
    const bid = await getFrontmostBundleId().catch(() => null);
    if (bid) samples.push(bid);
  }, 100);

  function stop() {
    stopped = true;
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  const telemetry = (async (): Promise<FocusTelemetry> => {
    await ready;
    const afterFrontmost = await getFrontmostBundleId().catch(() => null);
    const targetBecameFrontmost = targetBundleId
      ? samples.includes(targetBundleId)
      : false;

    const uniqueApps = new Set(samples);
    if (targetBundleId) uniqueApps.delete(targetBundleId);
    if (beforeFrontmost) uniqueApps.delete(beforeFrontmost);
    const unrelatedFocusChanges = uniqueApps.size;

    const backgroundPreserved = targetBundleId
      ? !targetBecameFrontmost
      : null;

    return {
      beforeFrontmost,
      afterFrontmost,
      targetBecameFrontmost,
      unrelatedFocusChanges,
      backgroundPreserved,
      stop,
    };
  })();

  return { telemetry, stop };
}
