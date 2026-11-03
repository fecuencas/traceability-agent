import assert from "node:assert/strict";
import { test } from "node:test";
import { SAFE_ID_PATTERN } from "../config/safeId.js";
import type { GroupRepoConfig } from "../config/groupConfig.js";
import { buildRepoFileSlugMap, resolveRepoFileSlug } from "./repoFileSlug.js";

function repoConfig(overrides: Partial<GroupRepoConfig> & Pick<GroupRepoConfig, "id">): GroupRepoConfig {
  return { coordinates: [], ...overrides };
}

test("sem displayName nem maxRepoNameLength, usa o repoId sem alteração", () => {
  assert.equal(resolveRepoFileSlug("order-service", undefined, undefined), "order-service");
});

test("displayName explícito sempre vence, mesmo com repoId curto", () => {
  const config = repoConfig({ id: "order-service", displayName: "orders" });
  assert.equal(resolveRepoFileSlug("order-service", config, undefined), "orders");
});

test("repoId mais curto que maxRepoNameLength não é truncado", () => {
  assert.equal(resolveRepoFileSlug("order-service", undefined, 50), "order-service");
});

test("repoId mais longo que maxRepoNameLength é truncado com sufixo hash estável", () => {
  const longId = "acme-platform-payments-checkout-service";
  const slug = resolveRepoFileSlug(longId, undefined, 20);
  assert.ok(slug.startsWith(longId.slice(0, 20)));
  assert.match(slug, /-[0-9a-f]{6}$/);
  // Determinístico: mesmo repoId sempre produz o mesmo slug entre execuções.
  assert.equal(slug, resolveRepoFileSlug(longId, undefined, 20));
});

// Achado real (durante o desenvolvimento desta feature): o separador usado entre o prefixo
// truncado e o hash era "~", que `SAFE_ID_PATTERN` (`config/safeId.ts`) rejeita — o slug truncado
// precisa, ele mesmo, ser um nome de arquivo válido, senão `buildRepoFileSlugMap`/`writeGraphToVault`
// lançam um erro ao tentar gravar a nota. Testado diretamente contra o pattern real, não reimplementado.
test("o slug truncado é sempre um safe-id válido (vira nome de arquivo real no vault)", () => {
  const slug = resolveRepoFileSlug("acme-platform-payments-checkout-service", undefined, 20);
  assert.match(slug, SAFE_ID_PATTERN);
});

test("dois repoIds que só divergem DEPOIS do limite de truncagem nunca colidem (hash do nome ORIGINAL)", () => {
  const a = resolveRepoFileSlug("acme-platform-payments-checkout-service", undefined, 24);
  const b = resolveRepoFileSlug("acme-platform-payments-webhook-service", undefined, 24);
  assert.notEqual(a, b, "os dois truncam pro mesmo prefixo de 24 chars, mas o hash do nome completo diferencia");
});

test("displayName tem prioridade sobre maxRepoNameLength quando os dois se aplicam", () => {
  const config = repoConfig({ id: "acme-platform-payments-checkout-service", displayName: "checkout" });
  assert.equal(resolveRepoFileSlug("acme-platform-payments-checkout-service", config, 10), "checkout");
});

test("buildRepoFileSlugMap resolve todos os repos do grupo de uma vez", () => {
  const configs = [repoConfig({ id: "order-service", displayName: "orders" }), repoConfig({ id: "shipping-service" })];
  const map = buildRepoFileSlugMap(["order-service", "shipping-service"], configs, undefined);
  assert.equal(map.get("order-service"), "orders");
  assert.equal(map.get("shipping-service"), "shipping-service");
});

test("buildRepoFileSlugMap lança erro claro quando dois displayName explícitos colidem", () => {
  const configs = [
    repoConfig({ id: "order-service", displayName: "api" }),
    repoConfig({ id: "shipping-service", displayName: "api" }),
  ];
  assert.throws(
    () => buildRepoFileSlugMap(["order-service", "shipping-service"], configs, undefined),
    /order-service.*shipping-service|shipping-service.*order-service/s,
  );
});
