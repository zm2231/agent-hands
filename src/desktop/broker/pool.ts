import { BrokerSession } from "./session.js";
import type { BrokerComponents } from "./verify.js";

const IDLE_TIMEOUT_MS = 30_000;

let activeSession: BrokerSession | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let activeLeases = 0;
let creationPromise: Promise<BrokerSession> | null = null;
let poolGeneration = 0;
let currentGeneration = 0;

function clearIdle(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdle(): void {
  clearIdle();
  if (activeLeases > 0) return;
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    if (activeSession && activeLeases === 0) {
      const session = activeSession;
      activeSession = null;
      await session.close().catch(() => {});
    }
  }, IDLE_TIMEOUT_MS);
}

function evictSession(session: BrokerSession): void {
  if (activeSession === session) {
    clearIdle();
    activeSession = null;
    currentGeneration++;
    activeLeases = 0;
  }
}

export interface SessionLease {
  session: BrokerSession;
  release(): void;
}

export async function acquireSession(components: BrokerComponents): Promise<SessionLease> {
  clearIdle();

  if (activeSession?.isAlive) {
    activeLeases++;
    const gen = currentGeneration;
    let released = false;
    return {
      session: activeSession,
      release: () => {
        if (released || gen !== currentGeneration) return;
        released = true;
        activeLeases = Math.max(0, activeLeases - 1);
        if (activeLeases === 0) scheduleIdle();
      },
    };
  }

  if (activeSession) {
    await activeSession.close().catch(() => {});
    activeSession = null;
  }

  if (!creationPromise) {
    const gen = poolGeneration;
    const pending = (async () => {
      const session = new BrokerSession(components);
      session.onClose = () => evictSession(session);
      await session.start();
      if (gen !== poolGeneration) {
        await session.close().catch(() => {});
        throw new Error("Pool was closed during session creation.");
      }
      return session;
    })();

    creationPromise = pending;

    pending.then(
      (session) => {
        if (creationPromise === pending) {
          activeSession = session;
          creationPromise = null;
        } else {
          session.close().catch(() => {});
        }
      },
      () => {
        if (creationPromise === pending) creationPromise = null;
      },
    );
  }

  const session = await creationPromise;
  activeLeases++;
  const gen = currentGeneration;
  let released = false;
  return {
    session,
    release: () => {
      if (released || gen !== currentGeneration) return;
      released = true;
      activeLeases = Math.max(0, activeLeases - 1);
      if (activeLeases === 0) scheduleIdle();
    },
  };
}

export async function closePool(): Promise<void> {
  clearIdle();
  poolGeneration++;
  currentGeneration++;
  activeLeases = 0;

  const capturedSession = activeSession;
  activeSession = null;

  const pending = creationPromise;
  creationPromise = null;

  if (pending) {
    try {
      const session = await pending;
      await session.close().catch(() => {});
    } catch {}
  }

  if (capturedSession) {
    await capturedSession.close().catch(() => {});
  }
}

export { IDLE_TIMEOUT_MS };
