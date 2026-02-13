import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  judgementsApi,
  type JudgementEvent,
  type JudgementPayload,
} from "../lib/api";
import { getCiStatusColor } from "../ui/status";

export const JudgementsPage: React.FC = () => {
  const {
    data: judgements,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["judgements"],
    queryFn: () => judgementsApi.list({ limit: 80, includeRecovery: true }),
  });

  return (
    <div className="p-6 text-term-fg">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-xl font-bold uppercase tracking-widest text-term-tiger font-pixel">
          &gt; Judge_Audit_Log
        </h1>
        <span className="text-xs text-zinc-500">
          {isLoading ? "Scanning..." : `${judgements?.length ?? 0} EVENTS LOGGED`}
        </span>
      </div>

      {isLoading && (
        <div className="text-center text-zinc-500 py-12 font-mono animate-pulse">
          &gt; Retrieving audit logs...
        </div>
      )}
      {error && (
        <div className="text-center text-red-500 py-12 font-mono">
          &gt; ERROR: Failed to load logs
        </div>
      )}

      <div className="space-y-6">
        {(judgements ?? []).length === 0 && !isLoading && !error && (
          <div className="text-center text-zinc-500 py-12 font-mono">
            &gt; No judgement events recorded
          </div>
        )}

        {(judgements ?? []).map((event) =>
          isJudgeReviewEvent(event) ? (
            <JudgementCard key={event.id} event={event} />
          ) : isPolicyRecoveryEvent(event) ? (
            <PolicyRecoveryCard key={event.id} event={event} />
          ) : null,
        )}
      </div>
    </div>
  );
};

const JudgementCard = ({
  event,
}: {
  event: JudgementEvent & { type: "judge.review"; payload: JudgementPayload | null };
}) => {
  const payload = event.payload ?? {};
  const verdict = normalizeLegacyVerdict(payload.verdict ?? "unknown");
  const actions = payload.actions ?? {};
  const ciStatus =
    payload.summary?.ci?.status ?? (payload.summary?.ci?.pass ? "success" : "unknown");
  const policyPass = payload.summary?.policy?.pass;
  const llmPass = payload.summary?.llm?.pass;
  const llmConfidence = payload.summary?.llm?.confidence;
  const codeIssueCount = payload.summary?.llm?.codeIssues?.length ?? 0;
  const violations = payload.summary?.policy?.violations ?? [];
  const prNumber = payload.prNumber;
  const prUrl = payload.prUrl;
  const [showDiff, setShowDiff] = React.useState(false);

  const {
    data: diffData,
    isLoading: isDiffLoading,
    error: diffError,
  } = useQuery({
    queryKey: ["judgements", event.id, "diff"],
    queryFn: () => judgementsApi.diff(event.id),
    enabled: showDiff,
  });
  const diffErrorMessage =
    diffError instanceof Error ? diffError.message : "Could not retrieve diff data.";

  return (
    <section className="border border-term-border p-0 font-mono">
      {/* Event Header */}
      <div className="bg-term-border/10 px-4 py-2 border-b border-term-border flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-4 text-xs">
          <span className="text-zinc-500">{new Date(event.createdAt).toLocaleString()}</span>
          <div className={`font-bold ${getVerdictColor(verdict)}`}>[{verdict.toUpperCase()}]</div>

          <div className="flex items-center gap-2 text-zinc-400">
            <span>TASK:</span>
            <Link to={`/tasks/${event.taskId}`} className="text-term-tiger hover:underline">
              {event.taskId.slice(0, 8)}
            </Link>
          </div>

          {payload.runId && (
            <div className="flex items-center gap-2 text-zinc-500">
              <span>RUN:</span>
              <Link to={`/runs/${payload.runId}`} className="hover:text-zinc-300 hover:underline">
                {payload.runId.slice(0, 8)}
              </Link>
            </div>
          )}
        </div>

        <div className="flex gap-4 text-xs">
          <div className={`${getCiStatusColor(ciStatus)}`}>CI:{ciStatus.toUpperCase()}</div>
          <div className={policyPass ? "text-term-tiger" : "text-red-500"}>
            POLICY:{policyPass ? "PASS" : "FAIL"}
          </div>
          <div className={llmPass ? "text-term-tiger" : "text-yellow-500"}>
            LLM:{llmPass ? "PASS" : "REV"}
          </div>
        </div>
      </div>

      {/* Info Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 divide-y lg:divide-y-0 lg:divide-x divide-term-border text-xs">
        {/* Merge Info */}
        <div className="p-4 space-y-2">
          <div className="text-zinc-500 uppercase font-bold tracking-wider mb-2">Merge_Status</div>
          <div className="grid grid-cols-[100px_1fr] gap-1">
            <span className="text-zinc-500">AUTO_MERGE</span>
            <span>{payload.autoMerge ? "TRUE" : "FALSE"}</span>

            <span className="text-zinc-500">PR_LINK</span>
            <span>
              {prNumber ? (
                prUrl ? (
                  <a
                    href={prUrl}
                    className="text-blue-400 hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    #{prNumber}
                  </a>
                ) : (
                  <span>#{prNumber}</span>
                )
              ) : (
                <span className="text-zinc-600">N/A</span>
              )}
            </span>

            <span className="text-zinc-500">ACTIONS</span>
            <span>
              {[
                actions.commented && "COMMENTED",
                actions.approved && "APPROVED",
                actions.merged && "MERGED",
              ]
                .filter(Boolean)
                .join(", ") || "NONE"}
            </span>

            {payload.mergeResult && (
              <>
                <span className="text-zinc-500">LOCAL_MERGE</span>
                <span className={payload.mergeResult.success ? "text-term-tiger" : "text-red-500"}>
                  {payload.mergeResult.success ? "SUCCESS" : "FAILED"}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Evaluation Metrics */}
        <div className="p-4 space-y-2">
          <div className="text-zinc-500 uppercase font-bold tracking-wider mb-2">Metrics</div>
          <div className="grid grid-cols-[120px_1fr] gap-1">
            <span className="text-zinc-500">CONFIDENCE</span>
            <span>
              {typeof llmConfidence === "number" ? `${Math.round(llmConfidence * 100)}%` : "N/A"}
            </span>

            <span className="text-zinc-500">ISSUES</span>
            <span>{codeIssueCount} detected</span>

            <span className="text-zinc-500">VIOLATIONS</span>
            <span className={violations.length > 0 ? "text-red-500" : "text-zinc-400"}>
              {violations.length}
            </span>
          </div>
        </div>

        {/* Notes/Summary */}
        <div className="p-4 space-y-2">
          <div className="text-zinc-500 uppercase font-bold tracking-wider mb-2">Notes</div>
          {payload.reasons?.length || payload.suggestions?.length ? (
            <ul className="list-disc list-inside text-zinc-400 space-y-1">
              {payload.reasons?.map((r, i) => (
                <li key={`r-${i}`}>{r}</li>
              ))}
              {payload.suggestions?.map((s, i) => (
                <li key={`s-${i}`} className="text-yellow-500/80">
                  {s}
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-zinc-600 italic">// No notes recorded</div>
          )}
        </div>
      </div>

      {/* Diff Toggle Bar */}
      <div className="border-t border-term-border bg-term-border/5 px-4 py-2">
        <button
          onClick={() => setShowDiff(!showDiff)}
          className="text-xs text-zinc-400 hover:text-term-fg flex items-center gap-2 hover:underline"
        >
          {showDiff ? "[-] HIDE_DIFF" : "[+] SHOW_DIFF"}
          <span className="text-zinc-600 ml-2">(Judge: {event.agentId ?? "system"})</span>
        </button>
      </div>

      {/* Diff Viewer */}
      {showDiff && (
        <div className="border-t border-term-border p-4 bg-black">
          <div className="mb-2 text-xs text-zinc-500 flex justify-between">
            <span>SOURCE: {diffData?.source || "unknown"}</span>
            {diffData?.truncated && <span className="text-yellow-500">[ TRUNCATED ]</span>}
          </div>

          {isDiffLoading ? (
            <div className="text-zinc-500 text-xs animate-pulse">&gt; Fetching diff...</div>
          ) : diffError ? (
            <div className="text-red-500 text-xs">&gt; ERR: {diffErrorMessage}</div>
          ) : (
            <pre className="text-xs text-zinc-300 whitespace-pre-wrap overflow-x-auto">
              {diffData?.diff || "// No diff available"}
            </pre>
          )}
        </div>
      )}
    </section>
  );
};

const PolicyRecoveryCard = ({
  event,
}: {
  event: JudgementEvent & {
    type: "task.policy_recovery_decided" | "task.policy_recovery_applied" | "task.policy_recovery_denied";
    payload: JudgementPayload | null;
  };
}) => {
  const payload = event.payload ?? {};
  const decisionSummary = payload.decisionSummary ?? {};
  const violatingPaths = payload.violatingPaths ?? [];
  const allowedPaths = payload.allowedPaths ?? [];
  const discardedPaths = payload.discardedPaths ?? payload.discardPaths ?? [];
  const deniedPaths = payload.denyPaths ?? [];
  const eventLabel =
    event.type === "task.policy_recovery_applied"
      ? "RECOVERY_APPLIED"
      : event.type === "task.policy_recovery_denied"
        ? "RECOVERY_DENIED"
        : "RECOVERY_DECIDED";
  const eventColor =
    event.type === "task.policy_recovery_applied"
      ? "text-term-tiger"
      : event.type === "task.policy_recovery_denied"
        ? "text-red-500"
        : "text-yellow-500";

  return (
    <section className="border border-term-border p-0 font-mono">
      <div className="bg-term-border/10 px-4 py-2 border-b border-term-border flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-4 text-xs">
          <span className="text-zinc-500">{new Date(event.createdAt).toLocaleString()}</span>
          <div className={`font-bold ${eventColor}`}>[{eventLabel}]</div>
          <div className="flex items-center gap-2 text-zinc-400">
            <span>TASK:</span>
            <Link to={`/tasks/${event.taskId}`} className="text-term-tiger hover:underline">
              {event.taskId.slice(0, 8)}
            </Link>
          </div>
        </div>
        <div className="text-xs text-zinc-500">AGENT: {event.agentId ?? "system"}</div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 divide-y lg:divide-y-0 lg:divide-x divide-term-border text-xs">
        <div className="p-4 space-y-2">
          <div className="text-zinc-500 uppercase font-bold tracking-wider mb-2">Decision</div>
          <div className="grid grid-cols-[110px_1fr] gap-1">
            <span className="text-zinc-500">ATTEMPT</span>
            <span>{payload.attempt ?? "-"}</span>
            <span className="text-zinc-500">ACTION</span>
            <span>{payload.action ?? "n/a"}</span>
            <span className="text-zinc-500">MODEL</span>
            <span>{payload.model ?? "n/a"}</span>
            <span className="text-zinc-500">LATENCY</span>
            <span>{typeof payload.latencyMs === "number" ? `${payload.latencyMs} ms` : "n/a"}</span>
            <span className="text-zinc-500">CONFIDENCE</span>
            <span>{typeof payload.confidence === "number" ? `${Math.round(payload.confidence * 100)}%` : "n/a"}</span>
            <span className="text-zinc-500">SUMMARY</span>
            <span className="wrap-break-word">{payload.recoverySummary ?? "n/a"}</span>
          </div>
        </div>

        <div className="p-4 space-y-2">
          <div className="text-zinc-500 uppercase font-bold tracking-wider mb-2">Summary</div>
          <div className="grid grid-cols-[110px_1fr] gap-1">
            <span className="text-zinc-500">VIOLATIONS</span>
            <span className={violatingPaths.length > 0 ? "text-red-500" : "text-zinc-400"}>
              {violatingPaths.length}
            </span>
            <span className="text-zinc-500">ALLOW</span>
            <span>{decisionSummary.allowCount ?? 0}</span>
            <span className="text-zinc-500">DISCARD</span>
            <span>{decisionSummary.discardCount ?? 0}</span>
            <span className="text-zinc-500">DENY</span>
            <span>{decisionSummary.denyCount ?? 0}</span>
            <span className="text-zinc-500">DROPPED</span>
            <span>{decisionSummary.droppedCount ?? 0}</span>
          </div>
        </div>

        <div className="p-4 space-y-2">
          <div className="text-zinc-500 uppercase font-bold tracking-wider mb-2">
            Growth/Recovery Paths
          </div>
          {allowedPaths.length === 0 && discardedPaths.length === 0 && deniedPaths.length === 0 ? (
            <div className="text-zinc-600 italic">// No paths recorded</div>
          ) : (
            <div className="space-y-2">
              {allowedPaths.map((path, index) => (
                <div key={`allow-${event.id}-${index}`} className="text-term-tiger break-all">
                  + allow {path}
                </div>
              ))}
              {discardedPaths.map((path, index) => (
                <div key={`discard-${event.id}-${index}`} className="text-yellow-500 break-all">
                  - discard {path}
                </div>
              ))}
              {deniedPaths.map((path, index) => (
                <div key={`deny-${event.id}-${index}`} className="text-red-500 break-all">
                  ! deny {path}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
};

const getVerdictColor = (verdict: string) => {
  switch (verdict) {
    case "approve":
      return "text-term-tiger";
    case "request_changes":
      return "text-red-500";
    default:
      return "text-zinc-500";
  }
};

function normalizeLegacyVerdict(verdict: string): string {
  return verdict === "needs_human" ? "request_changes" : verdict;
}

function isJudgeReviewEvent(
  event: JudgementEvent,
): event is JudgementEvent & { type: "judge.review"; payload: JudgementPayload | null } {
  return event.type === "judge.review";
}

function isPolicyRecoveryEvent(
  event: JudgementEvent,
): event is JudgementEvent & {
  type: "task.policy_recovery_decided" | "task.policy_recovery_applied" | "task.policy_recovery_denied";
  payload: JudgementPayload | null;
} {
  return (
    event.type === "task.policy_recovery_decided" ||
    event.type === "task.policy_recovery_applied" ||
    event.type === "task.policy_recovery_denied"
  );
}
