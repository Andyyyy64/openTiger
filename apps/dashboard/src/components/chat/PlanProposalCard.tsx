import React from "react";

interface PlanProposalCardProps {
  content: string;
  onConfirm?: () => void;
}

export const PlanProposalCard: React.FC<PlanProposalCardProps> = ({ content, onConfirm }) => {
  return (
    <div className="py-2 px-3">
      <div className="border border-term-tiger/30 bg-term-tiger/5 p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-term-tiger text-xs font-bold uppercase tracking-wider">
            TASK PLAN
          </span>
        </div>
        <div className="text-zinc-300 whitespace-pre-wrap break-words text-sm mb-4">
          {content}
        </div>
        {onConfirm && (
          <div className="flex gap-3">
            <button
              onClick={onConfirm}
              className="bg-term-tiger text-black px-4 py-1.5 text-xs font-bold uppercase hover:opacity-90"
            >
              CONFIRM PLAN
            </button>
            <span className="text-zinc-600 text-xs self-center">
              or continue chatting to adjust
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
