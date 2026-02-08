import React from "react";
import type { SettingField } from "./constants";
import { SettingsFieldInput } from "./SettingsFieldInput";

type SettingsConfigSectionsProps = {
  grouped: [string, SettingField[]][];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
};

export const SettingsConfigSections: React.FC<SettingsConfigSectionsProps> = ({
  grouped,
  values,
  onChange,
}) => {
  return (
    <div className="space-y-6">
      {grouped.map(([group, fields]) => (
        <section key={group} className="border border-term-border p-0">
          <div className="bg-term-border/10 px-4 py-2 border-b border-term-border">
            <h2 className="text-sm font-bold uppercase tracking-wider">
              Config_Section: [{group}]
            </h2>
          </div>

          <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
            {fields.map((field) => (
              <div key={field.key} className="space-y-1">
                <div className="flex justify-between items-baseline mb-1">
                  <label className="text-xs text-term-tiger font-mono">{field.label}</label>
                  <span className="text-[10px] text-zinc-600 uppercase">{field.type}</span>
                </div>

                <SettingsFieldInput
                  field={field}
                  value={values[field.key] ?? ""}
                  onChange={(value) => onChange(field.key, value)}
                />
                <div className="text-[10px] text-zinc-600 truncate">{field.description}</div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
};
