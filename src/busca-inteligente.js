/**
 * Busca inteligente: índice bulk → matching local → estratégias progressivas com cache.
 */
import { scrapeRemuneracoes } from './scraper.js';
import { transformar, upsertRegistrosFolha } from './sync.js';
import {
  estrategiasBuscaProgressiva,
  calcularScoreMatch,
  deveGravarMatch,
  classificarPendentes,
  cruzarComIndice,
  GiapBulkIndex,
  GiapSearchCache,
  criarStatsBusca,
  registrarEstrategia,
  resumoEstrategias,
  matKey
} from './matching.js';

/**
 * Processa lote de pendentes com matching inteligente.
 */
export async function processarPendentesInteligente({
  pendentes,
  competencia,
  bulkIndex = null,
  cache = null,
  cedencias = { ids: new Set(), mats: new Set() },
  codigoOrgao = '9',
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

  stats.total_rh = pendentes.length;
  stats.pendentes_iniciais = pendentes.length;
  stats.bulk_util = indice.size;

  const { ordem } = classificarPendentes(pendentes, cedencias);

  // 1) Cruzamento local com índice bulk (sem GIAP)
  const cruzado = cruzarComIndice(ordem, indice, {
    matsCedidos,
    cedidosIds: cedencias.ids
  });
  stats.bulk_matches = cruzado.matches.length;
  stats.matches_seguros += cruzado.stats.matches_seguros;
  stats.matches_provaveis += cruzado.stats.matches_provaveis;
  stats.rejeitados += cruzado.stats.rejeitados;

  const gravadosBulk = [];
  for (const m of cruzado.matches) {
    if (m.pendente.eh_cedido || m.pendente.grupo === 'D') stats.cedidos_processados++;
    const reg = transformar({ ...m.item, competencia });
    const { inseridos, registros } = await upsertRegistrosFolha([reg]);
    if (inseridos > 0) {
      gravadosBulk.push({ pendente: m.pendente, registros, score: m.score });
      jobCache.marcarResolvido(m.pendente.funcionario_id);
      metricas?.registrarUpsert(inseridos);
    }
  }

  let restantes = cruzado.restantes.filter((p) => !jobCache.jaResolvido(p.funcionario_id));
  const fila = restantes.slice(0, maxBuscas);

  const debugNomes = [];
  const resultados = [...gravadosBulk];
  let scrapesNome = 0;
  let nomesEncontrados = 0;
  let nomesVazios = 0;
  let nomesRejeitados = 0;

  const runScrape = comTimeout
    ? (fn, label) => comTimeout(fn(), watchdogMs, label)
    : (fn) => fn();

  const tNomes = Date.now();

  for (let i = 0; i < fila.length; i++) {
    const pendente = fila[i];
    if (jobCache.jaResolvido(pendente.funcionario_id)) continue;

    const ehCedido =
      cedencias.ids.has(pendente.funcionario_id) ||
      (pendente.matricula && cedencias.mats.has(String(pendente.matricula).trim()));

    const matsOk = pendente.matricula
      ? [String(pendente.matricula).trim()]
      : ehCedido
        ? [...cedencias.mats]
        : [];

    const estrategias = estrategiasBuscaProgressiva(pendente.nome);
    let matchFinal = null;
    let scoreFinal = null;
    let melhorRejeitado = null;
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
          registrarEstrategia(stats, estrategia, data.length > 0, duracaoMs);
        } catch (e) {
          metricas?.registrarErro();
          registrarEstrategia(stats, estrategia, false, Date.now() - t1);
          continue;
        }
      }

      bruto = data.length;
      if (!data.length) continue;

      // Indexa para cruzamentos futuros no mesmo job
      indice.addItems(data, `nome:${estrategia}`);

      let melhor = null;
      let melhorScore = null;
      for (const item of data) {
        const sc = calcularScoreMatch(pendente, item, {
          matsCedidos,
          cedidosIds: cedencias.ids,
          ehCedido
        });
        if (sc.score > (melhorScore?.score || 0)) {
          melhor = item;
          melhorScore = sc;
        }
      }

      if (melhor && melhorScore && deveGravarMatch(melhorScore, pendente)) {
        matchFinal = melhor;
        scoreFinal = melhorScore;
        estrategiaUsada = estrategia;
        break;
      }

      if (melhorScore && melhorScore.score > (melhorRejeitado?.score || 0)) {
        melhorRejeitado = melhorScore;
      }
    }

    if (!scoreFinal && melhorRejeitado) scoreFinal = melhorRejeitado;

    if (matchFinal && scoreFinal) {
      const reg = transformar({ ...matchFinal, competencia });
      const { inseridos, registros } = await upsertRegistrosFolha([reg]);
      if (inseridos > 0) {
        nomesEncontrados++;
        stats.matches_nome++;
        if (scoreFinal.nivel === 'seguro') stats.matches_seguros++;
        else stats.matches_provaveis++;
        if (ehCedido) stats.cedidos_processados++;
        jobCache.marcarResolvido(pendente.funcionario_id);
        metricas?.registrarUpsert(inseridos);
        resultados.push({
          pendente,
          registros,
          score: scoreFinal,
          estrategia: estrategiaUsada
        });
      } else {
        nomesVazios++;
        stats.sem_match++;
      }
    } else {
      nomesVazios++;
      stats.sem_match++;
      if (debugNomes.length < 5) {
        debugNomes.push({
          nome_rh: pendente.nome,
          matricula_rh: pendente.matricula,
          estrategias_tentadas: estrategias,
          ultima_busca: ultimaBusca,
          bruto,
          score_melhor: scoreFinal?.score,
          nivel: scoreFinal?.nivel,
          motivo: scoreFinal?.motivo
        });
      }
    }

    if (onProgress) {
      await onProgress({
        i: i + 1,
        total: fila.length,
        nome: pendente.nome,
        encontrados: nomesEncontrados
      });
    }
  }

  stats.tempo_nomes_ms = Date.now() - tNomes;
  stats.tempo_total_ms = Date.now() - t0;
  stats.estrategias_resumo = resumoEstrategias(stats);

  const buscasPendentes = Math.max(0, restantes.length - fila.length);

  return {
    stats,
    indice,
    cache: jobCache,
    resultados,
    scrapes_nome: scrapesNome,
    nomes_encontrados: nomesEncontrados + gravadosBulk.length,
    nomes_vazios: nomesVazios,
    nomes_rejeitados: nomesRejeitados,
    buscas_nome: fila.length,
    buscas_nome_pendentes: buscasPendentes,
    debug_nomes: debugNomes,
  gravados_bulk: gravadosBulk.length
  };
}
