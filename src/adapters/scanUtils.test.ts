import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { scanCodePatterns, scanTopicPatterns } from "./scanUtils.js";

function withTempFile(content: string, extension: string, run: (repoPath: string) => void): void {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "scan-"));
  fs.writeFileSync(path.join(repoPath, `Sample${extension}`), content, "utf8");
  try {
    run(repoPath);
  } finally {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

const REST_TEMPLATE_RULE = {
  detectorId: "test.http-client-scan",
  type: "outbound_http" as const,
  regex: /\bRestTemplate\b/,
  confidence: "medium" as const,
};

// Achado desta sessão: um stub local que reimplementa a assinatura de um client HTTP real (comum
// em fixtures/testes offline) tem sua PRÓPRIA declaração de classe batendo no mesmo regex usado
// para detectar USO do client — sem o filtro, a declaração virava um falso sinal de chamada de saída.
test("ignora a declaração da própria classe stub (class RestTemplate {)", () => {
  withTempFile('public class RestTemplate {\n  public String getForObject(String url) { return url; }\n}\n', ".java", (repoPath) => {
    const signals = scanCodePatterns(repoPath, [".java"], [REST_TEMPLATE_RULE]);
    assert.equal(signals.length, 0);
  });
});

test("ignora comentário e import mencionando o nome do client", () => {
  withTempFile(
    ["import com.example.http.RestTemplate;", "// usa RestTemplate internamente", "class Foo {}"].join("\n"),
    ".java",
    (repoPath) => {
      const signals = scanCodePatterns(repoPath, [".java"], [REST_TEMPLATE_RULE]);
      assert.equal(signals.length, 0);
    },
  );
});

test("detecta uma chamada real ao client", () => {
  withTempFile('String result = new RestTemplate().getForObject("http://localhost:8087/x", String.class);', ".java", (repoPath) => {
    const signals = scanCodePatterns(repoPath, [".java"], [REST_TEMPLATE_RULE]);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].target.kind, "url");
    assert.equal(signals[0].target.value, "http://localhost:8087/x");
  });
});

// Fase 7 (achado ao adicionar adapters novos): PHP/Rust usam `use`, C# usa `using` — nenhum dos
// dois batia em isCommentOrImportLine antes, então uma linha de import nessas linguagens podia
// contar como sinal falso.
test("ignora linha de import em PHP/Rust (use) e C# (using)", () => {
  withTempFile('use GuzzleHttp\\RestTemplate;\nuse reqwest::RestTemplate;', ".php", (repoPath) => {
    const signals = scanCodePatterns(repoPath, [".php"], [REST_TEMPLATE_RULE]);
    assert.equal(signals.length, 0);
  });
  withTempFile("using System.Net.RestTemplate;", ".cs", (repoPath) => {
    const signals = scanCodePatterns(repoPath, [".cs"], [REST_TEMPLATE_RULE]);
    assert.equal(signals.length, 0);
  });
});

// Fase 7: Go declara tipo na ordem INVERTIDA (`type Client struct {}`) — o filtro de declaração
// antes só reconhecia `palavra-chave identificador` (`class X`), nunca `identificador palavra-chave`.
test("ignora declaração de struct/interface no estilo Go (type X struct)", () => {
  withTempFile("type RestTemplate struct {\n  BaseURL string\n}", ".go", (repoPath) => {
    const signals = scanCodePatterns(repoPath, [".go"], [REST_TEMPLATE_RULE]);
    assert.equal(signals.length, 0);
  });
});

test("scanTopicPatterns ignora tópico mencionado só em comentário", () => {
  withTempFile('// kafkaTemplate.send("orders.created", payload)', ".java", (repoPath) => {
    const signals = scanTopicPatterns(repoPath, [".java"], [
      {
        detectorId: "test.kafka-publish-scan",
        type: "queue_publish",
        regex: /kafkaTemplate\.send\(\s*"([^"]+)"/,
        confidence: "medium",
      },
    ]);
    assert.equal(signals.length, 0);
  });
});
