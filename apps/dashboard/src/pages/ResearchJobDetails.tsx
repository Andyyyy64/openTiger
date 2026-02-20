import React from "react";
import { Link, useParams } from "react-router-dom";
import { BrailleSpinner } from "../components/BrailleSpinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { researchApi, type CreateResearchTaskInput } from "../lib/api";

export const ResearchJobDetailsPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [stage, setStage] = React.useState("collect");
  const [profile, setProfile] = React.useState<"low" | "mid" | "high" | "ultra">("mid");

  const { data, isLoading, error } = useQuery({
    queryKey: ["research", "jobs", id],
    queryFn: () => researchApi.getJob(id!),
    enabled: !!id,
    refetchInterval: 15000,
  });

  const createTaskMutation = useMutation({
    mutationFn: (payload: CreateResearchTaskInput) => researchApi.createTask(id!, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["research", "jobs"] });
      await queryClient.invalidateQueries({ queryKey: ["research", "jobs", id] });
    },
  });

  React.useEffect(() => {
    if (!data?.job.qualityProfile) {
      return;
    }
    setProfile(data.job.qualityProfile);
  }, [data?.job.qualityProfile]);

  if (isLoading) {
    return (
      <div className="p-8 text-center text-zinc-500 font-mono animate-pulse">
        &gt; Loading research job...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-8 text-center text-red-500 font-mono">&gt; Failed to load research job</div>
    );
  }

  const latestReport = data.reports[0];
  const orchestratorStage = (() => {
    const metadata = data.job.metadata;
    if (!metadata || typeof metadata !== "object") {
      return "-";
    }
    const orchestrator = metadata.orchestrator as Record<string, unknown> | undefined;
    const stage = orchestrator?.stage;
    return typeof stage === "string" && stage.trim().length > 0 ? stage : "-";
  })();

  const createFollowupTask = () => {
    if (createTaskMutation.isPending) {
      return;
    }
    createTaskMutation.mutate({
      stage,
      profile,
      riskLevel: "medium",
      timeboxMinutes: 60,
    });
  };

  return (
    <div className="p-6 text-term-fg max-w-6xl mx-auto">
      <Link
        to="/plugins/tiger-research"
        className="inline-block text-xs text-zinc-500 hover:text-term-tiger mb-6"
      >
        &lt; back_to_research
      </Link>

      <div className="mb-8">
        <div className="text-xs uppercase text-zinc-500 mb-2">Job ID: {data.job.id}</div>
        <h1 className="text-xl font-bold uppercase tracking-widest text-term-tiger font-pixel">
          &gt; {data.job.query}
        </h1>
        <div className="mt-2 text-xs text-zinc-400">
          status={data.job.status} updated={new Date(data.job.updatedAt).toLocaleString()}
        </div>
        <div className="mt-1 text-xs text-zinc-500">orchestrator_stage={orchestratorStage}</div>
      </div>

      <section className="border border-term-border mb-6">
        <div className="bg-term-border/10 border-b border-term-border px-4 py-2 text-xs uppercase text-zinc-500">
          Follow-up Stage
        </div>
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3 items-end">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Stage</label>
            <select
              value={stage}
              onChange={(event) => setStage(event.target.value)}
              className="w-full bg-black border border-term-border text-sm p-2 focus:outline-none focus:border-term-tiger"
            >
              <option value="plan">plan</option>
              <option value="collect">collect</option>
              <option value="challenge">challenge</option>
              <option value="write">write</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Strength</label>
            <select
              value={profile}
              onChange={(event) =>
                setProfile(event.target.value as "low" | "mid" | "high" | "ultra")
              }
              className="w-full bg-black border border-term-border text-sm p-2 focus:outline-none focus:border-term-tiger"
            >
              <option value="low">low</option>
              <option value="mid">mid</option>
              <option value="high">high</option>
              <option value="ultra">ultra</option>
            </select>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={createFollowupTask}
              disabled={createTaskMutation.isPending}
              className="text-term-tiger border border-term-tiger hover:bg-term-tiger hover:text-black disabled:opacity-50 px-4 py-2 text-xs font-bold uppercase flex items-center gap-2"
            >
              {createTaskMutation.isPending && (
                <BrailleSpinner variant="pendulum" width={6} className="text-inherit" />
              )}
              {createTaskMutation.isPending ? "[QUEUING]" : "[QUEUE_STAGE]"}
            </button>
            <span className="text-xs text-red-400">
              {createTaskMutation.error instanceof Error ? createTaskMutation.error.message : ""}
            </span>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <section className="border border-term-border">
          <div className="bg-term-border/10 border-b border-term-border px-4 py-2 text-xs uppercase text-zinc-500">
            Latest Report
          </div>
          <div className="p-4 text-sm">
            {latestReport ? (
              <>
                <div className="text-xs text-zinc-500 mb-2">
                  confidence={latestReport.confidence} created=
                  {new Date(latestReport.createdAt).toLocaleString()}
                </div>
                <p className="whitespace-pre-wrap text-zinc-200">{latestReport.summary}</p>
                {latestReport.limitations ? (
                  <div className="mt-3 text-xs text-yellow-300 whitespace-pre-wrap">
                    limitations: {latestReport.limitations}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="text-zinc-500">No reports generated yet.</div>
            )}
          </div>
        </section>

        <section className="border border-term-border">
          <div className="bg-term-border/10 border-b border-term-border px-4 py-2 text-xs uppercase text-zinc-500">
            Claims
          </div>
          <div className="max-h-[360px] overflow-auto divide-y divide-term-border">
            {data.claims.length === 0 ? (
              <div className="p-4 text-zinc-500 text-sm">No claims yet.</div>
            ) : (
              data.claims.map((claim) => (
                <div key={claim.id} className="p-4 text-sm">
                  <div className="text-xs text-zinc-500 mb-1">
                    stance={claim.stance} confidence={claim.confidence}
                  </div>
                  <div className="text-zinc-200 whitespace-pre-wrap">{claim.claimText}</div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      <section className="border border-term-border mb-6">
        <div className="bg-term-border/10 border-b border-term-border px-4 py-2 text-xs uppercase text-zinc-500">
          Evidence
        </div>
        <div className="max-h-[360px] overflow-auto divide-y divide-term-border">
          {data.evidence.length === 0 ? (
            <div className="p-4 text-zinc-500 text-sm">No evidence yet.</div>
          ) : (
            data.evidence.map((item) => (
              <div key={item.id} className="p-4 text-sm">
                <div className="text-xs text-zinc-500 mb-1">
                  reliability={item.reliability} stance={item.stance}
                </div>
                <div className="text-zinc-300 mb-1">{item.sourceTitle ?? "(untitled source)"}</div>
                {item.sourceUrl ? (
                  <a
                    href={item.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-400 hover:underline text-xs break-all"
                  >
                    {item.sourceUrl}
                  </a>
                ) : null}
                {item.snippet ? (
                  <p className="mt-2 text-zinc-400 whitespace-pre-wrap">{item.snippet}</p>
                ) : null}
              </div>
            ))
          )}
        </div>
      </section>

      <section className="border border-term-border">
        <div className="bg-term-border/10 border-b border-term-border px-4 py-2 text-xs uppercase text-zinc-500">
          Linked Tasks / Runs
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-term-border">
          <div className="p-4">
            <div className="text-xs text-zinc-500 mb-2">Tasks</div>
            <div className="space-y-2">
              {data.tasks.length === 0 ? (
                <div className="text-zinc-500 text-sm">No linked tasks</div>
              ) : (
                data.tasks.map((task) => (
                  <div key={task.id} className="text-sm">
                    <Link to={`/tasks/${task.id}`} className="text-term-tiger hover:underline">
                      {task.title}
                    </Link>
                    <div className="text-xs text-zinc-500">
                      status={task.status} role={task.role} kind={task.kind}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="p-4">
            <div className="text-xs text-zinc-500 mb-2">Runs</div>
            <div className="space-y-2">
              {data.runs.length === 0 ? (
                <div className="text-zinc-500 text-sm">No runs yet</div>
              ) : (
                data.runs.map((run) => (
                  <div key={run.id} className="text-sm">
                    <Link to={`/runs/${run.id}`} className="text-term-tiger hover:underline">
                      {run.id}
                    </Link>
                    <div className="text-xs text-zinc-500">
                      status={run.status} agent={run.agentId} started=
                      {new Date(run.startedAt).toLocaleString()}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
