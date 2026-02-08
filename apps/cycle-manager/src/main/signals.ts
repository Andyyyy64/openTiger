import { endCurrentCycle, getCycleState } from "../cycle-controller";

type TimerSnapshot = {
  monitorTimer: ReturnType<typeof setInterval> | null;
  cleanupTimer: ReturnType<typeof setInterval> | null;
  statsTimer: ReturnType<typeof setInterval> | null;
};

// SIGINT/SIGTERMで安全に停止する
export function setupSignalHandlers(getTimers: () => TimerSnapshot): void {
  const shutdown = async (signal: string) => {
    console.log(`\n[Shutdown] Received ${signal}, stopping Cycle Manager...`);

    const timers = getTimers();
    if (timers.monitorTimer) clearInterval(timers.monitorTimer);
    if (timers.cleanupTimer) clearInterval(timers.cleanupTimer);
    if (timers.statsTimer) clearInterval(timers.statsTimer);

    // 現在のサイクルを終了
    const state = getCycleState();
    if (state.isRunning) {
      await endCurrentCycle("shutdown");
    }

    console.log("[Shutdown] Cycle Manager stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
