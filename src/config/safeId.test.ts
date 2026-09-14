import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSafeId, isSafeId } from "./safeId.js";

test("isSafeId aceita ids realistas de repo/grupo", () => {
  for (const value of ["order-service", "repo-testes", "inventory-service-legado", "svc_topic_orders.created", "a1"]) {
    assert.equal(isSafeId(value), true, value);
  }
});

test("isSafeId rejeita separadores de caminho e navegação de diretório", () => {
  for (const value of ["..", ".", "../evil", "a/b", "a\\b", "/etc/passwd", "", "-leading-hyphen", ".leading-dot"]) {
    assert.equal(isSafeId(value), false, value);
  }
});

test("assertSafeId lança erro claro para id de path traversal", () => {
  assert.throws(() => assertSafeId("../../../etc/passwd", "repoId"), /repoId inválido/);
});

test("assertSafeId devolve o próprio valor quando é seguro", () => {
  assert.equal(assertSafeId("order-service", "repoId"), "order-service");
});
