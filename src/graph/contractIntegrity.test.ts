import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildContractSchemaFingerprint, checkContractIntegrity, diffContractFingerprints } from "./contractIntegrity.js";
import { DIFF_HIGHLIGHT_END, DIFF_HIGHLIGHT_START } from "./contractSignature.js";

function writeFile(repoPath: string, relativePath: string, content: string): void {
  const filePath = path.join(repoPath, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

const OPENAPI_V1 = `openapi: 3.0.0
paths:
  /orders/{id}:
    get:
      summary: Busca um pedido
    delete:
      summary: Cancela um pedido
`;

test("duas cópias idênticas do contrato: não quebrado", () => {
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), "provider-"));
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-"));
  writeFile(repoA, "openapi.yaml", OPENAPI_V1);
  writeFile(repoB, "openapi.yaml", OPENAPI_V1);

  const result = checkContractIntegrity("provider", repoA, "openapi.yaml", "consumer", repoB, "openapi.yaml");
  assert.equal(result.broken, false);
  assert.equal(result.diffDetails, undefined);
});

test("operação removida de um lado: quebrado, com motivo curto + diffDetails citando repo e operação", () => {
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), "provider-"));
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-"));
  writeFile(repoA, "openapi.yaml", OPENAPI_V1);
  // provider removeu o DELETE — consumer ainda espera o contrato antigo
  writeFile(
    repoB,
    "openapi.yaml",
    `openapi: 3.0.0
paths:
  /orders/{id}:
    get:
      summary: Busca um pedido
`,
  );

  const result = checkContractIntegrity("orders-api-provider", repoA, "openapi.yaml", "orders-api-consumer", repoB, "openapi.yaml");
  assert.equal(result.broken, true);
  assert.match(result.reason ?? "", /orders-api-provider/);
  assert.match(result.reason ?? "", /orders-api-consumer/);
  assert.deepEqual(result.diffDetails, ["ausente em orders-api-consumer: DELETE /orders/{id}"]);
});

// Limitação de design conhecida e documentada (não um bug): sem um papel explícito de
// provider/consumer por repo — que não existe no modelo de config hoje —, a comparação é
// simétrica e não distingue "B adicionou uma operação nova" (seguro) de "A perdeu uma operação
// que B ainda espera" (quebra real). Qualquer divergência no conjunto de operações é reportada;
// cada item de diffDetails diz de qual lado a operação está ausente, pra quem lê decidir.
test("operação só ADICIONADA de um lado também é reportada como divergência (limitação conhecida, sem papel provider/consumer)", () => {
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), "provider-"));
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-"));
  writeFile(repoA, "openapi.yaml", OPENAPI_V1);
  writeFile(
    repoB,
    "openapi.yaml",
    `openapi: 3.0.0
paths:
  /orders/{id}:
    get:
      summary: Busca um pedido
    delete:
      summary: Cancela um pedido
  /orders:
    post:
      summary: Cria um pedido
`,
  );

  const result = checkContractIntegrity("provider", repoA, "openapi.yaml", "consumer", repoB, "openapi.yaml");
  assert.equal(result.broken, true);
  assert.deepEqual(result.diffDetails, ["ausente em provider: POST /orders"]);
});

test("múltiplas operações divergentes nos dois sentidos viram uma linha de diffDetails cada", () => {
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), "a-"));
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), "b-"));
  writeFile(
    repoA,
    "openapi.yaml",
    `openapi: 3.0.0
paths:
  /orders/{id}:
    get:
      summary: x
  /invoices:
    post:
      summary: x
`,
  );
  writeFile(
    repoB,
    "openapi.yaml",
    `openapi: 3.0.0
paths:
  /orders/{id}:
    get:
      summary: x
  /refunds:
    post:
      summary: x
`,
  );

  const result = checkContractIntegrity("repo-a", repoA, "openapi.yaml", "repo-b", repoB, "openapi.yaml");
  assert.equal(result.broken, true);
  assert.deepEqual(
    (result.diffDetails ?? []).sort(),
    ["ausente em repo-a: POST /refunds", "ausente em repo-b: POST /invoices"].sort(),
  );
});

test(".proto não tem diff estrutural — nunca quebra por conteúdo (fora de escopo)", () => {
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), "provider-"));
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-"));
  writeFile(repoA, "orders.proto", "message Order { string id = 1; string status = 2; }");
  writeFile(repoB, "orders.proto", "message Order { string id = 1; }");

  const result = checkContractIntegrity("provider", repoA, "orders.proto", "consumer", repoB, "orders.proto");
  assert.equal(result.broken, false);
});

test("arquivo não existe localmente (repo via manifesto): não quebra, pula a checagem", () => {
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), "provider-"));
  const repoB = "/caminho/que/nao/existe";
  writeFile(repoA, "openapi.yaml", OPENAPI_V1);

  const result = checkContractIntegrity("provider", repoA, "openapi.yaml", "consumer", repoB, "openapi.yaml");
  assert.equal(result.broken, false);
});

const SCHEMA_V1 = `openapi: 3.0.0
paths:
  /orders/{id}:
    get:
      summary: x
components:
  schemas:
    Order:
      type: object
      required:
        - customerName
      properties:
        customerName:
          type: string
          maxLength: 120
`;

// Pedido do usuário: quando existe um consumidor mapeado (sibling do mesmo contrato), uma mudança
// de CAMPO (não só de operação) também precisa virar quebra real, do mesmo jeito que uma operação
// removida — "os dois lados ainda falam da mesma forma?".
test("campo com maxLength diferente entre as duas cópias: quebrado, com o campo e os dois valores citados", () => {
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), "provider-"));
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-"));
  writeFile(repoA, "openapi.yaml", SCHEMA_V1);
  writeFile(repoB, "openapi.yaml", SCHEMA_V1.replace("maxLength: 120", "maxLength: 60"));

  const result = checkContractIntegrity("orders-api-provider", repoA, "openapi.yaml", "orders-api-consumer", repoB, "openapi.yaml");
  assert.equal(result.broken, true);
  // Uma linha por lado (não uma linha combinada) — cada uma cita o repo e só o(s) atributo(s) que
  // realmente divergem, destacados com os marcadores de `serializeFieldSignatureWithHighlight`.
  assert.equal(result.diffDetails?.length, 2);
  const [lineA, lineB] = result.diffDetails ?? [];
  assert.match(lineA, /Order\.customerName/);
  assert.match(lineA, /orders-api-provider declara/);
  assert.match(lineA, /maxLength=120/);
  assert.match(lineB, /Order\.customerName/);
  assert.match(lineB, /orders-api-consumer declara/);
  assert.match(lineB, /maxLength=60/);
});

test("só o atributo que diverge (ex: type) vem marcado com DIFF_HIGHLIGHT_START/END — os outros atributos ficam de fora", () => {
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), "provider-"));
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-"));
  writeFile(repoA, "openapi.yaml", SCHEMA_V1);
  writeFile(repoB, "openapi.yaml", SCHEMA_V1.replace("type: string\n          maxLength: 120", "type: number\n          maxLength: 120"));

  const result = checkContractIntegrity("provider", repoA, "openapi.yaml", "consumer", repoB, "openapi.yaml");
  assert.equal(result.broken, true);
  const [lineA, lineB] = result.diffDetails ?? [];
  const highlightRegex = new RegExp(`${DIFF_HIGHLIGHT_START}([^${DIFF_HIGHLIGHT_END}]*)${DIFF_HIGHLIGHT_END}`);
  assert.match(lineA, highlightRegex);
  assert.equal(highlightRegex.exec(lineA)?.[1], "type=string");
  assert.match(lineB, highlightRegex);
  assert.equal(highlightRegex.exec(lineB)?.[1], "type=number");
  // maxLength é igual dos dois lados — não deve estar marcado.
  assert.doesNotMatch(lineA.replace(highlightRegex, ""), new RegExp(DIFF_HIGHLIGHT_START));
});

test("campo removido de um schema (não só de paths) também é detectado entre as duas cópias", () => {
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), "provider-"));
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-"));
  writeFile(repoA, "openapi.yaml", SCHEMA_V1);
  writeFile(
    repoB,
    "openapi.yaml",
    `openapi: 3.0.0
paths:
  /orders/{id}:
    get:
      summary: x
components:
  schemas:
    Order:
      type: object
      required: []
      properties: {}
`,
  );

  const result = checkContractIntegrity("provider", repoA, "openapi.yaml", "consumer", repoB, "openapi.yaml");
  assert.equal(result.broken, true);
  assert.match(result.diffDetails?.[0] ?? "", /Order\.customerName: presente em provider, ausente em consumer/);
});

test("schemas idênticos entre as duas cópias: não quebrado", () => {
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), "provider-"));
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-"));
  writeFile(repoA, "openapi.yaml", SCHEMA_V1);
  writeFile(repoB, "openapi.yaml", SCHEMA_V1);

  const result = checkContractIntegrity("provider", repoA, "openapi.yaml", "consumer", repoB, "openapi.yaml");
  assert.equal(result.broken, false);
});

test("buildContractSchemaFingerprint + diffContractFingerprints detectam mudança de campo entre duas execuções (caso sem consumidor mapeado)", () => {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-"));
  writeFile(repoPath, "openapi.yaml", SCHEMA_V1);
  const previousFingerprint = buildContractSchemaFingerprint(repoPath, "openapi.yaml");
  assert.ok(previousFingerprint);

  writeFile(repoPath, "openapi.yaml", SCHEMA_V1.replace("maxLength: 120", "maxLength: 60"));
  const currentFingerprint = buildContractSchemaFingerprint(repoPath, "openapi.yaml");
  assert.ok(currentFingerprint);

  const diffs = diffContractFingerprints(previousFingerprint, currentFingerprint);
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /Order\.customerName/);
  assert.match(diffs[0], /maxLength=120/);
  assert.match(diffs[0], /maxLength=60/);
});

test("buildContractSchemaFingerprint retorna undefined quando o arquivo não existe localmente", () => {
  assert.equal(buildContractSchemaFingerprint("/caminho/que/nao/existe", "openapi.yaml"), undefined);
});
