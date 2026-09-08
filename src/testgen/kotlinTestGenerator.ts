import fs from "node:fs";
import path from "node:path";
import { walkFiles } from "../adapters/scanUtils.js";
import { findRelevantImportedClasses } from "../adapters/importScanner.js";
import type { RepoAnalysisResult } from "../adapters/types.js";
import type { GraphEdge } from "../graph/types.js";
import { toPascalCase } from "./naming.js";
import type { GeneratedTest, TestGenerator } from "./types.js";

function resolveKotlinTestPackage(repoPath: string, fallbackGroupId: string | undefined): string {
  const testDir = path.join(repoPath, "tests", "kotlin");
  for (const filePath of walkFiles(testDir, [".kt"])) {
    const content = fs.readFileSync(filePath, "utf8");
    const match = /^\s*package\s+([\w.]+)\s*$/m.exec(content);
    if (match) return match[1];
  }
  const base = (fallbackGroupId ?? "com.example").toLowerCase().replace(/[^a-z0-9.]/g, "");
  return `${base}.traceability`;
}

function renderKotlinTest(packageName: string, className: string, edge: GraphEdge, importedClasses: string[]): string {
  const lines: string[] = [
    `package ${packageName}`,
    "",
    "import org.junit.jupiter.api.Test",
    "import org.junit.jupiter.api.Disabled",
    "import org.junit.jupiter.api.Assertions.assertNotNull",
    "",
    "/**",
    " * Teste de regressão gerado automaticamente pelo traceability-agent.",
    ` * Integração: ${edge.source} -> ${edge.target} (${edge.type}${edge.version ? `, v${edge.version}` : ""})`,
    " * Não editar manualmente — reexecute a tool generate_regression_tests para atualizar.",
    " */",
    `class ${className} {`,
    "",
  ];

  if (importedClasses.length === 0) {
    lines.push(
      "    @Test",
      `    @Disabled("Nenhuma classe de ${edge.target} foi encontrada importada no código-fonte deste repositório; " +`,
      '        "nada automatizável para validar via smoke-test de classe.")',
      "    fun noImportedClassesDetected() {",
      "    }",
    );
  } else {
    for (const fqcn of importedClasses) {
      const methodName = `classShouldStillExist_${fqcn.replace(/[^A-Za-z0-9]/g, "_")}`;
      lines.push(
        "    @Test",
        `    fun ${methodName}() {`,
        `        assertNotNull(Class.forName("${fqcn}"))`,
        "    }",
        "",
      );
    }
  }

  lines.push("}");
  return lines.join("\n");
}

export const kotlinTestGenerator: TestGenerator = {
  id: "kotlin-junit5",
  language: "kotlin",

  generate(sourceRepo: RepoAnalysisResult, targetRepo, edge: GraphEdge, allRepos = []): GeneratedTest | undefined {
    if (edge.type !== "published_artifact_dependency") return undefined;

    const targetGroupId = targetRepo?.coordinates.groupId;
    const otherRepos = allRepos.filter((repo) => repo.repoId !== targetRepo?.repoId);
    const importedClasses = targetGroupId
      ? findRelevantImportedClasses(sourceRepo.repoPath, targetGroupId, otherRepos, [".kt"])
      : [];

    const packageName = resolveKotlinTestPackage(sourceRepo.repoPath, sourceRepo.coordinates.groupId);
    const className = `${toPascalCase(edge.target)}IntegrationRegressionTest`;
    const content = renderKotlinTest(packageName, className, edge, importedClasses);

    const packageDir = path.join(sourceRepo.repoPath, "tests", "kotlin", ...packageName.split("."));
    const filePath = path.join(packageDir, `${className}.kt`);
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");

    return {
      edgeId: edge.id,
      repoId: sourceRepo.repoId,
      language: "kotlin",
      filePath,
      className,
      description:
        importedClasses.length > 0
          ? `Smoke-test gerado para ${importedClasses.length} classe(s) importada(s) de ${edge.target}.`
          : `Nenhuma classe importada de ${edge.target} foi encontrada; teste gerado como @Disabled.`,
    };
  },
};
