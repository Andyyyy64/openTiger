import React from "react";

type SettingsHeaderProps = {
  isSaving: boolean;
  hasUnsavedChanges: boolean;
  onSave: () => void;
};

export const SettingsHeader: React.FC<SettingsHeaderProps> = ({
  isSaving,
  hasUnsavedChanges,
  onSave,
}) => {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-xl font-bold uppercase tracking-widest text-term-tiger font-pixel">
          &gt; System_Configuration
        </h1>
        <p
          className={`text-xs mt-1 font-mono ${
            hasUnsavedChanges ? "text-amber-400" : "text-zinc-500"
          }`}
        >
          {hasUnsavedChanges
            ? "// Unsaved changes. Click SAVE below to apply. Restart required for active processes."
            : "// Edit fields below, then click SAVE to apply. Restart required for active processes."}
        </p>
      </div>
      <button
        onClick={onSave}
        disabled={isSaving}
        className={`border px-4 py-2 text-sm font-bold uppercase transition-colors disabled:opacity-50 ${
          hasUnsavedChanges
            ? "border-amber-500 bg-amber-500/10 text-amber-400 hover:bg-amber-500 hover:text-black"
            : "border-term-tiger text-term-tiger hover:bg-term-tiger hover:text-black"
        }`}
      >
        {isSaving ? "[ SAVING... ]" : "[ SAVE ]"}
      </button>
    </div>
  );
};
