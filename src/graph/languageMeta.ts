import type { Language } from "../adapters/types.js";

/** Metadados de exibição por linguagem do repositório — mesmo papel de `serviceTypeMeta.ts`, mas
 * para o nó de repositório. */
export const LANGUAGE_META: Record<Language, { emoji: string; hexColor: string }> = {
  java: { emoji: "☕", hexColor: "#e76f00" },
  kotlin: { emoji: "🟣", hexColor: "#7f52ff" },
  node: { emoji: "🟢", hexColor: "#3c873a" },
  python: { emoji: "🐍", hexColor: "#3776ab" },
  ruby: { emoji: "💎", hexColor: "#cc342d" },
  cpp: { emoji: "🔧", hexColor: "#00599c" },
  go: { emoji: "🐹", hexColor: "#00add8" },
  csharp: { emoji: "🔷", hexColor: "#512bd4" },
  php: { emoji: "🐘", hexColor: "#777bb4" },
  rust: { emoji: "🦀", hexColor: "#ce422b" },
  unknown: { emoji: "⬜", hexColor: "#9aa5a6" },
};
