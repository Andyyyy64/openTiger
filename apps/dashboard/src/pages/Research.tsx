import React from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { researchApi, type CreateResearchJobInput } from "../lib/api";

const resolveStage = (metadata: Record<string, unknown> | null | undefined): string => {
  const orchestrator =
    metadata && typeof metadata === "object"
      ? (metadata.orchestrator as Record<string, unknown> | undefined)
      : undefined;
  const stage = orchestrator?.stage;
  return typeof stage === "string" && stage.trim().length > 0 ? stage : "-";
};

export const ResearchPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [query, setQuery] = React.useState("");

  const {
    data: jobs,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["research", "jobs"],
    queryFn: () => researchApi.listJobs({ limit: 80 }),
    refetchInterval: 15000,
  });

  const createMutation = useMutation({
    mutationFn: (payload: CreateResearchJobInput) => researchApi.createJob(payload),
    onSuccess: () => {
      setQuery("");
      void queryClient.invalidateQueries({ queryKey: ["research", "jobs"] });
    },
  });

  const deleteAllMutation = useMutation({
    mutationFn: () => researchApi.deleteAllJobs(),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["research", "jobs"] });
      console.log(`[Research] Deleted ${result.deleted} jobs, ${result.tasks} tasks`);
    },
  });

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || createMutation.isPending) {
      return;
    }

    createMutation.mutate({
      query: trimmed,
      riskLevel: "medium",
      timeboxMinutes: 90,
    });
  };

  return (
    <div className="p-6 text-term-fg">
      <div className="mb-8">
        <h1 className="text-xl font-bold uppercase tracking-widest text-term-tiger font-pixel">
          &gt; TigerResearch
        </h1>
        <p className="text-xs text-zinc-500 mt-2">
          Query-driven research jobs with claim/evidence/report artifacts.
        </p>
      </div>

      <section className="border border-term-border mb-8">
        <div className="bg-term-border/10 border-b border-term-border px-4 py-2 text-xs uppercase text-zinc-500">
          New Research Job
        </div>
        <form onSubmit={submit} className="p-4 space-y-3">
          <label className="block text-xs text-zinc-400">Query</label>
          <textarea
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-full min-h-[120px] bg-black border border-term-border text-sm p-3 focus:outline-none focus:border-term-tiger"
            placeholder="What should TigerResearch investigate?"
          />

          <div className="flex items-center justify-between">
            <div className="text-xs text-red-400">
              {createMutation.error instanceof Error ? createMutation.error.message : ""}
            </div>
            <button
              type="submit"
              disabled={createMutation.isPending || query.trim().length === 0}
              className="text-term-tiger border border-term-tiger hover:bg-term-tiger hover:text-black disabled:opacity-50 disabled:cursor-not-allowed px-4 py-1 text-xs font-bold uppercase transition-all"
            >
              {createMutation.isPending ? "[CREATING]" : "[CREATE_JOB]"}
            </button>
          </div>
        </form>
      </section>

      <section className="border border-term-border">
        <div className="bg-term-border/10 border-b border-term-border px-4 py-2 flex items-center justify-between">
          <span className="text-xs uppercase text-zinc-500">Jobs</span>
          <button
            type="button"
            disabled={deleteAllMutation.isPending || (jobs?.length ?? 0) === 0}
            onClick={() => {
              const count = jobs?.length ?? 0;
              if (count === 0) return;
              if (
                !window.confirm(
                  `Delete all ${count} research job(s) from DB? This cannot be undone.`,
                )
              )
                return;
              deleteAllMutation.mutate();
            }}
            className="text-red-400 hover:text-red-300 border border-red-800 hover:border-red-600 px-2 py-0.5 text-xs uppercase disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {deleteAllMutation.isPending ? "[CLEARING...]" : "[CLEAR_ALL]"}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-500 uppercase">
              <tr>
                <th className="px-4 py-2 font-normal border-b border-term-border">Query</th>
                <th className="px-4 py-2 font-normal border-b border-term-border">Status</th>
                <th className="px-4 py-2 font-normal border-b border-term-border">Stage</th>
                <th className="px-4 py-2 font-normal border-b border-term-border">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-term-border">
              {isLoading ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-zinc-500 animate-pulse">
                    &gt; Loading research jobs...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-red-500">
                    &gt; Failed to load research jobs
                  </td>
                </tr>
              ) : (jobs ?? []).length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-zinc-500">
                    &gt; No research jobs found
                  </td>
                </tr>
              ) : (
                jobs?.map((job) => (
                  <tr key={job.id} className="hover:bg-term-tiger/5">
                    <td className="px-4 py-2 align-top">
                      <Link
                        to={`/plugins/tiger-research/${job.id}`}
                        className="text-term-fg hover:text-term-tiger font-bold"
                      >
                        {job.query}
                      </Link>
                      <div className="text-[11px] text-zinc-600">{job.id}</div>
                    </td>
                    <td className="px-4 py-2 align-top text-zinc-300 uppercase text-xs">
                      {job.status}
                    </td>
                    <td className="px-4 py-2 align-top text-zinc-400 text-xs">
                      {resolveStage(job.metadata)}
                    </td>
                    <td className="px-4 py-2 align-top text-zinc-500">
                      {new Date(job.updatedAt).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
