// Merged status object for the agent-hands server.

import type { SurfaceDescriptor, SurfaceStatus } from "./types.js";

export interface ServerStatus {
  server: string;
  version: string;
  surfaces: Record<string, SurfaceStatus & { available: boolean }>;
  [key: string]: unknown;
}

export async function buildStatus(
  surfaces: SurfaceDescriptor[],
  version: string
): Promise<ServerStatus> {
  const result: ServerStatus = {
    server: "agent-hands",
    version,
    surfaces: {},
  };
  for (const s of surfaces) {
    const available = await Promise.resolve(s.isAvailable()).catch(() => false);
    const surfaceStatus = s.status
      ? await Promise.resolve(s.status()).catch(() => ({}))
      : {};
    result.surfaces[s.name] = { available, ...surfaceStatus };
  }
  return result;
}
