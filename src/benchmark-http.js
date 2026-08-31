/**
 * Benchmark HTTP + sessão vs Puppeteer APEX.
 * NÃO altera folha. NÃO executa sync completa.
 */
import { fetchRemuneracoesHttp, buildRemuneracoesUrl } from './giap-http.js';
import { scrapeRemuneracoes, closeBrowser, getRemPageAtiva } from './scraper.js';
import { getSessionCookies, isSessionReady, tentarHttpComSessao } from './scraper-session.js';
import { ehFolhaSemcas } from './matching.js';

export const PREFIXOS_BENCHMARK = [
  'TERESINHA',
  'MARIA',
  'ANA',
  'TAMARA',
  'MATEUS',
  'SORAYA'
];

function memMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function contarSemcas(lista = []) {
  return lista.filter((i) => ehFolhaSemcas(i)).length;
}

function resumoHttp(r, prefixo) {
  const lista = r.data || [];
  const primeiro = lista[0];
  return {
    prefixo,
    metodo: r.metodo || r.via || 'http',
    status: r.status,
    tempo_http_ms: r.tempo_http_ms ?? r.tempo_ms,
    quantidade: r.count ?? lista.length,
    quantidade_semcas: contarSemcas(lista),
    primeiro_nome: primeiro?.funcionario || null,
    primeiro_matricula: primeiro?.matricula ?? null,
    ok: !!r.ok,
    erro: r.erro || null
  };
}

async function consultaHttpSessao(opts, prefixo) {
  const page = getRemPageAtiva();
  const hit = await tentarHttpComSessao(
    {
      competencia: opts.competencia,
      codigoInstituicao: opts.codigoInstituicao,
      codigoOrgao: opts.codigoOrgao,
      nomeServidor: prefixo,
      quantidade: opts.quantidade
    },
    page
  );
  if (hit) return resumoHttp(hit, prefixo);
  return resumoHttp(
    {
      ok: false,
      status: null,
      tempo_ms: 0,
      count: 0,
      erro: 'http_sessao_indisponivel'
    },
    prefixo
  );
}

function resumoPuppeteer(r, prefixo) {
  const lista = r.data || [];
  const t = r.timing || {};
  const primeiro = lista[0];
  return {
    prefixo,
    metodo: r.metodo || 'puppeteer_apex',
    tempo_total_ms: t.tempo_total,
    tempo_criar_browser: t.tempo_criar_browser,
    tempo_abrir_pagina: t.tempo_abrir_pagina,
    tempo_carregar_apex: t.tempo_carregar_apex,
    tempo_preencher_campos: t.tempo_preencher_campos,
    tempo_executar_ajax: t.tempo_executar_ajax,
    tempo_esperar_resultado: t.tempo_esperar_resultado,
    tempo_extrair_resultado: t.tempo_extrair_resultado,
    tempo_http_ms: t.tempo_http,
    pagina_reutilizada: t.pagina_reutilizada,
    browser_novo: t.browser_novo,
    quantidade: lista.length,
    quantidade_semcas: contarSemcas(lista),
    primeiro_nome: primeiro?.funcionario || null,
    primeiro_matricula: primeiro?.matricula ?? null,
    ok: lista.length > 0 || r.metodo === 'http_sessao',
    erro: null
  };
}

function statsTempos(items, campo = 'tempo_http_ms') {
  const vals = items.map((i) => i[campo]).filter((v) => typeof v === 'number' && v >= 0);
  if (!vals.length) return { media: null, min: null, max: null, total: 0 };
  const sum = vals.reduce((a, b) => a + b, 0);
  return {
    media: Math.round(sum / vals.length),
    min: Math.min(...vals),
    max: Math.max(...vals),
    total: vals.length
  };
}

function taxaSucesso(items) {
  if (!items.length) return 0;
  const ok = items.filter((i) => i.ok && !i.erro).length;
  return Math.round((ok / items.length) * 1000) / 10;
}

/**
 * Executa benchmark completo.
 * @param {{ competencia: number, org?: string, estabilidadeN?: number }} opts
 */
export async function executarBenchmarkHttp({
  competencia,
  org = process.env.GIAP_CODIGO_ORGAO || '9',
  estabilidadeN = 10
} = {}) {
  const tInicio = Date.now();
  const memoria_inicio_mb = memMb();
  const relatorio = {
    competencia,
    codigo_instituicao: 1,
    codigo_orgao: String(org),
    quantidade: 100,
    endpoint: buildRemuneracoesUrl({
      competencia,
      codigoInstituicao: 1,
      codigoOrgao: org,
      nomeServidor: 'TERESINHA',
      quantidade: 100
    }),
    memoria_inicio_mb,
    consultas: []
  };

  // 1) HTTP sem sessão
  const semSessao = await fetchRemuneracoesHttp({
    competencia,
    codigoInstituicao: 1,
    codigoOrgao: org,
    nomeServidor: 'TERESINHA',
    quantidade: 100
  });
  relatorio.http_sem_sessao = {
    status: semSessao.status,
    tempo_ms: semSessao.tempo_ms,
    ok: semSessao.ok,
    erro: semSessao.erro,
    bloqueado_esperado: semSessao.status === 401 || semSessao.status === 403
  };

  // 2) Bootstrap Puppeteer (1×)
  const tBoot = Date.now();
  const boot = await scrapeRemuneracoes({
    competencia,
    codigoInstituicao: 1,
    codigoOrgao: org,
    nomeServidor: 'TERESINHA',
    quantidade: 100,
    timeoutMs: 120000
  });
  const cookies = getSessionCookies() || [];
  relatorio.bootstrap = {
    metodo: boot.metodo || 'puppeteer_apex',
    tempo_total_ms: boot.timing?.tempo_total ?? Date.now() - tBoot,
    tempo_obter_cookies_ms: boot.timing?.tempo_carregar_apex,
    cookies_quantidade: cookies.length,
    cookies_nomes: cookies.map((c) => c.name).filter(Boolean),
    sessao_pronta: isSessionReady(),
    pagina_ativa: !!getRemPageAtiva(),
    quantidade: boot.data?.length ?? 0,
    quantidade_semcas: contarSemcas(boot.data),
    primeiro_nome: boot.data?.[0]?.funcionario || null,
    timing: boot.timing
  };

  // 3) HTTP com sessão — 6 prefixos (Node cookies → browser fetch)
  relatorio.http_com_sessao = [];
  const httpOpts = {
    competencia,
    codigoInstituicao: 1,
    codigoOrgao: org,
    quantidade: 100
  };
  for (const prefixo of PREFIXOS_BENCHMARK) {
    const item = await consultaHttpSessao(httpOpts, prefixo);
    relatorio.http_com_sessao.push(item);
    relatorio.consultas.push({ fase: 'http_sessao', ...item });
  }

  // 4) scrapeRemuneracoes pós-sessão (deve usar HTTP)
  relatorio.scrape_pos_sessao = [];
  for (const prefixo of ['MARIA', 'ANA']) {
    const r = await scrapeRemuneracoes({
      competencia,
      codigoInstituicao: 1,
      codigoOrgao: org,
      nomeServidor: prefixo,
      quantidade: 100,
      timeoutMs: 120000
    });
    const item = resumoPuppeteer(r, prefixo);
    relatorio.scrape_pos_sessao.push(item);
    relatorio.consultas.push({ fase: 'scrape_pos_sessao', ...item });
  }

  // 5) Estabilidade — N consultas HTTP sequenciais (repete prefixos)
  relatorio.estabilidade = { memoria_antes_mb: memMb(), consultas: [] };
  const ciclo = [...PREFIXOS_BENCHMARK];
  while (ciclo.length < estabilidadeN) ciclo.push(...PREFIXOS_BENCHMARK);
  for (let i = 0; i < estabilidadeN; i++) {
    const prefixo = ciclo[i];
    const item = {
      seq: i + 1,
      ...(await consultaHttpSessao(httpOpts, prefixo)),
      memoria_mb: memMb()
    };
    relatorio.estabilidade.consultas.push(item);
  }
  relatorio.estabilidade.memoria_depois_mb = memMb();
  relatorio.estabilidade.sucesso_consecutivo = relatorio.estabilidade.consultas.filter(
    (c) => c.ok
  ).length;
  relatorio.estabilidade.sessao_manteve = relatorio.estabilidade.sucesso_consecutivo >= 6;

  // Comparação
  const httpTempos = relatorio.http_com_sessao;
  const puppeteerTempos = relatorio.scrape_pos_sessao.filter(
    (s) => s.metodo === 'puppeteer_apex'
  );
  const scrapeHttpTempos = relatorio.scrape_pos_sessao.filter((s) => s.metodo === 'http_sessao');

  relatorio.comparacao = {
    http_direto: {
      ...statsTempos(httpTempos, 'tempo_http_ms'),
      taxa_sucesso_pct: taxaSucesso(httpTempos)
    },
    scrape_via_wrapper_http: {
      ...statsTempos(scrapeHttpTempos, 'tempo_total_ms'),
      taxa_sucesso_pct: taxaSucesso(scrapeHttpTempos)
    },
    puppeteer_apex_fallback: {
      ...statsTempos(puppeteerTempos, 'tempo_total_ms'),
      taxa_sucesso_pct: taxaSucesso(puppeteerTempos)
    },
    bootstrap_ms: relatorio.bootstrap.tempo_total_ms,
    ganho_medio_vs_bootstrap:
      relatorio.bootstrap.tempo_total_ms && statsTempos(httpTempos, 'tempo_http_ms').media
        ? Math.round(
            relatorio.bootstrap.tempo_total_ms / statsTempos(httpTempos, 'tempo_http_ms').media
          )
        : null
  };

  // Critérios de aprovação
  const c = relatorio.criterios = {
    bootstrap_ok: relatorio.bootstrap.sessao_pronta && relatorio.bootstrap.cookies_quantidade > 0,
    http_autenticado_ok: taxaSucesso(httpTempos) >= 80,
    json_correto_ok: httpTempos.some((h) => h.quantidade > 0),
    sessao_reutilizavel_ok: relatorio.estabilidade.sessao_manteve,
    dez_consultas_ok: relatorio.estabilidade.sucesso_consecutivo >= estabilidadeN * 0.8,
    sem_oom_ok: relatorio.estabilidade.memoria_depois_mb < 480,
    http_mais_rapido_ok:
      statsTempos(httpTempos, 'tempo_http_ms').media != null &&
      statsTempos(httpTempos, 'tempo_http_ms').media <
        (relatorio.bootstrap.tempo_total_ms || Infinity) / 2,
    http_sem_sessao_bloqueado: relatorio.http_sem_sessao.bloqueado_esperado
  };
  relatorio.aprovado = Object.values(c).every(Boolean);

  relatorio.memoria_fim_mb = memMb();
  relatorio.duracao_total_ms = Date.now() - tInicio;

  return relatorio;
}

export async function executarBenchmarkHttpEFechar(opts) {
  try {
    return await executarBenchmarkHttp(opts);
  } finally {
    await closeBrowser().catch(() => {});
  }
}
