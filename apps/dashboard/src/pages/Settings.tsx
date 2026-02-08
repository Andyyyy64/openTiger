import React, { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { configApi, systemApi } from "../lib/api";
import { SettingsHeader } from "./settings/SettingsHeader";
import { SystemControlPanel } from "./settings/SystemControlPanel";
import { SettingsConfigSections } from "./settings/SettingsConfigSections";
import { GROUPED_SETTINGS } from "./settings/grouping";

export const SettingsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["config"],
    queryFn: () => configApi.get(),
  });
  const restartQuery = useQuery({
    queryKey: ["system-restart"],
    queryFn: () => systemApi.restartStatus(),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 3000 : false),
  });

  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (data?.config) {
      setValues(data.config);
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: (updates: Record<string, string>) => configApi.update(updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] });
    },
  });

  const restartMutation = useMutation({
    mutationFn: () => systemApi.restart(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["system-restart"] });
    },
  });
  const cleanupMutation = useMutation({
    mutationFn: () => systemApi.cleanup(),
  });
  const isCleanupSuccess = cleanupMutation.isSuccess;
  const resetCleanup = cleanupMutation.reset;

  const stopAllProcessesMutation = useMutation({
    mutationFn: () => systemApi.stopAllProcesses(),
  });
  const isStopAllSuccess = stopAllProcessesMutation.isSuccess;
  const resetStopAll = stopAllProcessesMutation.reset;

  const grouped = GROUPED_SETTINGS;

  const handleSave = () => {
    mutation.mutate(values);
  };

  const updateValue = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const restartStatus = restartQuery.data?.status ?? "idle";
  const restartStatusLabel = restartStatus.toUpperCase();

  const formatTimestamp = (value?: string) =>
    value ? new Date(value).toLocaleTimeString() : "--:--:--";
  const restartPanel = {
    status: restartStatus,
    statusLabel: restartStatusLabel,
    startedAtLabel: formatTimestamp(restartQuery.data?.startedAt),
    finishedAtLabel: formatTimestamp(restartQuery.data?.finishedAt),
    errorMessage: restartQuery.data?.message,
    isPending: restartMutation.isPending,
    onRestart: () => restartMutation.mutate(),
  };
  const cleanupPanel = {
    isPending: cleanupMutation.isPending,
    isSuccess: cleanupMutation.isSuccess,
    onAction: () => cleanupMutation.mutate(),
  };
  const stopAllPanel = {
    isPending: stopAllProcessesMutation.isPending,
    isSuccess: stopAllProcessesMutation.isSuccess,
    onAction: () => stopAllProcessesMutation.mutate(),
    successMessage: stopAllProcessesMutation.data?.message,
  };
  useEffect(() => {
    if (!isCleanupSuccess) return;
    const timer = window.setTimeout(() => {
      resetCleanup();
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [isCleanupSuccess, resetCleanup]);

  useEffect(() => {
    if (!isStopAllSuccess) return;
    const timer = window.setTimeout(() => {
      resetStopAll();
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [isStopAllSuccess, resetStopAll]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6 text-term-fg">
      <SettingsHeader isSaving={mutation.isPending} onSave={handleSave} />

      {/* システム操作パネル */}
      <SystemControlPanel restart={restartPanel} cleanup={cleanupPanel} stopAll={stopAllPanel} />

      {isLoading && (
        <div className="text-center text-zinc-500 monitor-scan">&gt; Scanning configuration...</div>
      )}
      {error && <div className="text-center text-red-500">&gt; CONFIG LOAD ERROR</div>}

      <SettingsConfigSections grouped={grouped} values={values} onChange={updateValue} />
    </div>
  );
};
