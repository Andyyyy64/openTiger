import React from "react";
import { FIELD_HELP_LINKS, isSettingRequired, type SettingField } from "./constants";
import { SettingsFieldInput } from "./SettingsFieldInput";

type SettingsConfigSectionsProps = {
  grouped: [string, SettingField[]][];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  fieldWarnings?: Partial<Record<string, string>>;
};

export const SettingsConfigSections: React.FC<SettingsConfigSectionsProps> = ({
  grouped,
  values,
  onChange,
  fieldWarnings,
}) => {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 text-[10px] uppercase font-mono text-zinc-500">
        <span className="text-yellow-400">required</span>
        <span>/</span>
        <span className="text-zinc-600">optional</span>
      </div>
      {grouped.map(([group, fields]) => (
        <section key={group} className="border border-term-border p-0">
          <div className="bg-term-border/10 px-4 py-2 border-b border-term-border">
            <h2 className="text-sm font-bold uppercase tracking-wider">
              Config_Section: [{group}]
            </h2>
          </div>

          <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
            {fields.map((field) => {
              const isRequired = isSettingRequired(field.key, values);
              const isMissing = isRequired && !(values[field.key] ?? "").trim();
              const helpLink = FIELD_HELP_LINKS[field.key];
              const fieldWarning = fieldWarnings?.[field.key];

              return (
                <div key={field.key} className="space-y-1">
                  <div className="flex justify-between items-baseline mb-1">
                    <label className="text-xs text-term-tiger font-mono">{field.label}</label>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-zinc-600 uppercase">{field.type}</span>
                      <span
                        className={`text-[10px] uppercase ${
                          isRequired
                            ? isMissing
                              ? "text-red-400"
                              : "text-yellow-400"
                            : "text-zinc-600"
                        }`}
                      >
                        {isRequired ? "required" : "optional"}
                      </span>
                    </div>
                  </div>

                  <SettingsFieldInput
                    field={field}
                    value={values[field.key] ?? ""}
                    onChange={(value) => onChange(field.key, value)}
                  />
                  <div className="text-[10px] text-zinc-600 truncate">{field.description}</div>
                  {fieldWarning && (
                    <div className="text-[10px] text-yellow-400 break-all">
                      &gt; {fieldWarning}
                    </div>
                  )}
                  {helpLink && (
                    <a
                      href={helpLink.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-block text-[10px] text-term-tiger hover:underline"
                    >
                      {helpLink.label}
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
};
