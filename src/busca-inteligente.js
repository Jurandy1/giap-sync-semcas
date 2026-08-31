/**
 * Busca inteligente: histórico → índice bulk → matching local → busca por exceção.
 */
import { scrapeRemuneracoes } from './scraper.js';
import { transformar, upsertRegistrosFolha } from './sync.js';
import {
  avaliarMatch,
  deveGravarMatch,
  cruzarComIndice,
  matchPendenteNoIndice,
  GiapBulkIndex,
  GiapSearchCache,
  criarStatsBusca,
  registrarEstrategia,
  resumoEstrategias,
  CLASSIFICACAO,
  matKey,
  codigoOrgaoParaBusca
} from './matching.js';
import { normalizarRespostaLista } from './utils.js';
import {
  estrategiasComHistorico,
  medirCoberturaHistorico,
  carregarIndiceHistorico,
  historicoEhConfiavel
} from './historico.js';

function origemMatchDeResultado(r) {
  const fatores = r.avaliacao?.fatores || [];
  const via = r.via || '';
  if (via === 'bulk_local' || r.estrategia?.startsWith?.('prefixo')) return 'prefixo';
  if (via === 'indice_local' || via === 'bulk_local') return 'bulk';
  if (via === 'historico' || fatores.some((f) => /historico/i.test(f))) return 'historico';
  if (fatores.some((f) => /matricula/i.test(f) && !/historico/i.test(f))) return 'matricula';
  if (fatores.some((f) => /cpf/i.test(f))) return 'cpf';
  if (via === 'nome') return 'nome';
  return via || 'desconhecido';
}

function registrarMatchPorOrigem(stats, origem) {
  const k = `matches_por_${origem}`;
  if (stats[k] != null) stats[k]++;
  else stats[k] = 1;
}

function linhaDetalheCandidato(pendente, r, opts = {}) {
  const reg = r?.registros?.[0];
  return {
    funcionario_id: pendente.funcionario_id,
    nome_rh: pendente.nome,
    matricula_rh: pendente.matricula || null,
    cpf_mascarado: pendente.cpf ? `***${String(pendente.cpf).slice(-4)}` : null,
    grupo: pendente.grupo_historico,
    eh_cedido: !!pendente.eh_cedido,
    nome_giap: reg?.funcionario || r?.nome_giap || null,
    matricula_giap: reg?.matricula ?? null,
    codigo_orgao: reg?.codigo_orgao ?? r?.item?.codigo_orgao ?? null,
    origem_match: r ? origemMatchDeResultado(r) : null,
    via: r?.via || null,
    estrategia: r?.estrategia || null,
    classificacao: r?.classificacao || opts.classificacao || null,
    score: r?.avaliacao?.sim ?? null,
    status: opts.status || (r ? 'match' : 'sem_match'),
    tempo_ms: opts.tempo_ms ?? null,
    motivo: opts.motivo || r?.avaliacao?.motivo || null
  };
}

export async function processarPendentesInteligente({
  pendentes,
  competencia,
  bulkIndex = null,
  cache = null,
  indiceHistorico = null,
  cedencias = { ids: new Set(), mats: new Set() },
  codigoOrgao = process.env.GIAP_CODIGO_ORGAO || '9',
  maxBuscas = 3,
  comTimeout = null,
  watchdogMs = 180000,
  metricas = null,
  onProgress = null
} = {}) {
  const stats = criarStatsBusca();
  stats.matches_por_historico = 0;
  stats.matches_por_matricula = 0;
  stats.matches_por_cpf = 0;
  stats.matches_por_nome = 0;
  stats.matches_por_bulk = 0;
  stats.matches_por_prefixo = 0;
  stats.cedidos_resolvidos = 0;
  stats.rejeitados = 0;
  stats.registros_novos = 0;
  stats.registros_atualizados = 0;
  stats.consultas_giap = 0;
  stats.candidatos_processados = 0;
  stats.prefixos_unicos_exec = 0;
  const detalhesCandidatos = [];
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
    const ups = await upsertRegistrosFolha([reg]);
    if (ups.inseridos > 0) {
      stats.resultados_por_bulk++;
      stats.registros_novos += ups.novos || 0;
      stats.registros_atualizados += ups.atualizados || 0;
      const rObj = {
        pendente: m.pendente,
        registros: ups.registros,
        classificacao: m.classificacao,
        avaliacao: m.score,
        via: 'bulk_local'
      };
      gravadosBulk.push(rObj);
      registrarMatchPorOrigem(stats, 'bulk');
      if (m.pendente.eh_cedido) stats.cedidos_resolvidos++;
      detalhesCandidatos.push(linhaDetalheCandidato(m.pendente, rObj));
      jobCache.marcarResolvido(m.pendente.funcionario_id);
      metricas?.registrarUpsert(ups.inseridos);
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
    stats.candidatos_processados++;
    const tCand = Date.now();
    if (jobCache.jaResolvido(pendente.funcionario_id)) continue;

    const ehCedido =
      pendente.eh_cedido ||
      cedencias.ids.has(pendente.funcionario_id) ||
      (pendente.matricula && cedencias.mats.has(String(pendente.matricula).trim()));

    const usaHistorico = historicoEhConfiavel(pendente.historico);
    const estrategias = estrategiasComHistorico(pendente, pendente.historico);
    const codigoOrgaoBusca = codigoOrgaoParaBusca(pendente, codigoOrgao);

    // Reutiliza índice bulk/histórico antes de chamar GIAP
    const localPre = matchPendenteNoIndice(pendente, indice, {
      matsCedidos,
      cedidosIds: cedencias.ids,
      ehCedido
    });
    if (localPre?.classificacao === CLASSIFICACAO.DIVERGENCIA) {
      stats.divergencias++;
      stats.rejeitados++;
      divergencias.push({ pendente, item: localPre.item, avaliacao: localPre.avaliacao, estrategia: 'indice_local' });
      stats.sem_match++;
      detalhesCandidatos.push(
        linhaDetalheCandidato(pendente, null, {
          status: 'divergencia',
          classificacao: CLASSIFICACAO.DIVERGENCIA,
          motivo: localPre.avaliacao?.motivo
        })
      );
      continue;
    }
    if (localPre && deveGravarMatch(localPre.avaliacao)) {
      const reg = transformar({ ...localPre.item, competencia });
      const ups = await upsertRegistrosFolha([reg]);
      if (ups.inseridos > 0) {
        stats.matches_nome++;
        stats.resultados_por_bulk++;
        stats.registros_novos += ups.novos || 0;
        stats.registros_atualizados += ups.atualizados || 0;
        stats.chamadas_giap_evitadas++;
        stats.chamadas_giap_evitadas_matching_local++;
        if (usaHistorico) stats.chamadas_giap_evitadas_historico++;
        if (localPre.avaliacao.classificacao === CLASSIFICACAO.SEGURO) stats.matches_seguros++;
        else stats.matches_provaveis++;
        const rObj = {
          pendente,
          registros: ups.registros,
          classificacao: localPre.classificacao,
          avaliacao: localPre.avaliacao,
          via: 'indice_local',
          estrategia: 'indice_local'
        };
        registrarMatchPorOrigem(stats, origemMatchDeResultado(rObj));
        if (ehCedido) stats.cedidos_resolvidos++;
        detalhesCandidatos.push(linhaDetalheCandidato(pendente, rObj));
        jobCache.marcarResolvido(pendente.funcionario_id);
        metricas?.registrarUpsert(ups.inseridos);
        resultados.push(rObj);
        continue;
      }
    }

    let matchFinal = null;
    let avalFinal = null;
    let melhorDivergencia = null;
    let estrategiaUsada = null;
    let bruto = 0;
    let ultimaBusca = null;

    for (const estrategia of estrategias) {
      stats.tentativas_nome++;
      ultimaBusca = estrategia;
      const cacheKey = `${estrategia}|org:${codigoOrgaoBusca || 'none'}`;
      const cacheHit = jobCache.get(cacheKey);
      let data;
      let duracaoMs = 0;

      if (cacheHit) {
        data = cacheHit.data;
        if (!Array.isArray(data)) {
          const norm = normalizarRespostaLista(data);
          if (norm.erro) throw new Error(norm.erro);
          data = norm.lista;
        }
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
                codigoOrgao: codigoOrgaoBusca,
                nomeServidor: estrategia,
                quantidade: 100
              }),
            `sync_nome_${estrategia}_org${codigoOrgaoBusca || '0'}`
          );
          const norm = normalizarRespostaLista(r.data, { requestUrl: r.requestUrl, rawPrefix: r.raw });
          if (norm.erro) throw new Error(norm.erro);
          data = norm.lista;
          duracaoMs = Date.now() - t1;
          jobCache.set(cacheKey, { data, duracao_ms: duracaoMs });
          scrapesNome++;
          stats.buscas_nome++;
          stats.consultas_giap++;
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
      stats.rejeitados++;
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
      detalhesCandidatos.push(
        linhaDetalheCandidato(pendente, null, {
          status: 'divergencia',
          classificacao: CLASSIFICACAO.DIVERGENCIA,
          motivo: melhorDivergencia.avaliacao?.motivo,
          tempo_ms: Date.now() - tCand
        })
      );
      stats.sem_match++;
      continue;
    }

    if (matchFinal && avalFinal) {
      const reg = transformar({ ...matchFinal, competencia });
      const ups = await upsertRegistrosFolha([reg]);
      if (ups.inseridos > 0) {
        stats.matches_nome++;
        stats.registros_novos += ups.novos || 0;
        stats.registros_atualizados += ups.atualizados || 0;
        if (usaHistorico) stats.resultados_por_historico++;
        else stats.resultados_por_nome++;
        if (avalFinal.classificacao === CLASSIFICACAO.SEGURO) stats.matches_seguros++;
        else stats.matches_provaveis++;
        if (ehCedido) {
          stats.cedidos_processados++;
          stats.cedidos_resolvidos++;
        }
        const rObj = {
          pendente,
          registros: ups.registros,
          classificacao: avalFinal.classificacao,
          avaliacao: avalFinal,
          estrategia: estrategiaUsada,
          via: usaHistorico ? 'historico' : 'nome',
          nome_giap: matchFinal.funcionario,
          historico_comp: pendente.historico?.competencia
        };
        registrarMatchPorOrigem(stats, origemMatchDeResultado(rObj));
        detalhesCandidatos.push(
          linhaDetalheCandidato(pendente, rObj, { tempo_ms: Date.now() - tCand })
        );
        jobCache.marcarResolvido(pendente.funcionario_id);
        metricas?.registrarUpsert(ups.inseridos);
        resultados.push(rObj);
      } else {
        stats.sem_match++;
        detalhesCandidatos.push(
          linhaDetalheCandidato(pendente, null, { status: 'sem_match', tempo_ms: Date.now() - tCand })
        );
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
      detalhesCandidatos.push(
        linhaDetalheCandidato(pendente, null, { status: 'sem_match', tempo_ms: Date.now() - tCand })
      );
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
    gravados_bulk: gravadosBulk.length,
    detalhes_candidatos: detalhesCandidatos
  };
}

export { carregarIndiceHistorico, medirCoberturaHistorico };
