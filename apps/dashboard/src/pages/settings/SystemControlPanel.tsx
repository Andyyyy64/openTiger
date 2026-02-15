import React from "react";
import { BrailleSpinner } from "../../components/BrailleSpinner";

type SimpleActionState = {
  isPending: boolean;
  isSuccess: boolean;
  onAction: () => void;
};

type StopAllActionState = SimpleActionState & {
  successMessage?: string;
};

type SystemControlPanelProps = {
  cleanup: SimpleActionState;
  stopAll: StopAllActionState;
};

export const SystemControlPanel: React.FC<SystemControlPanelProps> = ({ cleanup, stopAll }) => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
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
            className="w-full border border-red-900 text-red-500 hover:bg-red-900 hover:text-white py-2 text-xs uppercase transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {cleanup.isPending && (
              <BrailleSpinner variant="compress" width={6} className="[color:inherit]" />
            )}
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
            className="w-full border border-orange-900 text-orange-500 hover:bg-orange-900 hover:text-white py-2 text-xs uppercase transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {stopAll.isPending && (
              <BrailleSpinner variant="compress" width={6} className="[color:inherit]" />
            )}
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
