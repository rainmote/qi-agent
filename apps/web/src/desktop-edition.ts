declare const __QI_DESKTOP_EDITION__: "full" | "core-preview";

// A build label only. Runtime tool availability remains authoritative in RPC.
export const corePreview = typeof __QI_DESKTOP_EDITION__ !== "undefined"
  && __QI_DESKTOP_EDITION__ === "core-preview";
