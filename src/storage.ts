import { EMPTY_PANEL } from "~/constants";
import { sanitizeSettings } from "~/settings";
import type { PanelState, Settings } from "~/types";

type Store = {
  panel: PanelState;
  settings: Settings;
  fastRefreshLeft: number;
};

export const read = async <K extends keyof Store>(key: K): Promise<Store[K] | undefined> => {
  const items = await chrome.storage.local.get(key);
  return items[key] as Store[K] | undefined;
};

export const write = (items: Partial<Store>) => chrome.storage.local.set(items);

export const readPanel = async () => (await read("panel")) ?? EMPTY_PANEL;

export const readSettings = async () => sanitizeSettings(await read("settings"));
