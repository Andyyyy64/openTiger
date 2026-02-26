import React from "react";
import { BrailleSpinner } from "../BrailleSpinner";

interface ExecutionStatusCardProps {
  content: string;
  metadata?: Record<string, unknown> | null;
}

export const ExecutionStatusCard: React.FC<ExecutionStatusCardProps> = ({
  content,
  metadata,
}) => {
  const repoMode = (metadata?.repoMode as string) || "local-git";

  return (
    <div className="py-2 px-3">
      <div className="border border-zinc-700 bg-zinc-900/50 p-3">
        <div className="flex items-center gap-2">
          <BrailleSpinner variant="pendulum" width={4} className="[color:inherit]" />
          <span className="text-term-tiger text-xs font-bold uppercase tracking-wider">
            EXECUTION
          </span>
          <span className="text-zinc-600 text-xs ml-auto">
            mode: {repoMode}
          </span>
        </div>
        <div className="text-zinc-400 text-xs mt-2 whitespace-pre-wrap">
          {content}
        </div>
      </div>
    </div>
  );
};
