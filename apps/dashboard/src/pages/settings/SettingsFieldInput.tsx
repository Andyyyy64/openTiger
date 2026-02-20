import React from "react";
import type { SettingField } from "./constants";

type SettingsFieldInputProps = {
  field: SettingField;
  value: string;
  onChange: (value: string) => void;
  pluginOptions?: string[];
};

function parseCsvList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export const SettingsFieldInput: React.FC<SettingsFieldInputProps> = ({
  field,
  value,
  onChange,
  pluginOptions = [],
}) => {
  if (field.key === "ENABLED_PLUGINS") {
    const selected = parseCsvList(value);
    const selectedSet = new Set(selected);
    const extraSelected = selected.filter((id) => !pluginOptions.includes(id));

    const togglePlugin = (pluginId: string) => {
      if (selectedSet.has(pluginId)) {
        onChange(selected.filter((id) => id !== pluginId).join(","));
        return;
      }
      onChange([...selected, pluginId].join(","));
    };

    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => onChange("")}
          className="w-full border border-term-border px-2 py-1 text-left text-xs font-mono hover:bg-term-fg hover:text-black transition-colors"
        >
          {selected.length === 0
            ? "[x] Use all registered plugins"
            : "[ ] Use all registered plugins"}
        </button>
        {pluginOptions.length > 0 ? (
          <div className="space-y-1 border border-term-border p-2">
            {pluginOptions.map((pluginId) => {
              const checked = selectedSet.has(pluginId);
              return (
                <label
                  key={pluginId}
                  className="flex items-center gap-2 text-xs font-mono cursor-pointer select-none"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => togglePlugin(pluginId)}
                    className="accent-term-tiger"
                  />
                  <span>{pluginId}</span>
                </label>
              );
            })}
          </div>
        ) : (
          <div className="text-[10px] text-zinc-500">No plugin candidates found from /plugins.</div>
        )}
        {extraSelected.length > 0 && (
          <div className="text-[10px] text-yellow-400 break-all">
            Unknown IDs in current value: {extraSelected.join(", ")}
          </div>
        )}
      </div>
    );
  }

  if (field.type === "boolean") {
    const normalized = value.toLowerCase() === "true" ? "true" : "false";
    return (
      <select
        className="w-full bg-black border border-term-border text-sm text-term-fg px-2 py-1 font-mono focus:border-term-tiger focus:outline-none"
        value={normalized}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="true">TRUE</option>
        <option value="false">FALSE</option>
      </select>
    );
  }

  if (field.type === "select" && field.options) {
    return (
      <select
        className="w-full bg-black border border-term-border text-sm text-term-fg px-2 py-1 font-mono focus:border-term-tiger focus:outline-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="" disabled>
          -- SELECT --
        </option>
        {field.options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      type={field.type === "number" ? "number" : "text"}
      className="w-full bg-black border border-term-border text-sm text-term-fg px-2 py-1 font-mono focus:border-term-tiger focus:outline-none"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
};
