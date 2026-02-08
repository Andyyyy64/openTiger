import React from "react";

type RestartPanelState = {
  status: string;
  statusLabel: string;
  startedAtLabel: string;
  finishedAtLabel: string;
  errorMessage?: string;
  isPending: boolean;
  onRestart: () => void;
};

type SimpleActionState = {
  isPending: boolean;
  isSuccess: boolean;
  onAction: () => void;
};

type StopAllActionState = SimpleActionState & {
  successMessage?: string;
};

type SystemControlPanelProps = {
  restart: RestartPanelState;
  cleanup: SimpleActionState;
  stopAll: StopAllActionState;
};

export const SystemControlPanel: React.FC<SystemControlPanelProps> = ({
  restart,
  cleanup,
  stopAll,
}) => {
  const isRestartRunning = restart.status === "running";
  const isRestartBlocked = restart.isPending || isRestartRunning;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <section className="border border-term-border p-0">
        <div className="bg-term-border/10 px-4 py-2 border-b border-term-border flex justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider">System_Restart</h2>
          <span className="text-xs text-zinc-500">sudo reboot</span>
        </div>
        <div className="p-4 space-y-3 font-mono text-sm">
          <div className="flex justify-between items-center">
            <span className="text-zinc-500">CURRENT_STATUS</span>
            <span className={isRestartRunning ? "text-term-tiger animate-pulse" : "text-zinc-300"}>
              [{restart.statusLabel}]
            </span>
          </div>

          <div className="text-xs text-zinc-600 border-l border-zinc-800 pl-2">
            <div>STARTED: {restart.startedAtLabel}</div>
            <div>FINISHED: {restart.finishedAtLabel}</div>
          </div>

          <button
            onClick={restart.onRestart}
            disabled={isRestartBlocked}
            className="w-full border border-term-border hover:bg-term-fg hover:text-black py-2 mt-2 text-xs uppercase transition-colors disabled:opacity-50"
          >
            {isRestartBlocked ? "> REBOOTING..." : "> EXECUTE REBOOT"}
          </button>

          {restart.errorMessage && restart.status === "failed" && (
            <div className="text-red-500 text-xs mt-2">&gt; ERR: {restart.errorMessage}</div>
          )}
        </div>
      </section>

      <section className="border border-term-border p-0">
        <div className="bg-term-border/10 px-4 py-2 border-b border-term-border flex justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider">DB_Maintenance</h2>
          <span className="text-xs text-zinc-500">rm -rf /var/db/*</span>
        </div>
        <div className="p-4 space-y-3 font-mono text-sm">
          <div className="text-zinc-500 text-xs mb-2">
            {" // Purges all runtime data (plans, tasks, runs, events)."}
            <br />
            // Use with caution.
          </div>

          <button
            onClick={cleanup.onAction}
            disabled={cleanup.isPending}
            className="w-full border border-red-900 text-red-500 hover:bg-red-900 hover:text-white py-2 text-xs uppercase transition-colors disabled:opacity-50"
          >
            {cleanup.isPending ? "> PURGING..." : "> PURGE DATABASE"}
          </button>

          {cleanup.isSuccess && (
            <div className="text-term-tiger text-xs mt-2">&gt; SUCCESS: Database purged.</div>
          )}
        </div>
      </section>

      <section className="border border-term-border p-0">
        <div className="bg-term-border/10 px-4 py-2 border-b border-term-border flex justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wider">Process_Control</h2>
          <span className="text-xs text-zinc-500">killall -9</span>
        </div>
        <div className="p-4 space-y-3 font-mono text-sm">
          <div className="text-zinc-500 text-xs mb-2">
            {" // Stops all managed processes except UI and server."}
            <br />
            // Planner, Dispatcher, Judge, Workers, etc. will be stopped.
          </div>

          <button
            onClick={stopAll.onAction}
            disabled={stopAll.isPending}
            className="w-full border border-orange-900 text-orange-500 hover:bg-orange-900 hover:text-white py-2 text-xs uppercase transition-colors disabled:opacity-50"
          >
            {stopAll.isPending ? "> STOPPING..." : "> DELETE ALL PROCESSES"}
          </button>

          {stopAll.isSuccess && (
            <div className="text-term-tiger text-xs mt-2">
              &gt; SUCCESS: {stopAll.successMessage || "Processes stopped."}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
