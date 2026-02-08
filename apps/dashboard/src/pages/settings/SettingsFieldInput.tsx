import React from 'react';
import type { SettingField } from './constants';

type SettingsFieldInputProps = {
  field: SettingField;
  value: string;
  onChange: (value: string) => void;
};

export const SettingsFieldInput: React.FC<SettingsFieldInputProps> = ({ field, value, onChange }) => {
  if (field.type === 'boolean') {
    const normalized = value.toLowerCase() === 'true' ? 'true' : 'false';
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

  if (field.type === 'select' && field.options) {
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
      type={field.type === 'number' ? 'number' : 'text'}
      className="w-full bg-black border border-term-border text-sm text-term-fg px-2 py-1 font-mono focus:border-term-tiger focus:outline-none"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
};
