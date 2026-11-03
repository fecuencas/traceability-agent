import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseSpringBootStructure } from "./springBootStructure.js";

function writeFile(repoPath: string, relativePath: string, content: string): void {
  const filePath = path.join(repoPath, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function makeRepo(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("parseSpringBootStructure captura classe simples com uma anotação, pacote e nome", () => {
  const repoPath = makeRepo("sb-simple-");
  writeFile(
    repoPath,
    "src/main/java/com/example/OrderService.java",
    ["package com.example;", "", "import org.springframework.stereotype.Service;", "", "@Service", "public class OrderService {", "}"].join(
      "\n",
    ),
  );

  const { classes } = parseSpringBootStructure(repoPath);

  assert.equal(classes.length, 1);
  assert.equal(classes[0].name, "OrderService");
  assert.equal(classes[0].packageName, "com.example");
  assert.deepEqual(classes[0].annotations, ["Service"]);
});

test("parseSpringBootStructure resolve anotação multi-linha (ex: @RequestMapping com vários argumentos)", () => {
  const repoPath = makeRepo("sb-multiline-");
  writeFile(
    repoPath,
    "src/main/java/com/example/OrderController.java",
    [
      "package com.example;",
      "",
      "import org.springframework.web.bind.annotation.RequestMapping;",
      "import org.springframework.web.bind.annotation.RestController;",
      "",
      "@RequestMapping(",
      '    value = "/orders",',
      "    method = RequestMethod.GET",
      ")",
      "@RestController",
      "public class OrderController {",
      "}",
    ].join("\n"),
  );

  const { classes } = parseSpringBootStructure(repoPath);

  assert.equal(classes.length, 1);
  assert.equal(classes[0].name, "OrderController");
  assert.deepEqual(classes[0].annotations, ["RequestMapping", "RestController"]);
});

// Achado de robustez (2026-10): `@Value("${some.config:(default)}")` tem um `(` e um `)` DENTRO do
// valor da string — uma contagem ingênua de parênteses (char a char sem saber o que é string) acha
// que a anotação continua na próxima linha quando na verdade já terminou na mesma, derrubando a
// profundidade de bloco calculada daí em diante. Mesmo teste cobre `{`/`}` dentro de string.
test("não se confunde com parênteses/chaves DENTRO de um literal de string em @Value", () => {
  const repoPath = makeRepo("sb-value-string-");
  writeFile(
    repoPath,
    "src/main/java/com/example/ConfigHolder.java",
    [
      "package com.example;",
      "",
      "import org.springframework.beans.factory.annotation.Value;",
      "import org.springframework.context.annotation.Bean;",
      "import org.springframework.context.annotation.Configuration;",
      "",
      "@Configuration",
      "public class ConfigHolder {",
      '    @Value("${some.config:(default)}")',
      "    private String tricky;",
      "",
      '    @Value("${another.config:{weird}}")',
      "    private String trickier;",
      "",
      "    @Bean",
      "    public String exportedValue() {",
      "        return tricky;",
      "    }",
      "}",
    ].join("\n"),
  );

  const { classes } = parseSpringBootStructure(repoPath);

  assert.equal(classes.length, 1);
  assert.equal(classes[0].name, "ConfigHolder");
  // Se a profundidade tivesse sido corrompida pelas strings com `(`/`{` dentro, ou o @Bean não
  // seria atribuído a esta classe, ou o parser "vazaria" a classe como ainda aberta indefinidamente.
  assert.equal(classes[0].hasBeanMethod, true);
  assert.equal(classes[0].beanMethodEvidence?.line, 16);
});

test("extrai o nome simples de SpringApplication.run(X.class, args) sem confundir com o sufixo .class", () => {
  const repoPath = makeRepo("sb-main-simple-");
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

  const { mainEntries } = parseSpringBootStructure(repoPath);

  assert.equal(mainEntries.length, 1);
  assert.equal(mainEntries[0].className, "DemoApplication");
});

test("extrai o nome simples de SpringApplication.run(com.example.X.class, args) totalmente qualificado", () => {
  const repoPath = makeRepo("sb-main-fqcn-");
  writeFile(
    repoPath,
    "src/main/java/com/example/Bootstrap.java",
    [
      "package com.example;",
      "",
      "public class Bootstrap {",
      "    public static void main(String[] args) {",
      "        org.springframework.boot.SpringApplication.run(com.example.DemoApplication.class, args);",
      "    }",
      "}",
    ].join("\n"),
  );

  const { mainEntries } = parseSpringBootStructure(repoPath);

  assert.equal(mainEntries.length, 1);
  assert.equal(mainEntries[0].className, "DemoApplication");
});

test("detecta o entry-point Kotlin runApplication<X>()", () => {
  const repoPath = makeRepo("sb-main-kotlin-");
  writeFile(
    repoPath,
    "src/main/kotlin/com/example/DemoApplication.kt",
    ["package com.example", "", "import org.springframework.boot.runApplication", "", "class DemoApplication", "", "fun main(args: Array<String>) {", "    runApplication<DemoApplication>(*args)", "}"].join(
      "\n",
    ),
  );

  const { mainEntries } = parseSpringBootStructure(repoPath);

  assert.equal(mainEntries.length, 1);
  assert.equal(mainEntries[0].className, "DemoApplication");
});

test("atribui @Bean a uma classe INTERNA, não à externa que a contém", () => {
  const repoPath = makeRepo("sb-nested-");
  writeFile(
    repoPath,
    "src/main/java/com/example/Outer.java",
    [
      "package com.example;",
      "",
      "import org.springframework.context.annotation.Bean;",
      "import org.springframework.context.annotation.Configuration;",
      "",
      "@Configuration",
      "public class Outer {",
      "    static class Inner {",
      "        @Bean",
      "        public String innerBean() {",
      '            return "x";',
      "        }",
      "    }",
      "}",
    ].join("\n"),
  );

  const { classes } = parseSpringBootStructure(repoPath);

  const outer = classes.find((c) => c.name === "Outer");
  const inner = classes.find((c) => c.name === "Inner");
  assert.ok(outer && inner);
  assert.equal(outer.hasBeanMethod, false, "o @Bean é membro da classe Inner, não de Outer");
  assert.equal(inner.hasBeanMethod, true);
});

test("@Bean fora de qualquer classe (função de topo de arquivo Kotlin) vira topLevelBeans, não é atribuído a nenhuma classe", () => {
  const repoPath = makeRepo("sb-toplevel-bean-");
  writeFile(
    repoPath,
    "src/main/kotlin/com/example/Beans.kt",
    ["package com.example", "", "import org.springframework.context.annotation.Bean", "", "@Bean", "fun strayBean(): String = \"x\""].join(
      "\n",
    ),
  );

  const { classes, topLevelBeans } = parseSpringBootStructure(repoPath);

  assert.equal(classes.length, 0);
  assert.equal(topLevelBeans.length, 1);
  assert.equal(topLevelBeans[0].line, 6); // linha da função em si (fun strayBean...), não da anotação @Bean acima dela
});
