import React from 'react';

type SettingsHeaderProps = {
  isSaving: boolean;
  onSave: () => void;
};

export const SettingsHeader: React.FC<SettingsHeaderProps> = ({ isSaving, onSave }) => {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-xl font-bold uppercase tracking-widest text-term-tiger font-pixel">
          &gt; System_Configuration
        </h1>
        <p className="text-xs text-zinc-500 mt-1 font-mono">
          {' // Changes saved to DB. Restart required for active processes.'}
        </p>
      </div>
      <button
        onClick={onSave}
        disabled={isSaving}
        className="border border-term-tiger text-term-tiger hover:bg-term-tiger hover:text-black px-4 py-2 text-sm font-bold uppercase transition-colors disabled:opacity-50"
      >
        {isSaving ? '[ SAVING... ]' : '[ SAVE_CONFIG ]'}
      </button>
    </div>
  );
};
