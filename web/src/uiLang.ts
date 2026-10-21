import { createContext, useContext } from "react";

import type { SupportedUiLang } from "./i18n.js";

export interface UiLangContextValue {
  readonly lang: SupportedUiLang;
  readonly dir: "rtl" | "ltr";
  readonly setLang: (lang: SupportedUiLang) => void;
  readonly toggleLang: () => void;
}

export const UiLangContext = createContext<UiLangContextValue | null>(null);

export function useUiLang(): UiLangContextValue {
  const value = useContext(UiLangContext);
  if (value === null) {
    throw new Error("useUiLang must be used inside <UiLangContext.Provider>");
  }
  return value;
}