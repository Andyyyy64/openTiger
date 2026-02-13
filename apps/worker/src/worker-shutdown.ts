import { createTaskWorker } from "@openTiger/queue";
import { markAgentOffline, recoverInterruptedAgentRuns } from "./worker-agent-state";

export function setupWorkerShutdownHandlers(params: {
  agentId: string;
  heartbeatTimer: NodeJS.Timeout;
  getQueueWorker: () => ReturnType<typeof createTaskWorker> | null;
}): () => void {
  const { agentId, heartbeatTimer, getQueueWorker } = params;
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.warn(`[Shutdown] ${agentId} received ${signal}. Draining worker...`);

    clearInterval(heartbeatTimer);
    const hardExitTimer = setTimeout(() => {
      console.error(`[Shutdown] ${agentId} forced exit after timeout`);
      process.exit(1);
    }, 15000);
    hardExitTimer.unref();

    try {
      const queueWorker = getQueueWorker();
      if (queueWorker) {
        // STOP要求時は実行中ジョブの完了待ちをせず、即時に終了して再キューへ回す
        await queueWorker.close(true);
      }
    } catch (error) {
      console.error(`[Shutdown] Failed to close queue worker for ${agentId}:`, error);
    }

    try {
      const recovered = await recoverInterruptedAgentRuns(agentId);
      if (recovered > 0) {
        console.warn(`[Shutdown] Requeued ${recovered} interrupted run(s) for ${agentId}`);
      }
    } catch (error) {
      console.error(`[Shutdown] Failed to recover interrupted runs for ${agentId}:`, error);
    }

    try {
      await markAgentOffline(agentId);
    } catch (error) {
      console.error(`[Shutdown] Failed to mark ${agentId} offline:`, error);
    }

    clearTimeout(hardExitTimer);
    process.exit(0);
  };

  const listeners = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map((signal) => {
    const listener = () => {
      void shutdown(signal);
    };
    process.on(signal, listener);
    return { signal, listener };
  });

  return () => {
    for (const { signal, listener } of listeners) {
      process.off(signal, listener);
    }
  };
}
