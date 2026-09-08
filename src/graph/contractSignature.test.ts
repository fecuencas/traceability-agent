import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DIFF_HIGHLIGHT_END,
  DIFF_HIGHLIGHT_START,
  diffFieldAttributes,
  extractContractOperations,
  extractContractSchemas,
  extractOpenApiOperations,
  extractSwaggerJsonOperations,
  serializeFieldSignature,
  serializeFieldSignatureWithHighlight,
} from "./contractSignature.js";

const OPENAPI_YAML = `openapi: 3.0.0
info:
  title: Orders API
  version: 1.0.0
paths:
  /orders/{id}:
    get:
      summary: Busca um pedido
    delete:
      summary: Cancela um pedido
  /orders:
    post:
      summary: Cria um pedido
`;

test("extrai operações do bloco paths: de um OpenAPI YAML", () => {
  const ops = extractOpenApiOperations(OPENAPI_YAML);
  assert.deepEqual(
    Array.from(ops).sort(),
    ["DELETE /orders/{id}", "GET /orders/{id}", "POST /orders"].sort(),
  );
});

test("ignora chaves fora do bloco paths: (ex: info:)", () => {
  const ops = extractOpenApiOperations(OPENAPI_YAML);
  assert.equal(Array.from(ops).some((op) => op.includes("title") || op.includes("version")), false);
});

test("extrai operações de um swagger.json", () => {
  const json = JSON.stringify({
    paths: {
      "/orders/{id}": { get: {}, delete: {} },
      "/orders": { post: {} },
    },
  });
  const ops = extractSwaggerJsonOperations(json);
  assert.deepEqual(Array.from(ops).sort(), ["DELETE /orders/{id}", "GET /orders/{id}", "POST /orders"].sort());
});

test("swagger.json inválido retorna conjunto vazio, não lança", () => {
  const ops = extractSwaggerJsonOperations("{ not valid json");
  assert.equal(ops.size, 0);
});

test("extractContractOperations escolhe o extrator pelo nome do arquivo", () => {
  assert.equal(extractContractOperations("openapi.yaml", OPENAPI_YAML)?.size, 3);
  assert.equal(extractContractOperations("swagger.json", JSON.stringify({ paths: {} }))?.size, 0);
});

test("extractContractOperations retorna undefined pra .proto/.avsc (fora de escopo)", () => {
  assert.equal(extractContractOperations("orders.proto", "message Order { string id = 1; }"), undefined);
  assert.equal(extractContractOperations("orders.avsc", "{}"), undefined);
});

const OPENAPI_WITH_SCHEMAS = `openapi: 3.0.0
components:
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
    Order:
      type: object
      required:
        - id
        - status
        - customerName
      properties:
        id:
          type: string
          format: uuid
        status:
          type: string
          enum: [pending, confirmed, shipped]
        customerName:
          type: string
          minLength: 2
          maxLength: 120
        items:
          type: array
          items:
            $ref: "#/components/schemas/OrderItem"
        notRequired:
          type: string
`;

test("extractContractSchemas extrai tipo/obrigatoriedade/restrições de cada campo", () => {
  const schemas = extractContractSchemas("openapi.yaml", OPENAPI_WITH_SCHEMAS);
  assert.ok(schemas);

  const sku = schemas.get("OrderItem.sku");
  assert.equal(sku?.type, "string");
  assert.equal(sku?.required, true);
  assert.equal(sku?.pattern, "^[A-Z0-9-]{4,32}$");

  const quantity = schemas.get("OrderItem.quantity");
  assert.equal(quantity?.type, "integer");
  assert.equal(quantity?.minimum, 1);
  assert.equal(quantity?.maximum, 100);

  const customerName = schemas.get("Order.customerName");
  assert.equal(customerName?.minLength, 2);
  assert.equal(customerName?.maxLength, 120);

  const status = schemas.get("Order.status");
  assert.deepEqual(status?.enumValues, ["confirmed", "pending", "shipped"]);

  const notRequired = schemas.get("Order.notRequired");
  assert.equal(notRequired?.required, false);
});

test("extractContractSchemas resolve $ref direto e dentro de array (itemsType)", () => {
  const schemas = extractContractSchemas("openapi.yaml", OPENAPI_WITH_SCHEMAS);
  const items = schemas?.get("Order.items");
  assert.equal(items?.type, "array");
  assert.equal(items?.itemsType, "ref:OrderItem");
});

test("extractContractSchemas retorna undefined pra .proto/.avsc (fora de escopo)", () => {
  assert.equal(extractContractSchemas("orders.proto", "message Order { string id = 1; }"), undefined);
});

test("serializeFieldSignature produz string determinística e sensível a cada atributo", () => {
  const base = { schema: "Order", field: "customerName", type: "string", required: true, maxLength: 120 };
  const changedLength = { ...base, maxLength: 60 };
  const changedType = { ...base, type: "number" };
  assert.notEqual(serializeFieldSignature(base), serializeFieldSignature(changedLength));
  assert.notEqual(serializeFieldSignature(base), serializeFieldSignature(changedType));
  assert.equal(serializeFieldSignature(base), serializeFieldSignature({ ...base }));
});

test("diffFieldAttributes detecta só os atributos que realmente mudaram", () => {
  const base = { schema: "Order", field: "customerName", type: "string", required: true, minLength: 2, maxLength: 120 };
  const onlyTypeChanged = { ...base, type: "number" };
  assert.deepEqual(diffFieldAttributes(base, onlyTypeChanged), new Set(["type"]));

  const typeAndMaxLengthChanged = { ...base, type: "number", maxLength: 60 };
  assert.deepEqual(diffFieldAttributes(base, typeAndMaxLengthChanged), new Set(["type", "maxLength"]));

  assert.deepEqual(diffFieldAttributes(base, { ...base }), new Set());
});

test("serializeFieldSignatureWithHighlight só envolve o(s) atributo(s) pedidos com os marcadores", () => {
  const signature = { schema: "Order", field: "customerName", type: "string", required: true, maxLength: 120 };
  const highlighted = serializeFieldSignatureWithHighlight(signature, new Set(["type"]));
  assert.equal(highlighted, `${DIFF_HIGHLIGHT_START}type=string${DIFF_HIGHLIGHT_END};required=true;maxLength=120`);

  const notHighlighted = serializeFieldSignatureWithHighlight(signature, new Set());
  assert.equal(notHighlighted, serializeFieldSignature(signature));
  assert.equal(notHighlighted.includes(DIFF_HIGHLIGHT_START), false);
});
