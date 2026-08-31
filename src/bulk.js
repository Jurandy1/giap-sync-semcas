/**
 * Fase bulk: órgão + prefixos dos pendentes (+ A–Z opcional).
 * Indexa brutos para matching local; não altera cadastro RH.
 */
import { syncPorOrgao, syncPorPrefixoBulk, transformar, upsertRegistrosFolha } from './sync.js';
import { carregarCedenciasAtuais } from './rhsemcas.js';
import { getSupabase } from './supabase.js';
import { closeBrowser } from './scraper.js';
import { memoriaPressionada } from './metrics.js';
import {
  GiapBulkIndex,
  cruzarComIndice,
  letrasNecessariasPendentes,
  prefixosBuscaPendentes,
  criarStatsBusca
} from './matching.js';

const CODIGO_ORGAO_SEMCAS = process.env.GIAP_CODIGO_ORGAO || '9';
const MIN_PENDENTES_BULK_EXTRA = Math.max(
  10,
  Number(process.env.GIAP_BULK_AZ_MIN_PENDENTES || 30)
);
const USAR_AZ = process.env.GIAP_BULK_AZ === '1';

export const GIAP_BULK_META = Math.max(1, Number(process.env.GIAP_BULK_META || 400));

function sb() {
  return getSupabase();
}

export async function contarFolhaBulk(competencia, codigoOrgao = CODIGO_ORGAO_SEMCAS) {
  const { count, error } = await sb()
    .from('folha_pmsl')
    .select('id', { count: 'exact', head: true })
    .eq('competencia', competencia)
    .or(`lotacao.eq.SEMCAS,codigo_orgao.eq.${codigoOrgao}`);
  if (error) throw error;
  return count || 0;
}

async function aplicarCruzamento(restantes, indice, matsSet, cedencias, competencia, stats, resultado) {
  if (!restantes.length) return restantes;

  const cruz = cruzarComIndice(restantes, indice, {
    matsCedidos: matsSet,
    cedidosIds: cedencias.ids
  });

  stats.divergencias += cruz.stats.divergencias;
  stats.matches_seguros += cruz.stats.matches_seguros;
  stats.matches_provaveis += cruz.stats.matches_provaveis;
  stats.chamadas_giap_evitadas += cruz.stats.chamadas_giap_evitadas;

  for (const m of cruz.matches) {
    const reg = transformar({ ...m.item, competencia });
    const { inseridos } = await upsertRegistrosFolha([reg]);
    if (inseridos > 0) {
      resultado.bulk_matches++;
      stats.bulk_matches++;
      stats.bulk_inseridos += inseridos;
    }
  }

  return cruz.restantes;
}

export async function executarFaseBulk({
  competencia,
  codigoOrgao = CODIGO_ORGAO_SEMCAS,
  pendentes = [],
  metricas = null,
  comTimeout = null,
  watchdogMs = 180000,
  onProgress = null
} = {}) {
  const tBulk = Date.now();
  const folhaAntes = await contarFolhaBulk(competencia, codigoOrgao);
  const indice = new GiapBulkIndex();
  const stats = criarStatsBusca();
  stats.total_pendentes = pendentes.length;
  stats.pendentes_iniciais = pendentes.length;

  if (folhaAntes >= GIAP_BULK_META) {
    return {
      rodou: false,
      pulou_motivo: `folha_${folhaAntes}_gte_meta_${GIAP_BULK_META}`,
      folha_antes: folhaAntes,
      bulk_meta: GIAP_BULK_META,
      indice,
      stats
    };
  }

  let cedencias = { ids: new Set(), mats: new Set() };
  try {
    cedencias = await carregarCedenciasAtuais();
  } catch (_) { /* ok */ }

  const matsCedidos = [...cedencias.mats];
  const matsSet = new Set(matsCedidos.map((m) => String(m).replace(/\D/g, '').replace(/^0+/, '') || '0'));

  const resultado = {
    rodou: true,
    folha_antes: folhaAntes,
    bulk_meta: GIAP_BULK_META,
    orgao: null,
    prefixos: { feitos: 0, inseridos: 0, detalhes: [] },
    letras: { feitas: 0, inseridos: 0, erros: 0, detalhes: [], pulou_az: true },
    indice,
    stats,
    bulk_matches: 0,
    divergencias: []
  };

  const runTimed = comTimeout
    ? (fn, label) => comTimeout(fn(), watchdogMs, label)
    : (fn) => fn();

  let restantes = [...pendentes];

  // 1) Órgão — indexa bruto completo
  if (onProgress) await onProgress({ etapa: 'bulk_orgao', folha_antes: folhaAntes });
  const t0 = Date.now();
  try {
    resultado.orgao = await runTimed(
      () =>
        syncPorOrgao({
          codigoOrgao: String(codigoOrgao),
          codigoInstituicao: 1,
          competencia
        }),
      'bulk_sync_orgao'
    );
    const bruto = resultado.orgao?.data_bruta || [];
    stats.bulk_bruto += bruto.length;
    indice.addItems(bruto, 'orgao');
    metricas?.registrarScrape('orgao', Date.now() - t0);
    metricas?.registrarUpsert(resultado.orgao?.registros_inseridos || 0);
    stats.bulk_inseridos += resultado.orgao?.registros_inseridos || 0;

    restantes = await aplicarCruzamento(
      restantes,
      indice,
      matsSet,
      cedencias,
      competencia,
      stats,
      resultado
    );
  } catch (e) {
    metricas?.registrarErro();
    resultado.orgao = { erro: e.message, success: false };
    console.warn('[bulk] sync orgao falhou:', e.message);
    await closeBrowser().catch(() => {});
  }

  stats.bulk_util = indice.size;

  // 2) Prefixos derivados dos pendentes (padrão — mais eficiente que A–Z)
  const prefixos =
    restantes.length >= MIN_PENDENTES_BULK_EXTRA
      ? prefixosBuscaPendentes(restantes)
      : [];

  for (const prefixo of prefixos) {
    if (memoriaPressionada()) await closeBrowser().catch(() => {});

    if (onProgress) await onProgress({ etapa: `bulk_prefixo`, prefixo });

    const t1 = Date.now();
    const detalhe = { prefixo, bruto: 0, filtrados: 0, descartados: 0, inseridos: 0, matches_local: 0 };
    try {
      const r = await runTimed(
        () =>
          syncPorPrefixoBulk({
            prefixo,
            competencia,
            codigoOrgao: String(codigoOrgao),
            matsCedidos
          }),
        `bulk_prefixo_${prefixo}`
      );
      const bruto = r.data_bruta || [];
      detalhe.bruto = bruto.length;
      detalhe.filtrados = r.registros_filtrados || 0;
      detalhe.descartados = r.registros_descartados || 0;
      detalhe.inseridos = r.registros_inseridos || 0;
      indice.addItems(bruto, `prefixo:${prefixo}`);
      stats.bulk_bruto += bruto.length;
      stats.bulk_inseridos += r.registros_inseridos || 0;
      metricas?.registrarScrape('letra', Date.now() - t1);
      metricas?.registrarUpsert(r.registros_inseridos || 0);
      resultado.prefixos.inseridos += r.registros_inseridos || 0;
      resultado.prefixos.feitos++;

      const antes = restantes.length;
      restantes = await aplicarCruzamento(
        restantes,
        indice,
        matsSet,
        cedencias,
        competencia,
        stats,
        resultado
      );
      detalhe.matches_local = antes - restantes.length;
    } catch (e) {
      detalhe.erro = e.message;
      metricas?.registrarErro();
      console.warn('[bulk] prefixo', prefixo, e.message);
    }
    resultado.prefixos.detalhes.push(detalhe);
    stats.prefixos.push(detalhe);
  }

  // 3) A–Z opcional (GIAP_BULK_AZ=1) — desligado por padrão
  const letras =
    USAR_AZ && restantes.length >= MIN_PENDENTES_BULK_EXTRA
      ? letrasNecessariasPendentes(restantes)
      : [];

  resultado.letras.pulou_az = !USAR_AZ || letras.length === 0;
  resultado.letras.motivo_pulo = USAR_AZ
    ? letras.length
      ? null
      : `pendentes_${restantes.length}_lt_${MIN_PENDENTES_BULK_EXTRA}`
    : 'GIAP_BULK_AZ_desligado';

  for (const letra of letras) {
    if (memoriaPressionada()) await closeBrowser().catch(() => {});

    const t1 = Date.now();
    const detalhe = { letra, bruto: 0, filtrados: 0, descartados: 0, inseridos: 0, matches_local: 0 };
    try {
      const r = await runTimed(
        () =>
          syncPorPrefixoBulk({
            prefixo: letra,
            competencia,
            codigoOrgao: String(codigoOrgao),
            matsCedidos
          }),
        `bulk_letra_${letra}`
      );
      const bruto = r.data_bruta || [];
      detalhe.bruto = bruto.length;
      detalhe.filtrados = r.registros_filtrados || 0;
      detalhe.descartados = r.registros_descartados || 0;
      detalhe.inseridos = r.registros_inseridos || 0;
      indice.addItems(bruto, `letra:${letra}`);
      stats.bulk_bruto += bruto.length;
      metricas?.registrarScrape('letra', Date.now() - t1);
      resultado.letras.inseridos += r.registros_inseridos || 0;
      resultado.letras.feitas++;

      const antes = restantes.length;
      restantes = await aplicarCruzamento(
        restantes,
        indice,
        matsSet,
        cedencias,
        competencia,
        stats,
        resultado
      );
      detalhe.matches_local = antes - restantes.length;
    } catch (e) {
      resultado.letras.erros++;
      detalhe.erro = e.message;
      metricas?.registrarErro();
    }
    resultado.letras.detalhes.push(detalhe);
    stats.letras.push(detalhe);
  }

  await closeBrowser().catch(() => {});
  stats.tempo_bulk_ms = Date.now() - tBulk;
  stats.bulk_util = indice.size;
  resultado.folha_depois = await contarFolhaBulk(competencia, codigoOrgao);
  resultado.restantes_apos_bulk = restantes.length;
  resultado.indice = indice;
  resultado.stats = stats;
  return resultado;
}
