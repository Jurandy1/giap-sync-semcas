/**
 * Benchmark controlado: HTTP direto vs Puppeteer APEX.
 * NÃO altera folha. NÃO roda bulk completo.
 *
 * Uso: node scripts/benchmark-http-vs-puppeteer.mjs [competencia]
 */
import 'dotenv/config';
import { fetchRemuneracoesHttp, buildRemuneracoesUrl } from '../src/giap-http.js';
import { scrapeRemuneracoes, closeBrowser } from '../src/scraper.js';
import { getSessionCookies, isSessionReady } from '../src/scraper-session.js';

const COMP = Number(process.argv[2] || 202608);
const ORG = process.env.GIAP_CODIGO_ORGAO || '9';
const PREFIXOS = ['TERESINHA', 'MARIA', 'ANA'];

function resumo(r) {
  return {
    ok: r.ok ?? (r.count != null),
    metodo: r.metodo || r.via,
    count: r.count ?? r.data?.length ?? 0,
    status: r.status,
    tempo_ms: r.timing?.tempo_total ?? r.tempo_ms,
    timing: r.timing,
    erro: r.erro,
    primeiro: r.primeiro || (r.data?.[0]
      ? {
          matricula: r.data[0].matricula,
          funcionario: r.data[0].funcionario,
          codigo_orgao: r.data[0].codigo_orgao
        }
      : null),
    url: r.url || r.requestUrl
  };
}

async function main() {
  console.log(`=== Benchmark GIAP competência ${COMP} ===\n`);
  const out = { competencia: COMP, fases: {} };

  // 1) HTTP sem sessão (esperado: 401)
  console.log('1) HTTP sem cookies...');
  const httpSemSessao = await fetchRemuneracoesHttp({
    competencia: COMP,
    codigoInstituicao: 1,
    codigoOrgao: ORG,
    nomeServidor: 'TERESINHA',
    quantidade: 100
  });
  out.fases.http_sem_sessao = resumo(httpSemSessao);
  console.log(JSON.stringify(out.fases.http_sem_sessao, null, 2));

  // 2) Bootstrap sessão APEX via Puppeteer (1ª consulta — caminho B)
  console.log('\n2) Bootstrap Puppeteer (TERESINHA)...');
  const boot = await scrapeRemuneracoes({
    competencia: COMP,
    codigoInstituicao: 1,
    codigoOrgao: ORG,
    nomeServidor: 'TERESINHA',
    quantidade: 100,
    timeoutMs: 120000
  });
  out.fases.bootstrap_puppeteer = resumo(boot);
  out.fases.bootstrap_puppeteer.cookies = getSessionCookies()?.length || 0;
  console.log(JSON.stringify(out.fases.bootstrap_puppeteer, null, 2));

  if (!isSessionReady()) {
    console.warn('Sessão não capturada — HTTP com cookies pode falhar.');
  }

  // 3) HTTP com cookies da sessão
  console.log('\n3) HTTP com cookies (prefixos)...');
  out.fases.http_com_sessao = {};
  for (const prefixo of PREFIXOS) {
    const r = await fetchRemuneracoesHttp({
      competencia: COMP,
      codigoInstituicao: 1,
      codigoOrgao: ORG,
      nomeServidor: prefixo,
      quantidade: 100,
      cookies: getSessionCookies()
    });
    out.fases.http_com_sessao[prefixo] = resumo(r);
    console.log(`${prefixo}: ${r.tempo_ms}ms → ${r.count} registros (HTTP ${r.status})`);
  }

  // 4) scrapeRemuneracoes após sessão (deve usar HTTP se GIAP_HTTP_DIRECT≠0)
  console.log('\n4) scrapeRemuneracoes pós-sessão (deve preferir HTTP)...');
  out.fases.scrape_pos_sessao = {};
  for (const prefixo of ['MARIA', 'ANA']) {
    const r = await scrapeRemuneracoes({
      competencia: COMP,
      codigoInstituicao: 1,
      codigoOrgao: ORG,
      nomeServidor: prefixo,
      quantidade: 100,
      timeoutMs: 120000
    });
    out.fases.scrape_pos_sessao[prefixo] = resumo(r);
    console.log(`${prefixo}: metodo=${r.metodo} ${r.timing?.tempo_total}ms → ${r.data?.length} registros`);
  }

  // 5) HTTP sem nome/órgão
  console.log('\n5) HTTP sem nome e sem órgão...');
  const urlSemNome = buildRemuneracoesUrl({
    competencia: COMP,
    codigoInstituicao: 1,
    quantidade: 100
  });
  const httpSemNome = await fetchRemuneracoesHttp({
    url: urlSemNome,
    cookies: getSessionCookies()
  });
  out.fases.http_sem_nome = { ...resumo(httpSemNome), url: urlSemNome };
  console.log(JSON.stringify(out.fases.http_sem_nome, null, 2));

  // Conclusão automática
  const bootMs = out.fases.bootstrap_puppeteer.timing?.tempo_total || 0;
  const httpTeresinha = out.fases.http_com_sessao?.TERESINHA?.tempo_ms;
  const scrapeMariaHttp = out.fases.scrape_pos_sessao?.MARIA?.metodo === 'http_sessao';

  out.conclusao = {
    fluxo_atual: 'B — página APEX + apex.item + clique Executa + waitForFunction',
    endpoint_ords: buildRemuneracoesUrl({
      competencia: COMP,
      codigoInstituicao: 1,
      codigoOrgao: ORG,
      nomeServidor: 'TERESINHA',
      quantidade: 100
    }),
    http_sem_sessao_status: out.fases.http_sem_sessao.status,
    bootstrap_puppeteer_ms: bootMs,
    http_com_sessao_teresinha_ms: httpTeresinha,
    scrape_pos_sessao_usou_http: scrapeMariaHttp,
    ganho_estimado:
      httpTeresinha && bootMs
        ? `${Math.round(bootMs / httpTeresinha)}x mais rápido via HTTP após bootstrap`
        : null
  };

  console.log('\n=== CONCLUSÃO ===');
  console.log(JSON.stringify(out.conclusao, null, 2));
  console.log('\n=== RELATÓRIO COMPLETO ===');
  console.log(JSON.stringify(out, null, 2));

  await closeBrowser();
}

main().catch(async (e) => {
  console.error(e);
  await closeBrowser().catch(() => {});
  process.exit(1);
});
