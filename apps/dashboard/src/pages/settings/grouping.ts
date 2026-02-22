import {
  FIELD_DISPLAY_ORDER_BY_GROUP,
  GROUP_DISPLAY_ORDER,
  SETTINGS,
  type SettingField,
} from "./constants";

const GROUP_ORDER_INDEX = new Map<string, number>(
  GROUP_DISPLAY_ORDER.map((group, index) => [group, index]),
);
const SETTING_KEY_INDEX = new Map<string, number>(
  SETTINGS.map((field, index) => [field.key, index]),
);

const sortFieldsInGroup = (group: string, fields: SettingField[]): SettingField[] => {
  const customOrder = FIELD_DISPLAY_ORDER_BY_GROUP[group] ?? [];
  const customIndex = new Map(customOrder.map((key, index) => [key, index]));
  return [...fields].sort((a, b) => {
    const aCustom = customIndex.get(a.key);
    const bCustom = customIndex.get(b.key);
    if (aCustom !== undefined || bCustom !== undefined) {
      return (aCustom ?? Number.MAX_SAFE_INTEGER) - (bCustom ?? Number.MAX_SAFE_INTEGER);
    }
    return (SETTING_KEY_INDEX.get(a.key) ?? 0) - (SETTING_KEY_INDEX.get(b.key) ?? 0);
  });
};

const buildGroupedSettings = (): [string, SettingField[]][] => {
  const entries = new Map<string, SettingField[]>();
  for (const field of SETTINGS) {
    if (!entries.has(field.group)) {
      entries.set(field.group, []);
    }
    entries.get(field.group)?.push(field);
  }

  return Array.from(entries.entries())
    .sort((a, b) => {
      const aRank = GROUP_ORDER_INDEX.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
      const bRank = GROUP_ORDER_INDEX.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
      if (aRank !== bRank) {
        return aRank - bRank;
      }
      return a[0].localeCompare(b[0]);
    })
    .map(
      ([group, fields]) => [group, sortFieldsInGroup(group, fields)] as [string, SettingField[]],
    );
};

// Display order is fixed, so build only once at initialization
export const GROUPED_SETTINGS = buildGroupedSettings();
