# giap-sync-semcas

API que sincroniza a folha oficial da Prefeitura de São Luís (Portal Transparência GIAP) com o Supabase do sistema HR do SEMCAS.

## O que faz

- Puxa dados de servidores direto do Portal Transparência
- Alimenta a tabela `folha_pmsl` no Supabase (fonte da verdade externa)
- Cruza com a tua tabela HR existente pra:
  - Atualizar matrículas ausentes (match por CPF)
  - Classificar como `efetivo` ou `terceirizado`
  - Detectar exonerações automaticamente
- Log completo de todos os syncs em `giap_sync_log`

## Como funciona por dentro

O endpoint ORDS `https://saoluis.giap.com.br/ords/.../remuneracoes` retorna **401 quando chamado direto** — só é acessível via form APEX (page 6 do app 1618). O serviço usa **Puppeteer headless** pra simular o navegador: abre a página, preenche os campos via `apex.item().setValue()`, clica Executa, lê o textarea de resultado.

Puppeteer é robusto contra mudanças de layout, mas roda mais pesado. Em Railway com 512MB de RAM já dá conta.

## Setup

### 1. Criar tabelas no Supabase

Vai no SQL Editor do Supabase e roda `sql/01_schema.sql`. Isso cria `folha_pmsl`, `giap_sync_log` e as views auxiliares.

Depois, se quiser usar o endpoint `/match/hr`, edita `sql/02_alter_hr_servidores.sql` trocando `hr_servidores` pelo nome real da tua tabela HR e roda também. Isso adiciona as colunas `tipo_vinculo`, `exonerado`, `data_exoneracao`.

### 2. Deploy no Railway

```bash
railway login
railway init
railway up
```

Depois, no dashboard, configura as variáveis:
- `SUPABASE_URL` — URL do projeto Supabase
- `SUPABASE_SERVICE_ROLE_KEY` — chave `service_role` (NÃO anon)
- `API_KEY` — gera com `openssl rand -hex 32`

### 3. Testar

```bash
# Substitui SEU_DOMINIO e SUA_KEY
curl https://SEU_DOMINIO.up.railway.app/health

curl -X POST https://SEU_DOMINIO.up.railway.app/buscar \
  -H "X-API-Key: SUA_KEY" \
  -H "Content-Type: application/json" \
  -d '{"nomeServidor":"JURANDY","competencia":202606}'
```

## Relatório API RHSEMCAS (v1.1)

No projeto RHSEMCAS, rode `sql/giap_relatorio_api.sql` (cria `giap_jobs`, `giap_config`, `giap_revisao_ausencia`, `folha_pmsl`).

### Novos endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/jobs` | Cria job em background (`ciclo_completo`, `enriquecer`, `exoneracoes`, `sync_orgao`) |
| GET | `/jobs/:id` | Status / progresso % |
| POST | `/rhsemcas/enriquecer` | Enriquecimento síncrono (matrícula vazia, nome, admissão vazia, vínculo SP) |
| POST | `/rhsemcas/exoneracoes` | Exonera se `demissao`; ausência → fila revisão |
| POST | `/cron/mensal` | Se `giap_config.automatico` e hoje = `dia_mes` (27), dispara ciclo |

### Edge Function `giap-proxy`

No Supabase, configure secrets:
- `GIAP_API_URL` = URL do Railway (ex. `https://xxx.up.railway.app`)
- `GIAP_API_KEY` = mesmo valor de `API_KEY`

Deploy: `supabase functions deploy giap-proxy`

### Cron Railway

Agende HTTP diário (ou só dia 27):
- `POST /cron/mensal` com header `X-API-Key`
- Schedule sugerido: `0 6 * * *` (o endpoint só roda se for o dia configurado)

### Regras de escrita no RH

- Matrícula: só se vazia
- Nome: só com match por CPF/matrícula
- Admissão: só se vazia
- Vínculo: só corrige para **Serviço Prestado** quando `cargoorigem` no GIAP for SERVICO PRESTADO
- Exoneração automática: só com `demissao` preenchida

---

## Endpoints (legado)


### `GET /health`
Ping. Sem auth.

### `POST /buscar`
Consulta ao vivo (NÃO persiste no Supabase). Útil pra tela de busca do sistema HR.
```json
{
  "nomeServidor": "JURANDY",
  "codigoOrgao": "9",
  "codigoInstituicao": 1,
  "competencia": 202606
}
```
Todos os campos são opcionais exceto `nomeServidor` OU `codigoOrgao`. Sem `competencia`, usa mês anterior.

### `POST /sync/orgao`
Puxa todo um órgão e persiste em `folha_pmsl`.
```json
{ "codigoOrgao": "9", "competencia": 202606 }
```

### `POST /sync/orgaos`
Vários órgãos em sequência (útil pra backfill).
```json
{ "codigosOrgao": ["1", "2", "9", "15"] }
```

### `POST /sync/nome`
Busca por nome (LIKE prefix) e persiste tudo que achou.
```json
{ "nomeServidor": "SANTANA" }
```

### `POST /match/hr`
Cruza `folha_pmsl` com tua tabela HR. Este é o principal.
```json
{
  "tabelaHR": "hr_servidores",
  "competencia": 202606,
  "aplicarUpdates": true,
  "filtroLotacao": "SEMCAS",
  "campoCPF": "cpf",
  "campoNome": "nome",
  "campoMatricula": "matricula"
}
```
Retorna relatório detalhado:
```json
{
  "total_hr": 1225,
  "total_folha": 87,
  "matched_cpf": 62,
  "matched_nome": 8,
  "ambiguo_nome": 2,
  "sem_match": 1153,
  "matricula_atualizada": 4,
  "marcado_efetivo": 70,
  "marcado_terceirizado": 1153,
  "marcado_exonerado": 3,
  "ambiguidades": [...],
  "updates_aplicados": 1234
}
```

Passa `aplicarUpdates: false` pra fazer dry-run e revisar antes.

### `POST /verificar/exoneracoes`
Marca `exonerado=true` em quem apareceu na folha com `demissao` preenchida.
```json
{ "competencia": 202606, "tabelaHR": "hr_servidores" }
```

### `GET /orgaos?codigoInstituicao=1`
Lista todos os órgãos da instituição (útil pra descobrir códigos numéricos).

## Códigos conhecidos

**Instituições:**
- `1` — PREFEITURA MUNICIPAL DE SAO LUIS
- `2` — COLISEU (Cia de Limpeza)
- `19` — Fundo Municipal de Saúde

**Órgãos (parcial):**
- `9` — SEMCAS

Roda `GET /orgaos` pra ver todos.

## Fluxo típico

### Setup inicial (uma vez)
1. Rodar SQL de schema
2. `POST /sync/orgao {"codigoOrgao":"9","competencia":202606}` pra popular SEMCAS
3. `POST /match/hr {"aplicarUpdates":false,"filtroLotacao":"SEMCAS"}` pra revisar dry-run
4. Se ok: `POST /match/hr {"aplicarUpdates":true,...}`

### Rotina mensal (dia 5 de cada mês, cron)
```bash
# 1. Puxa competência do mês anterior
curl -X POST .../sync/orgao \
  -H "X-API-Key: $KEY" \
  -d '{"codigoOrgao":"9"}'

# 2. Cruza com HR (atualiza matrículas, marca terceirizados)
curl -X POST .../match/hr \
  -H "X-API-Key: $KEY" \
  -d '{"filtroLotacao":"SEMCAS","aplicarUpdates":true}'

# 3. Marca exonerações
curl -X POST .../verificar/exoneracoes \
  -H "X-API-Key: $KEY" \
  -d '{}'
```

Configura isso no cron do Railway (usa `railway.json` scheduled) ou no scheduler do Supabase.

## Como consumir do sistema HR (React)

```javascript
// service/giapSync.js
const GIAP_API = import.meta.env.VITE_GIAP_SYNC_URL;
const GIAP_KEY = import.meta.env.VITE_GIAP_SYNC_KEY;

async function callGiap(path, body) {
  const r = await fetch(`${GIAP_API}${path}`, {
    method: 'POST',
    headers: {
      'X-API-Key': GIAP_KEY,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) throw new Error(`GIAP ${r.status}: ${await r.text()}`);
  return r.json();
}

export const giap = {
  buscarServidor: (nome) => callGiap('/buscar', { nomeServidor: nome }),
  sincronizarSEMCAS: () => callGiap('/sync/orgao', { codigoOrgao: '9' }),
  cruzarComHR: () => callGiap('/match/hr', {
    filtroLotacao: 'SEMCAS',
    aplicarUpdates: true
  }),
  verificarExoneracoes: () => callGiap('/verificar/exoneracoes', {})
};
```

⚠️ **Cuidado:** a `API_KEY` NÃO pode ir pro bundle do React em produção pública. Pra uso no painel admin do SEMCAS (interno, autenticado), pode. Se for pra front público, ponha um proxy no meio (Cloud Functions ou similar).

## Limitações conhecidas

- **Teto de 100 registros por chamada.** SEMCAS (~90 servidores) cabe. Órgãos grandes tipo SEMUS/SEMED podem ter 500+ e não vão vir completos. Solução: chamar `/sync/nome` iterando A, B, C..., ou filtrar por lotação (subunidade).
- **CPFs sem zeros à esquerda.** O GIAP retorna CPF como número, então CPFs começando com 0 perdem o dígito. A função `normalizarCPF` corrige com `padStart(11, '0')`.
- **Match por nome só funciona com nome exato normalizado.** "JOSÉ DA SILVA" bate com "JOSE DA SILVA" (acento removido), mas NÃO com "JOSE DA SILVA JUNIOR" ou "JOSÉ SILVA". Match ambíguo (2+ pessoas mesmo nome) é ignorado propositalmente — reporta pra tu resolver manual.
- **Cold start do Puppeteer** ~5–10s na primeira chamada. Depois fica quente (o browser é reutilizado).

## Custo estimado no Railway

- Plano Hobby $5/mês já aguenta
- 512MB de RAM é suficiente
- Chamadas ao GIAP: ~5s cada (com browser quente)

## Troubleshooting

**`invalid or missing X-API-Key header`** → confere se tá mandando o header `X-API-Key` (não `Authorization`).

**`Navigation timeout`** → GIAP tá lento ou fora do ar. Retry.

**Resultado vazio mas achou no navegador** → provavelmente `codigo_instituicao` errado. Servidor da Prefeitura é `1`, não `19` (Fundo de Saúde).

**Match por CPF não bate** → confere se teu HR salva CPF só com dígitos ou com máscara `xxx.xxx.xxx-xx`. A normalização já limpa, mas se teu campo tem valor tipo `12345678900` sem o zero à esquerda, vira `012345678900` no lookup. Tá tudo certo.
