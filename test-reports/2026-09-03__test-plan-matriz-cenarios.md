# Matriz de testes — validação de detecção de falhas de integração

**Objetivo do produto:** identificar automaticamente, via análise estática de código, quando uma
mudança em qualquer repositório do grupo quebra (ou impacta em cascata) uma integração com outro
repositório — por remoção de código, mudança de dependência, renomeação de nomenclatura de
serviço/tópico/endpoint, mudança de versão, ou remoção de recurso de infraestrutura.

Este documento organiza a cobertura de teste em 4 eixos: **tipo de sinal** (o que o agente sabe
detectar), **modo de falha** (a causa raiz real que simulamos), **topologia** (a forma do grafo em
que a falha acontece) e **robustez** (o agente não deve alarmar o que não deveria). Cada linha diz
se já foi validada nesta rodada de testes (com fixture, resultado e achado, se houver) ou se é gap
de cobertura ainda em aberto.

## Eixo 1 — Tipo de sinal de integração (detector)

| Tipo de sinal | Detectores que produzem | Status |
|---|---|---|
| `published_artifact_dependency` | Maven, Gradle, npm, pip, Bundler, CMake | ✅ Testado (quebra por classe removida, versão modificada) |
| `outbound_http` | Node, Java, Kotlin, Python, Ruby, C++ | ✅ Testado (endpoint movido) |
| `queue_publish` / `queue_consume` | Kafka/SQS/SNS (Java, Kotlin, Node) | ✅ Testado (início/meio/fim de cadeia) — mas só quebra TOTAL do tópico, nunca quebra parcial (ver Eixo 3) |
| `service_declaration` (IaC) | Terraform, CloudFormation, serverless.yml | ⚠️ Só ECS testado; Lambda (serverless.yml) nunca teve o cenário de remoção exercido |
| `contract_reference` | Todos os 6 adapters (`scanContractFiles`) | ❌ **Gap total** — resolução de grafo está implementada (`graphBuilder.ts:175-190`, casa repos por nome-base do arquivo `.proto`/`openapi.yaml`/`.avsc`), mas nenhum fixture tem esse tipo de arquivo. Nunca foi exercitado. |
| `config_endpoint` | — | ❌ **Não implementado.** Existe no type system (`adapters/types.ts`), na tabela de cores, no cascade — mas nenhum adapter produz esse sinal. O plano original previa um "config-scanner" (`application.yml`/`.env`/`docker-compose.yml`) que nunca foi construído. Isso não é um gap de teste, é uma feature pendente. |

## Eixo 2 — Modo de falha (causa raiz simulada)

| # | Cenário | Status | Observação |
|---|---|---|---|
| 1 | Renomear/remover a classe importada (arquivo renomeado junto) | ✅ Testado | `broken` detectado corretamente, cascata correta |
| 2 | Renomear só a classe, sem renomear o arquivo | ✅ Testado | **Achado:** evade a detecção — checagem é por caminho de arquivo, não parsing real do conteúdo. Limitação conhecida, documentada. |
| 3 | Remover a declaração da dependência inteira (bloco `<dependency>`/linha do `requirements.txt`) | ❌ Gap | Diferente do #1: aqui o SINAL some (não gera edge nenhuma), vira `removed` por ausência — nunca testamos essa variante isolada do "classe não existe mais" |
| 4 | Mudar versão sem quebrar nada | ✅ Testado | `blastRadius` vazio corretamente; motivou a feature nova de "avisar sem quebrar" |
| 5 | Mudar versão que quebra a API mas não a classe (método removido/renomeado, classe intacta) | ⚠️ Limitação conhecida, não testável | Checagem só verifica existência da classe, nunca de métodos — sempre vai passar como saudável. Vale só documentar, não "testar" (resposta já é conhecida) |
| 6 | Renomear tópico/fila do lado do publisher | ✅ Testado (Cenário 1) | |
| 7 | Renomear tópico/fila do lado de UM consumidor, com outros consumidores saudáveis no mesmo tópico | ❌ Gap | Só quebramos o publisher inteiro até agora — nunca testamos quebra parcial de fan-out (ver Eixo 3) |
| 8 | Múltiplos publishers pro mesmo tópico, um quebra | ❌ Gap | Nenhum fixture tem 2 publishers pro mesmo tópico |
| 9 | Endpoint HTTP movido (porta/host mudou do lado do alvo) | ✅ Testado (Cenário 4) | Achado #6 (cascata vazando) corrigido |
| 10 | Endpoint referenciado via variável/config, não inline na linha da chamada | ❌ Gap | Testa se o agente reporta corretamente como "não resolvido" (baixa confiança) em vez de inventar uma URL errada — relevante porque você mencionou "variáveis" explicitamente |
| 11 | Recurso de IaC removido (Terraform) | ✅ Testado (Cenário 5) | Achado #7 (nó de serviço ficava malformado) corrigido |
| 11b | Recurso de IaC removido (serverless.yml/Lambda) | ❌ Gap | Só testamos o caminho Terraform/ECS; Lambda nunca teve o cenário de remoção |
| 12 | Contract file (`.proto`/`openapi.yaml`) removido/renomeado de um lado | ❌ Gap total | Nenhum fixture tem contract file — feature 100% não-exercitada |

## Eixo 3 — Topologia do grafo

| Topologia | Status | Observação |
|---|---|---|
| Cadeia linear (quebra no início/meio/fim) | ✅ Testado | Cenários 1–3 |
| Diamante (2 caminhos independentes convergindo no mesmo repo) | ❌ Gap | Nenhum fixture tem esse formato — importante pra confirmar que o `impactedIds` não conta a mesma edge 2x nem se comporta estranho quando os 2 caminhos chegam com status diferentes |
| Fan-out com quebra PARCIAL (1 produtor, N consumidores, só 1 consumidor quebra) | ❌ Gap | `orders.created` já tem 2 consumidores reais (`fulfillment-service`, `notification-service`) — dá pra testar sem criar fixture nova, só quebrando 1 dos 2 |
| Fan-in (N produtores pro mesmo alvo) | ❌ Gap total | Nenhum fixture tem múltiplos repos dependendo de um único downstream por caminhos diferentes ao mesmo tempo (billing→shared-utils é o único fan-in hoje, e só tem 1 dependente) |
| Componentes desconectados (multi-aplicação) | ✅ Testado | Cluster Python/Ruby/C++ vs os 9 repos originais |
| Cascata de dependência multi-hop (3+ hops) | ⚠️ Parcial | Testamos 2 hops (`payment-processor → billing-service → fulfillment-service`); vale um caso de 3+ |

## Eixo 4 — Robustez / falso-positivo

| Cenário | Status | Observação |
|---|---|---|
| Mudança irrelevante (comentário, código morto, novo arquivo sem integração) não deve acender nada | ❌ Gap | Nunca fizemos um "grupo de controle negativo" explícito — mudar algo que não deveria ter efeito nenhum e confirmar que realmente não tem |
| Quebra + correção rápida (flapping) não deixa resíduo (tag `removed` velha, nota desatualizada) | ⚠️ Testado implicitamente | Fizemos isso várias vezes ao reverter cenários, mas nunca validamos explicitamente "zero resíduo" como o próprio objetivo do teste |
| Quebra HTTP em Ruby e C++ especificamente (só testamos Python até agora) | ❌ Gap parcial | O detector existe pros 3, só exercitamos a quebra via Python (`catalog-service`) |
| Geração de testes de regressão (Fase 4) contra um cenário genuinamente QUEBRADO | ❌ Gap | Só validamos Fase 4 em estado saudável — nunca testamos gerar/rodar o teste de regressão depois de uma quebra real, pra confirmar que ele PEGA a quebra (o objetivo dele) |

## Priorização sugerida

Maior valor / menor esforço primeiro (reaproveitam fixtures já existentes, sem criar repo novo):
1. **Fan-out parcial** — quebrar só `notification-service`'s consumo de `orders.created`, mantendo `fulfillment-service` saudável (Eixo 2 #7 + Eixo 3 fan-out parcial, 2 gaps de uma vez).
2. **Remover declaração de dependência inteira** vs. remover a classe (Eixo 2 #3) — contraste direto com o Teste 1 já feito.
3. **Endpoint via variável** (Eixo 2 #10) — relevante pro seu pedido original ("variáveis").
4. **Grupo de controle negativo** (Eixo 4) — mudança que não deveria ter efeito nenhum.
5. **Quebra HTTP em Ruby/C++** (Eixo 4) — cobre as 2 linguagens que faltam.
6. **Lambda removido via serverless.yml** (Eixo 2 #11b) — paralelo ao Terraform já testado.
7. **Contract file** (Eixo 1 + Eixo 2 #12) — precisa criar fixture nova (`.proto`/`openapi.yaml` em 2 repos), maior esforço.
8. **Diamante / fan-in** (Eixo 3) — precisa reestruturar/adicionar integração nova no fixture.
9. **Fase 4 contra quebra real** (Eixo 4).

`config_endpoint` (Eixo 1) fica de fora da lista de testes — é feature não implementada, não cenário de teste; decisão de produto (implementar ou remover do type system) fica pra depois.
