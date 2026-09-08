/** Converte um ISO timestamp em algo seguro para nome de arquivo, preservando data E hora. */
export function toFilenameTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}
