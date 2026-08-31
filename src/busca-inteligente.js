/**
 * Busca inteligente: histórico → índice bulk → matching local → busca por exceção.
 */
import { scrapeRemuneracoes } from './scraper.js';
import { transformar, upsertRegistrosFolha } from './sync.js';
import {
  avaliarMatch,
  deveGravarMatch,
  cruzarComIndice,
  GiapBulkIndex,
  GiapSearchCache,
  criarStatsBusca,
  registrarEstrategia,
  resumoEstrategias,
  CLASSIFICACAO,
  matKey
} from './matching.js';
import {
  estrategiasComHistorico,
  medirCoberturaHistorico,
  carregarIndiceHistorico,
  historicoEhConfiavel
} from './historico.js';

export async function processarPendentesInteligente({
  pendentes,
  competencia,
  bulkIndex = null,
  cache = null,
  indiceHistorico = null,
  cedencias = { ids: new Set(), mats: new Set() },
  maxBuscas = 3,
  comTimeout = null,
  watchdogMs = 180000,
  metricas = null,
  onProgress = null
} = {}) {
  const stats = criarStatsBusca();
  const t0 = Date.now();
  const indice = bulkIndex || new GiapBulkIndex();
  const jobCache = cache || new GiapSearchCache();
  const matsCedidos = new Set([...cedencias.mats].map((m) => matKey(m)).filter(Boolean));

  const histIdx = indiceHistorico || (await carregarIndiceHistorico(competencia));
  const { stats: histStats, pendentes: enriquecidos } = medirCoberturaHistorico(
    pendentes,
    histIdx,
    cedencias
  );
  Object.assign(stats, histStats);

  stats.total_rh = enriquecidos.length;
  stats.total_pendentes = enriquecidos.length;
  stats.pendentes_iniciais = enriquecidos.length;
  stats.bulk_util = indice.size;

  const cruzado = cruzarComIndice(enriquecidos, indice, {
    matsCedidos,
    cedidosIds: cedencias.ids
  });
  stats.bulk_matches = cruzado.matches.length;
  stats.matches_seguros += cruzado.stats.matches_seguros;
  stats.matches_provaveis += cruzado.stats.matches_provaveis;
  stats.divergencias += cruzado.stats.divergencias;
  stats.chamadas_giap_evitadas += cruzado.stats.chamadas_giap_evitadas;
  stats.chamadas_giap_evitadas_matching_local += cruzado.stats.chamadas_giap_evitadas;

  const gravadosBulk = [];
  const divergencias = [...(cruzado.divergencias || [])];

  for (const m of cruzado.matches) {
    if (m.pendente.eh_cedido || m.pendente.grupo_historico === 'D') stats.cedidos_processados++;
    const reg = transformar({ ...m.item, competencia });
    const { inseridos, registros } = await upsertRegistrosFolha([reg]);
    if (inseridos > 0) {
      stats.resultados_por_bulk++;
      gravadosBulk.push({
        pendente: m.pendente,
        registros,
        classificacao: m.classificacao,
        avaliacao: m.score,
        via: 'bulk_local'
      });
      jobCache.marcarResolvido(m.pendente.funcionario_id);
      metricas?.registrarUpsert(inseridos);
    }
  }

  let restantes = cruzado.restantes.filter((p) => !jobCache.jaResolvido(p.funcionario_id));
  const fila = restantes.slice(0, maxBuscas);

  const debugNomes = [];
  const resultados = [...gravadosBulk];
  let scrapesNome = 0;

  const runScrape = comTimeout
    ? (fn, label) => comTimeout(fn(), watchdogMs, label)
    : (fn) => fn();

  const tNomes = Date.now();

  for (let i = 0; i < fila.length; i++) {
    const pendente = fila[i];
    if (jobCache.jaResolvido(pendente.funcionario_id)) continue;

    const ehCedido =
      pendente.eh_cedido ||
      cedencias.ids.has(pendente.funcionario_id) ||
      (pendente.matricula && cedencias.mats.has(String(pendente.matricula).trim()));

    const usaHistorico = historicoEhConfiavel(pendente.historico);
    const estrategias = estrategiasComHistorico(pendente, pendente.historico);

    let matchFinal = null;
    let avalFinal = null;
    let melhorDivergencia = null;
    let estrategiaUsada = null;
    let bruto = 0;
    let ultimaBusca = null;

    for (const estrategia of estrategias) {
      stats.tentativas_nome++;
      ultimaBusca = estrategia;
      const cacheHit = jobCache.get(estrategia);
      let data;
      let duracaoMs = 0;

      if (cacheHit) {
        data = cacheHit.data || [];
        duracaoMs = cacheHit.duracao_ms || 0;
        stats.chamadas_giap_evitadas++;
        if (usaHistorico) stats.chamadas_giap_evitadas_historico++;
        registrarEstrategia(stats, `${estrategia}_cache`, data.length > 0, duracaoMs);
      } else {
        const t1 = Date.now();
        try {
          const r = await runScrape(
            () =>
              scrapeRemuneracoes({
                competencia,
                codigoInstituicao: 1,
                nomeServidor: estrategia,
                quantidade: 100
              }),
            `sync_nome_${estrategia}`
          );
          data = r.data || [];
          duracaoMs = Date.now() - t1;
          jobCache.set(estrategia, { data, duracao_ms: duracaoMs });
          scrapesNome++;
          stats.buscas_nome++;
          metricas?.registrarScrape('nome', duracaoMs);
          registrarEstrategia(
            stats,
            usaHistorico ? `historico:${estrategia}` : estrategia,
            data.length > 0,
            duracaoMs
          );
        } catch (e) {
          metricas?.registrarErro();
          registrarEstrategia(stats, estrategia, false, Date.now() - t1);
          continue;
        }
      }

      bruto = data.length;
      if (!data.length) continue;

      indice.addItems(data, usaHistorico ? `historico:${estrategia}` : `nome:${estrategia}`);

      let melhor = null;
      let melhorAv = null;
      for (const item of data) {
        const av = avaliarMatch(pendente, item, {
          matsCedidos,
          cedidosIds: cedencias.ids,
          ehCedido
        });
        const prio = {
          [CLASSIFICACAO.SEGURO]: 4,
          [CLASSIFICACAO.PROVAVEL]: 3,
          [CLASSIFICACAO.DIVERGENCIA]: 2,
          [CLASSIFICACAO.SEM_MATCH]: 1
        };
        const cur = prio[av.classificacao] || 0;
        const best = melhorAv ? prio[melhorAv.classificacao] || 0 : 0;
        if (cur > best || (cur === best && (av.sim || 0) > (melhorAv?.sim || 0))) {
          melhor = item;
          melhorAv = av;
        }
      }

      if (melhorAv?.classificacao === CLASSIFICACAO.DIVERGENCIA) {
        melhorDivergencia = { item: melhor, avaliacao: melhorAv, estrategia };
        continue;
      }

      if (melhor && melhorAv && deveGravarMatch(melhorAv)) {
        matchFinal = melhor;
        avalFinal = melhorAv;
        estrategiaUsada = estrategia;
        break;
      }
    }

    if (melhorDivergencia && !matchFinal) {
      stats.divergencias++;
      divergencias.push({ pendente, ...melhorDivergencia });
      if (debugNomes.length < 8) {
        debugNomes.push({
          nome_rh: pendente.nome,
          matricula_rh: pendente.matricula,
          classificacao: CLASSIFICACAO.DIVERGENCIA,
          motivo: melhorDivergencia.avaliacao?.motivo,
          historico_comp: pendente.historico?.competencia,
          nome_giap_hist: pendente.historico?.funcionario,
          estrategia: melhorDivergencia.estrategia
        });
      }
      stats.sem_match++;
      continue;
    }

    if (matchFinal && avalFinal) {
      const reg = transformar({ ...matchFinal, competencia });
      const { inseridos, registros } = await upsertRegistrosFolha([reg]);
      if (inseridos > 0) {
        stats.matches_nome++;
        if (usaHistorico) stats.resultados_por_historico++;
        else stats.resultados_por_nome++;
        if (avalFinal.classificacao === CLASSIFICACAO.SEGURO) stats.matches_seguros++;
        else stats.matches_provaveis++;
        if (ehCedido) stats.cedidos_processados++;
        jobCache.marcarResolvido(pendente.funcionario_id);
        metricas?.registrarUpsert(inseridos);
        resultados.push({
          pendente,
          registros,
          classificacao: avalFinal.classificacao,
          avaliacao: avalFinal,
          estrategia: estrategiaUsada,
          via: usaHistorico ? 'historico' : 'nome',
          nome_giap: matchFinal.funcionario,
          historico_comp: pendente.historico?.competencia
        });
      } else {
        stats.sem_match++;
      }
    } else {
      stats.sem_match++;
      if (debugNomes.length < 8) {
        debugNomes.push({
          nome_rh: pendente.nome,
          matricula_rh: pendente.matricula,
          grupo: pendente.grupo_historico,
          historico_comp: pendente.historico?.competencia,
          nome_giap_hist: pendente.historico?.funcionario,
          estrategias_tentadas: estrategias,
          ultima_busca: ultimaBusca,
          bruto,
          classificacao: CLASSIFICACAO.SEM_MATCH
        });
      }
    }

    if (onProgress) {
      await onProgress({ i: i + 1, total: fila.length, nome: pendente.nome, grupo: pendente.grupo_historico });
    }
  }

  stats.tempo_nomes_ms = Date.now() - tNomes;
  stats.tempo_total_ms = Date.now() - t0;
  stats.chamadas_giap_evitadas += jobCache.hits;
  stats.estrategias_resumo = resumoEstrategias(stats);

  return {
    stats,
    indice,
    cache: jobCache,
    resultados,
    divergencias,
    historico: histStats,
    scrapes_nome: scrapesNome,
    nomes_encontrados: resultados.length,
    nomes_vazios: stats.sem_match,
    buscas_nome: fila.length,
    buscas_nome_pendentes: Math.max(0, restantes.length - fila.length),
    debug_nomes: debugNomes,
    gravados_bulk: gravadosBulk.length
  };
}

export { carregarIndiceHistorico, medirCoberturaHistorico };
