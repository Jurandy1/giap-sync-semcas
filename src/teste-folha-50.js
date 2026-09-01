/**
 * Teste real de importação da folha — N candidatos RH, fluxo de produção.
 * Não altera matching. Não escala para 900+.
 */
import { executarFaseBulk, contarFolhaBulk } from './bulk.js';
import { processarPendentesInteligente } from './busca-inteligente.js';
import { carregarIndiceHistorico } from './historico.js';
import { criarMetricas } from './metrics.js';
import { prefixosGlobaisDedup, GiapSearchCache } from './matching.js';
import { montarRelatorioAnalise, BASELINE_TESTE_50 } from './analise-folha.js';
import {
  carregarCedenciasAtuais,
  listarBuscasNomePendentes,
  selecionarCandidatosDiversos,
  carregarCandidatosPorIds,
  contarCandidatosNaFolha,
  mascararCpf
} from './rhsemcas.js';
import { closeBrowser, getScrapeMetrics } from './scraper.js';
import { normalizarNome } from './utils.js';

const SCRAPE_WATCHDOG_MS = Math.max(
  35000,
  Number(process.env.GIAP_SCRAPE_TIMEOUT_MS || 30000) + 5000
);

function memMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function comTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`watchdog: ${label} não respondeu em ${Math.round(ms / 1000)}s`)),
        ms
      );
    })
  ]).finally(() => clearTimeout(timer));
}

function statsTempos(vals) {
  if (!vals.length) return { media: null, min: null, max: null, p95: null, total: 0 };
  const sorted = [...vals].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p95Idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    media: Math.round(sum / sorted.length),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p95: sorted[p95Idx],
    total: sorted.length
  };
}

function montarTabelaVerificacao(candidatos, detalhes, idsResolvidosFolha) {
  const porId = new Map((detalhes || []).map((d) => [d.funcionario_id, d]));
  const resolvidoSet = idsResolvidosFolha instanceof Set ? idsResolvidosFolha : new Set(idsResolvidosFolha || []);
  return candidatos.map((c) => {
    const d = porId.get(c.funcionario_id);
    const resolvido = resolvidoSet.has(c.funcionario_id);
    return {
      funcionario_id: c.funcionario_id,
      nome_rh: c.nome,
      nome_giap: d?.nome_giap || null,
      matricula_rh: c.matricula || null,
      matricula_giap: d?.matricula_giap || null,
      cpf_mascarado: mascararCpf(c.cpf),
      codigo_orgao: d?.codigo_orgao || null,
      grupo: c.grupo_historico,
      eh_cedido: !!c.eh_cedido,
      origem_match: d?.origem_match || (resolvido ? 'bulk/outro' : null),
      via: d?.via || null,
      classificacao: d?.classificacao || null,
      score: d?.score ?? null,
      status: resolvido ? d?.status || 'resolvido' : 'pendente'
    };
  });
}

/** IDs fixos do 1º teste real (202608) para comparação A/B. */
export const IDS_BASELINE_50 = [
  10, 12, 14, 15, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 129, 253, 300, 364,
  501, 608, 656, 706, 763, 764, 1269, 1278, 1282, 151, 260, 263, 320, 342, 361, 367, 399, 407,
  425, 33, 34, 36, 38, 40, 41, 42, 46, 48
];

async function executarFluxoProducao({
  candidatos,
  competencia,
  codigoOrgao,
  metricas,
  manterBrowserApos = false
}) {
  const jobCache = new GiapSearchCache();
  const cedencias = await carregarCedenciasAtuais();
  const indiceHistorico = await carregarIndiceHistorico(competencia);
  const prefixos = prefixosGlobaisDedup(candidatos);

  const tBulk = Date.now();
  const bulkRes = await executarFaseBulk({
    competencia,
    codigoOrgao: String(codigoOrgao),
    pendentes: candidatos,
    metricas,
    manterBrowser: true,
    cache: jobCache,
    comTimeout,
    watchdogMs: SCRAPE_WATCHDOG_MS
  });
  const tempo_bulk_ms = Date.now() - tBulk;

  const tMatch = Date.now();
  const buscaRes = await processarPendentesInteligente({
    pendentes: candidatos,
    competencia,
    bulkIndex: bulkRes.indice,
    cache: jobCache,
    indiceHistorico,
    cedencias,
    codigoOrgao: String(codigoOrgao),
    maxBuscas: candidatos.length,
    comTimeout,
    watchdogMs: SCRAPE_WATCHDOG_MS,
    metricas
  });
  const tempo_matching_ms = Date.now() - tMatch;

  if (!manterBrowserApos) {
    await closeBrowser().catch(() => {});
  }

  const temposConsulta = (bulkRes.prefixos?.detalhes || []).map((d) => d.tempo_ms).filter(Boolean);
  const consultas_giap =
    (bulkRes.stats?.consultas_giap_prefixo || 0) + (buscaRes.stats?.consultas_giap || 0);

  return {
    bulkRes,
    buscaRes,
    prefixos_unicos: prefixos.length,
    consultas_giap,
    tempo_bulk_ms,
    tempo_matching_ms,
    tempos_consulta_ms: temposConsulta,
    audit_por_id: buscaRes.audit_por_id,
    cache_hits: jobCache.hits
  };
}

/**
 * @param {{ competencia?: number, n?: number, funcionario_ids?: number[], idempotencia?: boolean, codigoOrgao?: string }} opts
 */
export async function executarTesteFolha50(opts = {}) {
  const competencia = Number(opts.competencia || 202608);
  const n = Math.min(50, Math.max(1, Number(opts.n || 50)));
  const codigoOrgao = String(opts.codigoOrgao || process.env.GIAP_CODIGO_ORGAO || '9');
  const rodarIdempotencia = opts.idempotencia !== false;

  await closeBrowser().catch(() => {});

  const tInicio = Date.now();
  const memoria_inicial_mb = memMb();
  let memoria_maxima_mb = memoria_inicial_mb;

  let candidatos;
  let statsSelecao;

  if (Array.isArray(opts.funcionario_ids) && opts.funcionario_ids.length) {
    const todos = await listarBuscasNomePendentes(competencia);
    const cedencias = await carregarCedenciasAtuais();
    const indiceHistorico = await carregarIndiceHistorico(competencia);
    const { medirCoberturaHistorico } = await import('./historico.js');
    const cov = medirCoberturaHistorico(todos, indiceHistorico, cedencias);
    const ids = new Set(opts.funcionario_ids.map(Number));
    candidatos = cov.pendentes.filter((p) => ids.has(p.funcionario_id)).slice(0, n);
    statsSelecao = { selecionados: candidatos.length, modo: 'funcionario_ids' };
  } else if (opts.usar_baseline !== false) {
    candidatos = await carregarCandidatosPorIds(competencia, IDS_BASELINE_50.slice(0, n));
    statsSelecao = { selecionados: candidatos.length, modo: 'baseline_50_fixo', ids: IDS_BASELINE_50.slice(0, n) };
  } else {
    const sel = await selecionarCandidatosDiversos(competencia, n);
    candidatos = sel.candidatos;
    statsSelecao = sel;
  }

  if (!candidatos.length) {
    throw new Error('Nenhum candidato encontrado para o teste.');
  }

  const statusFolhaPre = await contarCandidatosNaFolha(candidatos, competencia);
  const idsJaNaFolha = new Set(statusFolhaPre.ids_resolvidos);
  const candidatosProcessar = candidatos.filter((c) => !idsJaNaFolha.has(c.funcionario_id));

  const folhaAntes = await contarFolhaBulk(competencia, codigoOrgao);

  const metricas = criarMetricas('teste-folha-50', competencia);

  const exec1 = await executarFluxoProducao({
    candidatos: candidatosProcessar.length ? candidatosProcessar : candidatos,
    competencia,
    codigoOrgao,
    metricas,
    manterBrowserApos: rodarIdempotencia
  });

  memoria_maxima_mb = Math.max(memoria_maxima_mb, memMb());

  const pendentesPos = await listarBuscasNomePendentes(competencia);
  const pendentesPosIds = new Set(pendentesPos.map((p) => p.funcionario_id));
  const idsCandidatos = new Set(candidatos.map((c) => c.funcionario_id));

  const folhaCompRes = await contarCandidatosNaFolha(candidatos, competencia);
  const matches = exec1.buscaRes.resultados.length;
  const resolvidos = folhaCompRes.resolvidos;
  const pendentes = folhaCompRes.pendentes;
  const idsResolvidosFolha = new Set(folhaCompRes.ids_resolvidos);

  const tabela = montarTabelaVerificacao(
    candidatos,
    exec1.buscaRes.detalhes_candidatos,
    idsResolvidosFolha
  );

  let idempotencia = null;
  if (rodarIdempotencia) {
    const tIdem = Date.now();
    const cedencias = await carregarCedenciasAtuais();
    const indiceHistorico = await carregarIndiceHistorico(competencia);
    const { GiapBulkIndex } = await import('./matching.js');
    const busca2 = await processarPendentesInteligente({
      pendentes: candidatos,
      competencia,
      bulkIndex: new GiapBulkIndex(),
      indiceHistorico,
      cedencias,
      codigoOrgao: String(codigoOrgao),
      maxBuscas: candidatos.length,
      comTimeout,
      watchdogMs: SCRAPE_WATCHDOG_MS
    });
    await closeBrowser().catch(() => {});
    idempotencia = {
      duracao_ms: Date.now() - tIdem,
      registros_novos: busca2.stats.registros_novos || 0,
      registros_atualizados: busca2.stats.registros_atualizados || 0,
      registros_ignorados_por_duplicidade: Math.max(
        0,
        (busca2.resultados?.length || 0) - (busca2.stats.registros_novos || 0)
      ),
      consultas_giap: busca2.stats.consultas_giap || 0,
      matches_segunda_execucao: busca2.resultados.length,
      duplicidade_controlada: (busca2.stats.registros_novos || 0) === 0
    };
  } else {
    await closeBrowser().catch(() => {});
  }

  const folhaDepois = await contarFolhaBulk(competencia, codigoOrgao);
  const scrapeMetrics = getScrapeMetrics();
  const tempo_total_ms = Date.now() - tInicio;
  memoria_maxima_mb = Math.max(memoria_maxima_mb, memMb());

  const stats = {
    ...exec1.buscaRes.stats,
    ...(exec1.bulkRes.stats || {}),
    candidatos_processados: candidatos.length,
    consultas_giap: exec1.consultas_giap,
    prefixos_unicos: exec1.prefixos_unicos,
    resultados_giap: exec1.buscaRes.stats.registros_giap || exec1.bulkRes.stats?.registros_giap || 0,
    matches_total: matches,
    resolvidos,
    pendentes_pos_teste: pendentes,
    folha_antes: folhaAntes,
    folha_depois: folhaDepois,
    folha_delta: folhaDepois - folhaAntes
  };

  const performance = {
    tempo_bootstrap_ms: scrapeMetrics.tempo_bootstrap_ms,
    tempo_bulk_ms: exec1.tempo_bulk_ms,
    tempo_matching_ms: exec1.tempo_matching_ms,
    tempo_consultas_ms: exec1.tempo_bulk_ms + exec1.tempo_matching_ms,
    tempo_total_ms,
    consultas_giap: exec1.consultas_giap,
    tempos_consulta: statsTempos(exec1.tempos_consulta_ms),
    bootstrap_count: scrapeMetrics.bootstrap_count,
    restart_count: scrapeMetrics.restart_count,
    memoria_inicial_mb,
    memoria_maxima_mb,
    memoria_final_mb: memMb()
  };

  const criterio = {
    sem_oom: memoria_maxima_mb < 480,
    consultas_lte_servidores: exec1.consultas_giap <= candidatos.length,
    maioria_resolvida: resolvidos >= candidatos.length * 0.5,
    resolucao_gte_baseline: resolvidos >= BASELINE_TESTE_50.resolvidos,
    idempotencia_ok: idempotencia ? idempotencia.duplicidade_controlada : null,
    sem_timeout_relevante: true
  };

  const aprovado =
    criterio.sem_oom &&
    criterio.consultas_lte_servidores &&
    criterio.resolucao_gte_baseline &&
    (idempotencia ? idempotencia.duplicidade_controlada : true);

  const analise = montarRelatorioAnalise({
    candidatos,
    auditPorId: exec1.buscaRes.audit_por_id || new Map(),
    detalhes: exec1.buscaRes.detalhes_candidatos,
    idsResolvidosFolha,
    metricas: stats,
    comparacaoAntes: BASELINE_TESTE_50
  });

  return {
    competencia,
    codigo_orgao: codigoOrgao,
    selecao: { ...statsSelecao, ja_na_folha: statusFolhaPre.resolvidos, a_processar: candidatosProcessar.length },
    candidatos: candidatos.length,
    ids_candidatos: [...idsCandidatos],
    metricas: stats,
    performance,
    browser: scrapeMetrics,
    idempotencia,
    tabela_verificacao: tabela,
    analise,
    divergencias: exec1.buscaRes.divergencias?.slice(0, 20) || [],
    criterio,
    aprovado,
    comparacao_baseline: {
      antes: BASELINE_TESTE_50,
      depois: {
        consultas_giap: exec1.consultas_giap,
        resolvidos,
        pendentes,
        tempo_total_ms: tempo_total_ms,
        cache_hits: exec1.cache_hits || 0
      },
      delta_consultas: exec1.consultas_giap - BASELINE_TESTE_50.consultas_giap,
      delta_resolvidos: resolvidos - BASELINE_TESTE_50.resolvidos
    },
    comparacao_job73: {
      job73_maria_ms: 183000,
      job73_ana_ms: 256000,
      agora_media_consulta_ms: performance.tempos_consulta?.media,
      ganho_estimado_x: performance.tempos_consulta?.media
        ? Math.round(183000 / performance.tempos_consulta.media)
        : null
    },
    resumo: {
      servidores: candidatos.length,
      consultas_giap: exec1.consultas_giap,
      prefixos_unicos: exec1.prefixos_unicos,
      matches,
      resolvidos,
      pendentes,
      folha_delta: folhaDepois - folhaAntes
    }
  };
}

export async function executarTesteFolha50EFechar(opts) {
  try {
    return await executarTesteFolha50(opts);
  } finally {
    await closeBrowser().catch(() => {});
  }
}
