/**
 * Resolução de consultas GIAP com cache global + filtro local no índice.
 */
import { normalizarRespostaLista } from './utils.js';
import {
  chaveConsultaGiap,
  nomeGiapTemPrefixo,
  registrarEstrategia
} from './matching.js';

/**
 * @param {{ termo: string, codigoOrgao: string, indice: import('./matching.js').GiapBulkIndex, cache: import('./matching.js').GiapSearchCache, scrapeFn: () => Promise<{data:any, requestUrl?:string}>, stats: object, metricas?: object, usaHistorico?: boolean, label?: string }} opts
 */
export async function obterResultadosGiap({
  termo,
  codigoOrgao,
  indice,
  cache,
  scrapeFn,
  stats,
  metricas = null,
  usaHistorico = false,
  label = termo
}) {
  const org = codigoOrgao ?? '';

  const cached = cache.getConsulta(termo, org);
  if (cached) {
    stats.chamadas_giap_evitadas = (stats.chamadas_giap_evitadas || 0) + 1;
    if (usaHistorico) stats.chamadas_giap_evitadas_historico = (stats.chamadas_giap_evitadas_historico || 0) + 1;
    registrarEstrategia(stats, `${label}_cache`, (cached.data?.length || 0) > 0, cached.duracao_ms || 0);
    return {
      data: cached.data || [],
      duracao_ms: cached.duracao_ms || 0,
      origem: cached.origem || 'cache',
      scrape: false
    };
  }

  if (cache.consultaVazia(termo, org)) {
    stats.chamadas_giap_evitadas = (stats.chamadas_giap_evitadas || 0) + 1;
    registrarEstrategia(stats, `${label}_cache_vazio`, false, 0);
    return { data: [], duracao_ms: 0, origem: 'cache_vazio', scrape: false };
  }

  const doIndice = indice.filtrarPorPrefixoGiap(termo, org);
  if (doIndice.length > 0) {
    stats.chamadas_giap_evitadas = (stats.chamadas_giap_evitadas || 0) + 1;
    stats.chamadas_giap_evitadas_matching_local = (stats.chamadas_giap_evitadas_matching_local || 0) + 1;
    cache.setConsulta(termo, org, { data: doIndice, duracao_ms: 0, origem: 'indice' });
    registrarEstrategia(stats, `${label}_indice`, true, 0);
    return { data: doIndice, duracao_ms: 0, origem: 'indice', scrape: false };
  }

  const filtrado = cache.filtrarDePrefixoPai(termo, org);
  if (filtrado) {
    stats.chamadas_giap_evitadas = (stats.chamadas_giap_evitadas || 0) + 1;
    stats.chamadas_giap_evitadas_matching_local = (stats.chamadas_giap_evitadas_matching_local || 0) + 1;
    cache.setConsulta(termo, org, {
      data: filtrado.data,
      duracao_ms: 0,
      origem: filtrado.origem
    });
    registrarEstrategia(stats, `${label}_${filtrado.origem}`, filtrado.data.length > 0, 0);
    return { data: filtrado.data, duracao_ms: 0, origem: filtrado.origem, scrape: false };
  }

  const t1 = Date.now();
  const r = await scrapeFn();
  const norm = normalizarRespostaLista(r.data, { requestUrl: r.requestUrl, rawPrefix: r.raw });
  if (norm.erro) throw new Error(norm.erro);
  const data = norm.lista;
  const duracaoMs = Date.now() - t1;

  cache.setConsulta(termo, org, { data, duracao_ms: duracaoMs, origem: 'scrape' });
  if (!data.length) cache.marcarConsultaVazia(termo, org);

  stats.consultas_giap = (stats.consultas_giap || 0) + 1;
  stats.buscas_nome = (stats.buscas_nome || 0) + 1;
  metricas?.registrarScrape('nome', duracaoMs);
  registrarEstrategia(
    stats,
    usaHistorico ? `historico:${termo}` : termo,
    data.length > 0,
    duracaoMs
  );

  return { data, duracao_ms: duracaoMs, origem: 'scrape', scrape: true };
}

export { chaveConsultaGiap, nomeGiapTemPrefixo };
