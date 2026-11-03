import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { IntegrationSignal, RepoAnalysisResult } from "../adapters/types.js";
import { checkSpringBootWiring } from "./springBootChecker.js";

function writeFile(repoPath: string, relativePath: string, content: string): void {
  const filePath = path.join(repoPath, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function makeRepo(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const SPRING_BOOT_DEPENDENCY_SIGNAL: IntegrationSignal = {
  type: "published_artifact_dependency",
  evidence: { file: "pom.xml", snippet: "" },
  target: { kind: "repo_coordinate", value: "org.springframework.boot:spring-boot-starter-web" },
  detectorId: "test",
  confidence: "high",
};

function makeSpringBootRepo(repoPath: string, language: "java" | "kotlin" = "java"): RepoAnalysisResult {
  return {
    repoId: "demo",
    repoPath,
    language,
    buildSystem: language === "kotlin" ? "gradle" : "maven",
    coordinates: { version: "1.0.0" },
    scannedAt: new Date(0).toISOString(),
    signals: [SPRING_BOOT_DEPENDENCY_SIGNAL],
  };
}

function byCategory(findings: ReturnType<typeof checkSpringBootWiring>, category: string) {
  return findings.filter((f) => f.category === category);
}

test("gating: não roda em repositório que não depende de org.springframework.boot (mesmo sendo Java)", () => {
  const repoPath = makeRepo("sb-gate-nodep-");
  writeFile(
    repoPath,
    "src/main/java/com/example/DemoApplication.java",
    ["package com.example;", "public class DemoApplication {", "    public static void main(String[] args) {", "        SpringApplication.run(DemoApplication.class, args);", "    }", "}"].join(
      "\n",
    ),
  );
  const repo: RepoAnalysisResult = {
    repoId: "demo",
    repoPath,
    language: "java",
    buildSystem: "maven",
    coordinates: { version: "1.0.0" },
    scannedAt: new Date(0).toISOString(),
    signals: [], // sem a dependência do Spring Boot
  };

  assert.deepEqual(checkSpringBootWiring(repoPath, repo), []);
});

test("gating: não roda em linguagem que não é Java/Kotlin, mesmo com o sinal de dependência presente", () => {
  const repoPath = makeRepo("sb-gate-lang-");
  const repo: RepoAnalysisResult = { ...makeSpringBootRepo(repoPath), language: "python" };

  assert.deepEqual(checkSpringBootWiring(repoPath, repo), []);
});

test("checagem A: classe principal sem @SpringBootApplication gera achado 'error'", () => {
  const repoPath = makeRepo("sb-check-a-broken-");
  writeFile(
    repoPath,
    "src/main/java/com/example/DemoApplication.java",
    [
      "package com.example;",
      "",
      "import org.springframework.boot.SpringApplication;",
      "",
      "public class DemoApplication {",
      "    public static void main(String[] args) {",
      "        SpringApplication.run(DemoApplication.class, args);",
      "    }",
      "}",
    ].join("\n"),
  );

  const findings = checkSpringBootWiring(repoPath, makeSpringBootRepo(repoPath));
  const matches = byCategory(findings, "spring-boot.missing-bootstrap-annotation");

  assert.equal(matches.length, 1);
  assert.equal(matches[0].severity, "error");
});

test("checagem A: classe principal COM @SpringBootApplication não gera achado", () => {
  const repoPath = makeRepo("sb-check-a-ok-");
  writeFile(
    repoPath,
    "src/main/java/com/example/DemoApplication.java",
    [
      "package com.example;",
      "",
      "import org.springframework.boot.SpringApplication;",
      "import org.springframework.boot.autoconfigure.SpringBootApplication;",
      "",
      "@SpringBootApplication",
      "public class DemoApplication {",
      "    public static void main(String[] args) {",
      "        SpringApplication.run(DemoApplication.class, args);",
      "    }",
      "}",
    ].join("\n"),
  );

  const findings = checkSpringBootWiring(repoPath, makeSpringBootRepo(repoPath));

  assert.equal(byCategory(findings, "spring-boot.missing-bootstrap-annotation").length, 0);
});

test("checagem A: a combinação @Configuration + @EnableAutoConfiguration + @ComponentScan equivale a @SpringBootApplication", () => {
  const repoPath = makeRepo("sb-check-a-combo-");
  writeFile(
    repoPath,
    "src/main/java/com/example/DemoApplication.java",
    [
      "package com.example;",
      "",
      "import org.springframework.boot.SpringApplication;",
      "import org.springframework.boot.autoconfigure.EnableAutoConfiguration;",
      "import org.springframework.context.annotation.ComponentScan;",
      "import org.springframework.context.annotation.Configuration;",
      "",
      "@Configuration",
      "@EnableAutoConfiguration",
      "@ComponentScan",
      "public class DemoApplication {",
      "    public static void main(String[] args) {",
      "        SpringApplication.run(DemoApplication.class, args);",
      "    }",
      "}",
    ].join("\n"),
  );

  const findings = checkSpringBootWiring(repoPath, makeSpringBootRepo(repoPath));

  assert.equal(byCategory(findings, "spring-boot.missing-bootstrap-annotation").length, 0);
});

test("checagem A: entry-point referenciando uma classe que não foi encontrada no repo não gera achado (evita falso positivo)", () => {
  const repoPath = makeRepo("sb-check-a-notfound-");
  writeFile(
    repoPath,
    "src/main/java/com/example/Bootstrap.java",
    [
      "package com.example;",
      "",
      "public class Bootstrap {",
      "    public static void main(String[] args) {",
      "        org.springframework.boot.SpringApplication.run(SomeOtherModuleApplication.class, args);",
      "    }",
      "}",
    ].join("\n"),
  );

  const findings = checkSpringBootWiring(repoPath, makeSpringBootRepo(repoPath));

  assert.equal(byCategory(findings, "spring-boot.missing-bootstrap-annotation").length, 0);
});

test("checagem B: classe com @Bean mas sem @Configuration gera achado 'error'", () => {
  const repoPath = makeRepo("sb-check-b-broken-");
  writeFile(
    repoPath,
    "src/main/java/com/example/MyBeans.java",
    [
      "package com.example;",
      "",
      "import org.springframework.context.annotation.Bean;",
      "",
      "public class MyBeans {",
      "    @Bean",
      "    public String myBean() {",
      '        return "hello";',
      "    }",
      "}",
    ].join("\n"),
  );

  const findings = checkSpringBootWiring(repoPath, makeSpringBootRepo(repoPath));
  const matches = byCategory(findings, "spring-boot.bean-method-without-configuration");

  assert.equal(matches.length, 1);
  assert.equal(matches[0].severity, "error");
});

test("checagem B: classe com @Bean E @Configuration não gera achado", () => {
  const repoPath = makeRepo("sb-check-b-ok-");
  writeFile(
    repoPath,
    "src/main/java/com/example/MyBeans.java",
    [
      "package com.example;",
      "",
      "import org.springframework.context.annotation.Bean;",
      "import org.springframework.context.annotation.Configuration;",
      "",
      "@Configuration",
      "public class MyBeans {",
      "    @Bean",
      "    public String myBean() {",
      '        return "hello";',
      "    }",
      "}",
    ].join("\n"),
  );

  const findings = checkSpringBootWiring(repoPath, makeSpringBootRepo(repoPath));

  assert.equal(byCategory(findings, "spring-boot.bean-method-without-configuration").length, 0);
});

test("checagem B: @Bean de topo de arquivo (Kotlin) também gera achado 'error'", () => {
  const repoPath = makeRepo("sb-check-b-toplevel-");
  writeFile(
    repoPath,
    "src/main/kotlin/com/example/Beans.kt",
    ["package com.example", "", "import org.springframework.context.annotation.Bean", "", "@Bean", "fun strayBean(): String = \"x\""].join(
      "\n",
    ),
  );

  const findings = checkSpringBootWiring(repoPath, makeSpringBootRepo(repoPath, "kotlin"));
  const matches = byCategory(findings, "spring-boot.bean-method-without-configuration");

  assert.equal(matches.length, 1);
  assert.equal(matches[0].severity, "error");
});

test("checagem C: @Service fora do pacote coberto pelo @SpringBootApplication gera achado 'warning'", () => {
  const repoPath = makeRepo("sb-check-c-broken-");
  writeFile(
    repoPath,
    "src/main/java/com/example/app/DemoApplication.java",
    [
      "package com.example.app;",
      "",
      "import org.springframework.boot.autoconfigure.SpringBootApplication;",
      "",
      "@SpringBootApplication",
      "public class DemoApplication {",
      "}",
    ].join("\n"),
  );
  writeFile(
    repoPath,
    "src/main/java/com/example/other/OrphanService.java",
    ["package com.example.other;", "", "import org.springframework.stereotype.Service;", "", "@Service", "public class OrphanService {", "}"].join(
      "\n",
    ),
  );

  const findings = checkSpringBootWiring(repoPath, makeSpringBootRepo(repoPath));
  const matches = byCategory(findings, "spring-boot.bean-outside-component-scan");

  assert.equal(matches.length, 1);
  assert.equal(matches[0].severity, "warning");
});

test("checagem C: @Service DENTRO do pacote (ou subpacote) do @SpringBootApplication não gera achado", () => {
  const repoPath = makeRepo("sb-check-c-ok-");
  writeFile(
    repoPath,
    "src/main/java/com/example/app/DemoApplication.java",
    [
      "package com.example.app;",
      "",
      "import org.springframework.boot.autoconfigure.SpringBootApplication;",
      "",
      "@SpringBootApplication",
      "public class DemoApplication {",
      "}",
    ].join("\n"),
  );
  writeFile(
    repoPath,
    "src/main/java/com/example/app/service/OrderService.java",
    [
      "package com.example.app.service;",
      "",
      "import org.springframework.stereotype.Service;",
      "",
      "@Service",
      "public class OrderService {",
      "}",
    ].join("\n"),
  );

  const findings = checkSpringBootWiring(repoPath, makeSpringBootRepo(repoPath));

  assert.equal(byCategory(findings, "spring-boot.bean-outside-component-scan").length, 0);
});

test("checagem C: pula inteiramente quando há @ComponentScan customizado em algum lugar do repo (evita falso positivo)", () => {
  const repoPath = makeRepo("sb-check-c-customscan-");
  writeFile(
    repoPath,
    "src/main/java/com/example/app/DemoApplication.java",
    [
      "package com.example.app;",
      "",
      "import org.springframework.boot.autoconfigure.SpringBootApplication;",
      "import org.springframework.context.annotation.ComponentScan;",
      "",
      "@SpringBootApplication",
      '@ComponentScan(basePackages = {"com.example.app", "com.example.other"})',
      "public class DemoApplication {",
      "}",
    ].join("\n"),
  );
  writeFile(
    repoPath,
    "src/main/java/com/example/other/OrphanService.java",
    ["package com.example.other;", "", "import org.springframework.stereotype.Service;", "", "@Service", "public class OrphanService {", "}"].join(
      "\n",
    ),
  );

  const findings = checkSpringBootWiring(repoPath, makeSpringBootRepo(repoPath));

  // Mesmo com OrphanService fora do pacote base de @SpringBootApplication, o @ComponentScan
  // customizado (que de fato cobre com.example.other) faz a checagem inteira ser pulada — em vez
  // de tentar (e possivelmente errar) resolver o que `basePackages` configura.
  assert.equal(byCategory(findings, "spring-boot.bean-outside-component-scan").length, 0);
});

test("repositório Spring Boot saudável (tudo correto) não gera achado nenhum", () => {
  const repoPath = makeRepo("sb-healthy-");
  writeFile(
    repoPath,
    "src/main/java/com/example/DemoApplication.java",
    [
      "package com.example;",
      "",
      "import org.springframework.boot.SpringApplication;",
      "import org.springframework.boot.autoconfigure.SpringBootApplication;",
      "",
      "@SpringBootApplication",
      "public class DemoApplication {",
      "    public static void main(String[] args) {",
      "        SpringApplication.run(DemoApplication.class, args);",
      "    }",
      "}",
    ].join("\n"),
  );
  writeFile(
    repoPath,
    "src/main/java/com/example/OrderService.java",
    ["package com.example;", "", "import org.springframework.stereotype.Service;", "", "@Service", "public class OrderService {", "}"].join("\n"),
  );
  writeFile(
    repoPath,
    "src/main/java/com/example/AppConfig.java",
    [
      "package com.example;",
      "",
      "import org.springframework.context.annotation.Bean;",
      "import org.springframework.context.annotation.Configuration;",
      "",
      "@Configuration",
      "public class AppConfig {",
      "    @Bean",
      "    public String greeting() {",
      '        return "hi";',
      "    }",
      "}",
    ].join("\n"),
  );

  const findings = checkSpringBootWiring(repoPath, makeSpringBootRepo(repoPath));

  assert.deepEqual(findings, []);
});
