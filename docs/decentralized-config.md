# Config descentralizado: manifesto por repositório

Além do `config.json` 100% central (cada repo com `path` apontando pro checkout local), o agente
suporta descrever um grupo a partir de **manifestos publicados por cada repositório sozinho** —
útil quando um repo roda o scan no próprio CI/pre-commit sem conhecer nenhum irmão, ou quando nem
todos os repos estão com checkout local na máquina que monta o grafo.

## Gerar um manifesto (sem conhecer nenhum grupo)

Via CLI, de dentro do próprio repositório:

```bash
traceability-agent scan . --repo-id order-service
# grava em ./.traceability/manifest.json por padrão
```

Ou via a tool MCP `scan_repository`, passando `writeManifest: true`.

## As 3 formas de descrever um grupo (misturáveis)

### (a) Tudo central — como sempre foi

```json
{
  "groupId": "meu-sistema",
  "repos": [
    { "id": "order-service", "path": "./order-service", "coordinates": ["com.exemplo:order-service"], "endpoints": ["http://localhost:8081"] }
  ]
}
```

### (b) Híbrido — manifesto pré-gerado + endpoints centrais

Porta/host de um serviço não dá pra inferir do código, então continua declarado aqui mesmo quando
o resto vem do manifesto:

```json
{
  "groupId": "meu-sistema",
  "repos": [
    { "id": "order-service", "manifestPath": "./order-service/.traceability/manifest.json", "coordinates": [], "endpoints": ["http://localhost:8081"] }
  ]
}
```

### (c) Auto-descoberta — zero `repos[]`

```json
{
  "groupId": "meu-sistema",
  "manifestsDir": "."
}
```

Procura `.traceability/manifest.json` em cada subpasta IMEDIATA de `manifestsDir` (não recursivo).
Repos listados explicitamente em `repos[]` sempre vencem sobre a descoberta automática quando o
mesmo `repoId` aparece nos dois — só eles podem carregar `endpoints`.

## Limitações conhecidas

- Um manifesto pode ter sido gerado numa máquina sem o checkout local nesta (ex: CI). Nesse caso a
  checagem de integridade de `published_artifact_dependency` (`checkPublishedArtifactIntegrity`) e
  a geração de testes de regressão (`generate_regression_tests`) são **puladas** pra esse repo (com
  aviso/entrada em `skipped[]`), em vez de falso-positivo ou criação de pasta vazia no disco.
- `manifestVersion` incompatível faz `readManifest` lançar erro explícito; `discoverManifests`
  ignora silenciosamente um manifesto corrompido/incompatível em vez de derrubar a descoberta dos
  outros repos.
