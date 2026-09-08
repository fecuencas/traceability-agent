import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pythonPipAdapter } from "./pythonPipAdapter.js";

function makeRepo(files: Record<string, string>): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "python-repo-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(repoPath, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }
  return repoPath;
}

test("matches só quando existe requirements.txt", () => {
  const repoPath = makeRepo({ "requirements.txt": "requests==2.31.0\n" });
  assert.equal(pythonPipAdapter.matches(repoPath), true);
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("extrai dependência via requirements.txt", () => {
  const repoPath = makeRepo({ "requirements.txt": "requests==2.31.0\nconfluent-kafka~=2.3.0\n" });
  const result = pythonPipAdapter.analyze(repoPath, "shipping-service");
  const dep = result.signals.find((s) => s.type === "published_artifact_dependency" && s.target.value === "confluent-kafka");
  assert.equal(dep?.version, "2.3.0");
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("detecta chamada HTTP real via requests/httpx", () => {
  const repoPath = makeRepo({
    "requirements.txt": "requests==2.31.0\n",
    "client.py": 'def update_status(order_id):\n    return requests.patch(f"http://localhost:8081/orders/{order_id}/status", json={})\n',
  });
  const result = pythonPipAdapter.analyze(repoPath, "shipping-service");
  const httpSignal = result.signals.find((s) => s.type === "outbound_http");
  assert.equal(httpSignal?.target.value, "http://localhost:8081/orders/{order_id}/status");
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("detecta consumo de tópico Kafka via KafkaConsumer(\"topic\", ...)", () => {
  const repoPath = makeRepo({
    "requirements.txt": "kafka-python==2.0.2\n",
    "consumer.py": [
      "from kafka import KafkaConsumer",
      "",
      'consumer = KafkaConsumer("orders.created", bootstrap_servers="localhost:9092")',
    ].join("\n"),
  });
  const result = pythonPipAdapter.analyze(repoPath, "shipping-service");
  const queueSignal = result.signals.find((s) => s.type === "queue_consume");
  assert.equal(queueSignal?.target.value, "orders.created");
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("detecta consumo de tópico Kafka via consumer.subscribe([\"topic\"])", () => {
  const repoPath = makeRepo({
    "requirements.txt": "confluent-kafka==2.3.0\n",
    "consumer.py": ['consumer = Consumer(conf)', 'consumer.subscribe(["orders.created"])'].join("\n"),
  });
  const result = pythonPipAdapter.analyze(repoPath, "shipping-service");
  const queueSignal = result.signals.find((s) => s.type === "queue_consume");
  assert.equal(queueSignal?.target.value, "orders.created");
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("detecta publish em tópico Kafka via producer.produce(\"topic\", ...)", () => {
  const repoPath = makeRepo({
    "requirements.txt": "confluent-kafka==2.3.0\n",
    "publisher.py": ['producer = Producer(conf)', 'producer.produce("orders.created", value=payload)'].join("\n"),
  });
  const result = pythonPipAdapter.analyze(repoPath, "order-notifier");
  const queueSignal = result.signals.find((s) => s.type === "queue_publish");
  assert.equal(queueSignal?.target.value, "orders.created");
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("ignora comentário mencionando o tópico", () => {
  const repoPath = makeRepo({
    "requirements.txt": "confluent-kafka==2.3.0\n",
    "publisher.py": '# producer.produce("orders.created", value=payload)\n',
  });
  const result = pythonPipAdapter.analyze(repoPath, "order-notifier");
  assert.equal(result.signals.some((s) => s.type === "queue_publish"), false);
  fs.rmSync(repoPath, { recursive: true, force: true });
});
