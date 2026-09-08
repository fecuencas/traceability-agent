import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMiniYaml } from "./miniYaml.js";

test("mapeamento simples com escalares de tipos diferentes", () => {
  const result = parseMiniYaml(`name: orders-api
version: 1.0.0
count: 3
ratio: 1.5
enabled: true
disabled: false
nothing: null
`);
  assert.deepEqual(result, {
    name: "orders-api",
    version: "1.0.0",
    count: 3,
    ratio: 1.5,
    enabled: true,
    disabled: false,
    nothing: null,
  });
});

test("mapeamento aninhado (bloco)", () => {
  const result = parseMiniYaml(`info:
  title: Orders API
  version: 1.0.0
`);
  assert.deepEqual(result, { info: { title: "Orders API", version: "1.0.0" } });
});

test("sequência de escalares (lista de required)", () => {
  const result = parseMiniYaml(`required:
  - customerName
  - items
`);
  assert.deepEqual(result, { required: ["customerName", "items"] });
});

test("array inline simples", () => {
  const result = parseMiniYaml(`enum: [pending, confirmed, shipped]`);
  assert.deepEqual(result, { enum: ["pending", "confirmed", "shipped"] });
});

test("sequência de mapeamentos (- key: value com chaves adicionais indentadas)", () => {
  const result = parseMiniYaml(`parameters:
  - name: id
    in: path
    required: true
  - name: limit
    in: query
    required: false
`);
  assert.deepEqual(result, {
    parameters: [
      { name: "id", in: "path", required: true },
      { name: "limit", in: "query", required: false },
    ],
  });
});

test("valores entre aspas simples e duplas", () => {
  const result = parseMiniYaml(`pattern: "^[A-Z0-9-]{4,32}$"
label: 'hello world'
`);
  assert.deepEqual(result, { pattern: "^[A-Z0-9-]{4,32}$", label: "hello world" });
});

test("estrutura real de components.schemas (OpenAPI) navega corretamente", () => {
  const result = parseMiniYaml(`components:
  schemas:
    OrderItem:
      type: object
      required:
        - sku
        - quantity
      properties:
        sku:
          type: string
          pattern: "^[A-Z0-9-]{4,32}$"
        quantity:
          type: integer
          minimum: 1
          maximum: 100
`);
  const schemas = (result.components as any).schemas;
  assert.equal(schemas.OrderItem.type, "object");
  assert.deepEqual(schemas.OrderItem.required, ["sku", "quantity"]);
  assert.equal(schemas.OrderItem.properties.sku.pattern, "^[A-Z0-9-]{4,32}$");
  assert.equal(schemas.OrderItem.properties.quantity.minimum, 1);
  assert.equal(schemas.OrderItem.properties.quantity.maximum, 100);
});

test("ignora linhas em branco e comentários", () => {
  const result = parseMiniYaml(`# comentário de topo
name: x

# outro comentário
value: 1
`);
  assert.deepEqual(result, { name: "x", value: 1 });
});

test("conteúdo vazio retorna objeto vazio", () => {
  assert.deepEqual(parseMiniYaml(""), {});
  assert.deepEqual(parseMiniYaml("   \n  \n"), {});
});
