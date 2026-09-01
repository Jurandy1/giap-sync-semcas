/**
 * Busca inteligente: histórico → índice bulk → matching local → busca adaptativa.
 */
import { scrapeRemuneracoes } from './scraper.js';
import { transformar, upsertRegistrosFolha } from './sync.js';
import { obterResultadosGiap } from './consulta-giap.js';
import { origemMatchPrincipal } from './analise-folha.js';
import {
  avaliarMatch,
  deveGravarMatch,
  cruzarComIndice,
  matchPendenteNoIndice,
  GiapBulkIndex,
  GiapSearchCache,
  criarStatsBusca,
  resumoEstrategias,
  CLASSIFICACAO,
  matKey,
  codigoOrgaoParaBusca
} from './matching.js';
import {
  estrategiasComHistorico,
  medirCoberturaHistorico,
  carregarIndiceHistorico,
  historicoEhConfiavel
} from './historico.js';

function linhaDetalheCandidato(pendente, r, opts = {}) {
  const reg = r?.registros?.[0];
  const origem = r
    ? origemMatchPrincipal({
        avaliacao: r.avaliacao,
        via: r.via,
        estrategia: r.estrategia,
        viaBulkPrefixo: r.via === 'bulk_local' && r.estrategia?.startsWith?.('prefixo')
      })
    : null;
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
    origem_match: origem,
    via: r?.via || null,
    estrategia: r?.estrategia || null,
    classificacao: r?.classificacao || opts.classificacao || null,
    score: r?.avaliacao?.sim ?? null,
    status: opts.status || (r ? 'match' : 'sem_match'),
    tempo_ms: opts.tempo_ms ?? null,
    motivo: opts.motivo || r?.avaliacao?.motivo || null
  };
}

function registrarMatchExclusivo(stats, origem) {
  const k = `matches_por_${origem}`;
  if (stats[k] != null) stats[k]++;
  else stats[k] = 1;
}

function melhorMatchNosDados(pendente, data, opts) {
  let melhor = null;
  let melhorAv = null;
  for (const item of data) {
    const av = avaliarMatch(pendente, item, opts);
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
  return { melhor, melhorAv };
}

function deveContinuarAposResultado({ bruto, melhorAv, estrategiaAtual, proximaEstrategia, estrategiasRestantes }) {
  if (!estrategiasRestantes.length) return false;
  if (bruto === 0) return true;
  if (melhorAv?.classificacao === CLASSIFICACAO.DIVERGENCIA) return false;
  if (bruto === 1 && melhorAv?.classificacao === CLASSIFICACAO.SEM_MATCH) return false;
  if (bruto > 1 && proximaEstrategia && proximaEstrategia.length > estrategiaAtual.length) return true;
  return false;
}

async function gravarMatch({
  pendente,
  matchFinal,
  avalFinal,
  estrategiaUsada,
  via,
  competencia,
  stats,
  metricas,
  ehCedido,
  resultados,
  detalhesCandidatos,
  jobCache,
  tCand
}) {
  const reg = transformar({ ...matchFinal, competencia });
  const ups = await upsertRegistrosFolha([reg]);
  if (ups.inseridos <= 0) return false;

  stats.registros_novos += ups.novos || 0;
  stats.registros_atualizados += ups.atualizados || 0;
  if (avalFinal.classificacao === CLASSIFICACAO.SEGURO) stats.matches_seguros++;
  else stats.matches_provaveis++;

  const rObj = {
    pendente,
    registros: ups.registros,
    classificacao: avalFinal.classificacao,
    avaliacao: avalFinal,
    estrategia: estrategiaUsada,
    via,
    nome_giap: matchFinal.funcionario,
    historico_comp: pendente.historico?.competencia
  };

  const origem = origemMatchPrincipal({ avaliacao: avalFinal, via, estrategia: estrategiaUsada });
  registrarMatchExclusivo(stats, origem);
  if (via === 'historico') stats.resultados_por_historico++;
  else if (via === 'nome') stats.resultados_por_nome++;
  else if (via === 'indice_local' || via === 'bulk_local') stats.resultados_por_bulk++;

  if (ehCedido) {
    stats.cedidos_processados++;
    stats.cedidos_resolvidos++;
  }

  detalhesCandidatos.push(linhaDetalheCandidato(pendente, rObj, { tempo_ms: Date.now() - tCand }));
  jobCache.marcarResolvido(pendente.funcionario_id);
  metricas?.registrarUpsert(ups.inseridos);
  resultados.push(rObj);
  return true;
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
  const auditPorId = new Map();
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
        via: 'bulk_local',
        estrategia: m.item._fonte || 'bulk'
      };
      gravadosBulk.push(rObj);
      registrarMatchExclusivo(
        stats,
        origemMatchPrincipal({ avaliacao: m.score, via: 'bulk_local', estrategia: m.item._fonte })
      );
      if (m.pendente.eh_cedido) stats.cedidos_resolvidos++;
      detalhesCandidatos.push(linhaDetalheCandidato(m.pendente, rObj));
      jobCache.marcarResolvido(m.pendente.funcionario_id);
      metricas?.registrarUpsert(ups.inseridos);
    }
  }

  const restantes = cruzado.restantes.filter((p) => !jobCache.jaResolvido(p.funcionario_id));
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
    const audit = { tentativas: [], tentativa_resolveu: null };
    auditPorId.set(pendente.funcionario_id, audit);

    if (jobCache.jaResolvido(pendente.funcionario_id)) continue;

    const ehCedido =
      pendente.eh_cedido ||
      cedencias.ids.has(pendente.funcionario_id) ||
      (pendente.matricula && cedencias.mats.has(String(pendente.matricula).trim()));

    const usaHistorico = historicoEhConfiavel(pendente.historico);
    const estrategias = estrategiasComHistorico(pendente, pendente.historico);
    const codigoOrgaoBusca = codigoOrgaoParaBusca(pendente, codigoOrgao);
    const matchOpts = { matsCedidos, cedidosIds: cedencias.ids, ehCedido };

    const localPre = matchPendenteNoIndice(pendente, indice, { ...matchOpts, ehCedido });
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
      const ok = await gravarMatch({
        pendente,
        matchFinal: localPre.item,
        avalFinal: localPre.avaliacao,
        estrategiaUsada: 'indice_local',
        via: 'indice_local',
        competencia,
        stats,
        metricas,
        ehCedido,
        resultados,
        detalhesCandidatos,
        jobCache,
        tCand
      });
      if (ok) {
        audit.tentativa_resolveu = 'indice_local';
        stats.chamadas_giap_evitadas++;
        stats.chamadas_giap_evitadas_matching_local++;
        continue;
      }
    }

    let matchFinal = null;
    let avalFinal = null;
    let melhorDivergencia = null;
    let estrategiaUsada = null;

    for (let si = 0; si < estrategias.length; si++) {
      const estrategia = estrategias[si];
      const proxima = estrategias[si + 1] || null;
      stats.tentativas_nome++;

      let consulta;
      try {
        consulta = await obterResultadosGiap({
          termo: estrategia,
          codigoOrgao: codigoOrgaoBusca,
          indice,
          cache: jobCache,
          stats,
          metricas,
          usaHistorico,
          label: estrategia,
          scrapeFn: () =>
            runScrape(
              () =>
                scrapeRemuneracoes({
                  competencia,
                  codigoInstituicao: 1,
                  codigoOrgao: codigoOrgaoBusca,
                  nomeServidor: estrategia,
                  quantidade: 100
                }),
              `sync_nome_${estrategia}_org${codigoOrgaoBusca || '0'}`
            )
        });
      } catch (e) {
        metricas?.registrarErro();
        audit.tentativas.push({
          termo: estrategia,
          codigo_orgao: codigoOrgaoBusca,
          origem: 'erro',
          scrape: true,
          bruto: 0,
          match: false,
          erro: e.message
        });
        continue;
      }

      if (consulta.scrape) scrapesNome++;

      const data = consulta.data || [];
      const bruto = data.length;

      audit.tentativas.push({
        termo: estrategia,
        codigo_orgao: codigoOrgaoBusca,
        origem: consulta.origem,
        scrape: consulta.scrape,
        bruto,
        match: false,
        tempo_ms: consulta.duracao_ms,
        outro_orgao: data.some(
          (d) => String(d.codigo_orgao) !== '9' && String(d.codigo_orgao) !== String(codigoOrgaoBusca)
        )
      });

      if (!data.length) continue;

      indice.addItems(data, usaHistorico ? `historico:${estrategia}` : `nome:${estrategia}`);

      const localPos = matchPendenteNoIndice(pendente, indice, { ...matchOpts, ehCedido });
      if (localPos?.classificacao === CLASSIFICACAO.DIVERGENCIA) {
        melhorDivergencia = { item: localPos.item, avaliacao: localPos.avaliacao, estrategia };
        break;
      }
      if (localPos && deveGravarMatch(localPos.avaliacao)) {
        matchFinal = localPos.item;
        avalFinal = localPos.avaliacao;
        estrategiaUsada = estrategia;
        audit.tentativas[audit.tentativas.length - 1].match = true;
        audit.tentativa_resolveu = estrategia;
        break;
      }

      const { melhor, melhorAv } = melhorMatchNosDados(pendente, data, matchOpts);

      if (melhorAv?.classificacao === CLASSIFICACAO.DIVERGENCIA) {
        melhorDivergencia = { item: melhor, avaliacao: melhorAv, estrategia };
        break;
      }

      if (melhor && melhorAv && deveGravarMatch(melhorAv)) {
        matchFinal = melhor;
        avalFinal = melhorAv;
        estrategiaUsada = estrategia;
        audit.tentativas[audit.tentativas.length - 1].match = true;
        audit.tentativa_resolveu = estrategia;
        break;
      }

      const restantesEstrategias = estrategias.slice(si + 1);
      if (
        !deveContinuarAposResultado({
          bruto,
          melhorAv,
          estrategiaAtual: estrategia,
          proximaEstrategia: proxima,
          estrategiasRestantes: restantesEstrategias
        })
      ) {
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
      const via = usaHistorico && estrategiaUsada === estrategias[0] ? 'historico' : 'nome';
      const ok = await gravarMatch({
        pendente,
        matchFinal,
        avalFinal,
        estrategiaUsada,
        via,
        competencia,
        stats,
        metricas,
        ehCedido,
        resultados,
        detalhesCandidatos,
        jobCache,
        tCand
      });
      if (!ok) {
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
          estrategias_tentadas: estrategias,
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
    audit_por_id: auditPorId,
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
