import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { goModulesAdapter } from "./goModulesAdapter.js";

function makeRepo(files: Record<string, string>): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "go-repo-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(repoPath, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }
  return repoPath;
}

test("matches só quando existe go.mod", () => {
  const repoPath = makeRepo({ "go.mod": "module example.com/order-service\n\ngo 1.22\n" });
  assert.equal(goModulesAdapter.matches(repoPath), true);
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("extrai module path como packageName e dependência via require", () => {
  const repoPath = makeRepo({
    "go.mod": [
      "module example.com/order-service",
      "",
      "go 1.22",
      "",
      "require (",
      '\tgithub.com/segmentio/kafka-go v0.4.47',
      ")",
    ].join("\n"),
  });

  const result = goModulesAdapter.analyze(repoPath, "order-service");

  assert.equal(result.coordinates.packageName, "example.com/order-service");
  const dep = result.signals.find((s) => s.type === "published_artifact_dependency");
  assert.equal(dep?.target.value, "github.com/segmentio/kafka-go");
  assert.equal(dep?.version, "0.4.47");

  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("detecta chamada HTTP real via net/http", () => {
  const repoPath = makeRepo({
    "go.mod": "module example.com/order-service\n",
    "client.go": [
      "package main",
      "",
      "// wrapper local — deliberadamente NÃO usa um nome bare tipo \"Client\" nas regras de detecção,",
      "// já que `type Client struct {}` é idiomático em Go e colidiria com um regex genérico demais.",
      "type orderClient struct {",
      "\tBaseURL string",
      "}",
      "",
      'func fetchOrder() { http.Get("http://localhost:8081/orders") }',
    ].join("\n"),
  });

  const result = goModulesAdapter.analyze(repoPath, "order-service");

  const httpSignals = result.signals.filter((s) => s.type === "outbound_http");
  assert.equal(httpSignals.length, 1);
  assert.equal(httpSignals[0].target.kind, "url");
  assert.equal(httpSignals[0].target.value, "http://localhost:8081/orders");

  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("detecta publish em tópico Kafka via kafka.Writer{Topic: ...}", () => {
  const repoPath = makeRepo({
    "go.mod": "module example.com/order-service\n",
    "publisher.go": 'w := kafka.Writer{Addr: kafka.TCP("localhost:9092"), Topic: "orders.created"}',
  });

  const result = goModulesAdapter.analyze(repoPath, "order-service");

  const queueSignal = result.signals.find((s) => s.type === "queue_publish");
  assert.equal(queueSignal?.target.value, "orders.created");

  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("detecta consumo de tópico Kafka via kafka.ReaderConfig{Topic: ...}", () => {
  const repoPath = makeRepo({
    "go.mod": "module example.com/fraud-detector\n",
    "consumer.go": 'r := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{"localhost:9092"}, Topic: "payments.processed"})',
  });

  const result = goModulesAdapter.analyze(repoPath, "fraud-detector");

  const queueSignal = result.signals.find((s) => s.type === "queue_consume");
  assert.equal(queueSignal?.target.value, "payments.processed");

  fs.rmSync(repoPath, { recursive: true, force: true });
});
