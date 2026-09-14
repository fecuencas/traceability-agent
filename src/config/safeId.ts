/**
 * Padrão aceito para qualquer id usado para montar um caminho de arquivo dentro do vault (groupId,
 * repoId) — bloqueia por construção separadores de caminho ("/", "\") e os segmentos especiais "."
 * / ".." que `path.join` resolveria como navegação de diretório. Fecha o vetor de path traversal que
 * existia quando esses ids — vindos de `.traceability/config.json` ou, mais grave, de um
 * `.traceability/manifest.json` publicado por outro repositório (modo descentralizado) — eram usados
 * sem validação nenhuma para montar `Repos/<groupId>/<repoId>.md` e afins.
 */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value);
}

export function assertSafeId(value: unknown, description: string): string {
  if (!isSafeId(value)) {
    throw new Error(
      `${description} inválido: ${JSON.stringify(value)}. Use só letras, números, ".", "_" e "-", ` +
        `começando por letra ou número (sem "/", "\\" nem ".."/"." sozinhos) — esse id vira nome de ` +
        "arquivo/pasta dentro do vault.",
    );
  }
  return value;
}
