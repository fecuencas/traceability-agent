import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { csharpDotnetAdapter } from "./csharpDotnetAdapter.js";

function makeRepo(files: Record<string, string>): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "csharp-repo-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(repoPath, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }
  return repoPath;
}

const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <PackageId>OrderService</PackageId>
    <Version>1.0.0</Version>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="RestSharp" Version="110.2.0" />
  </ItemGroup>
</Project>
`;

test("matches só quando existe *.csproj na raiz", () => {
  const repoPath = makeRepo({ "OrderService.csproj": CSPROJ });
  assert.equal(csharpDotnetAdapter.matches(repoPath), true);
  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("extrai PackageId/Version e dependência via PackageReference", () => {
  const repoPath = makeRepo({ "OrderService.csproj": CSPROJ });

  const result = csharpDotnetAdapter.analyze(repoPath, "order-service");

  assert.equal(result.coordinates.packageName, "OrderService");
  assert.equal(result.coordinates.version, "1.0.0");
  const dep = result.signals.find((s) => s.type === "published_artifact_dependency");
  assert.equal(dep?.target.value, "RestSharp");
  assert.equal(dep?.version, "110.2.0");

  fs.rmSync(repoPath, { recursive: true, force: true });
});

test("detecta chamada HTTP real e ignora using/comentário", () => {
  const repoPath = makeRepo({
    "OrderService.csproj": CSPROJ,
    "Client.cs": [
      "using System.Net.Http; // menciona HttpClient só no import, não é uso",
      "// await client.GetAsync(...) também aparece aqui num comentário",
      "class OrderClient {",
      "  private readonly HttpClient client = new HttpClient();",
      '  async Task Fetch() { await client.GetAsync("http://localhost:8081/orders"); }',
      "}",
    ].join("\n"),
  });

  const result = csharpDotnetAdapter.analyze(repoPath, "order-service");

  const httpSignals = result.signals.filter((s) => s.target.kind === "url");
  assert.equal(httpSignals.length, 1);
  assert.equal(httpSignals[0].target.value, "http://localhost:8081/orders");

  fs.rmSync(repoPath, { recursive: true, force: true });
});
