// Focus telemetry: sample frontmost app before/during/after a call.

import { getFrontmostBundleId } from "./identity.js";

export interface FocusTelemetry {
  beforeFrontmost: string | null;
  afterFrontmost: string | null;
  targetBecameFrontmost: boolean;
  unrelatedFocusChanges: number;
  backgroundPreserved: boolean | null;
}

export function startFocusTelemetry(
  targetBundleId: string | null
): { finish(): Promise<FocusTelemetry>; stop: () => void } {
  let stopped = false;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  const samples: string[] = [];
  let beforeFrontmost: string | null = null;
  let beforeReady = false;

  const ready = getFrontmostBundleId().then((bid) => {
    beforeFrontmost = bid;
    beforeReady = true;
  }).catch(() => { beforeReady = true; });

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

  async function finish(): Promise<FocusTelemetry> {
    stop();
    if (!beforeReady) await ready;

    // Take the final sample AFTER the operation completes.
    const afterFrontmost = await getFrontmostBundleId().catch(() => null);

    const targetBecameFrontmost = targetBundleId
      ? samples.includes(targetBundleId) || afterFrontmost === targetBundleId
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
    };
  }

  return { finish, stop };
}
