/**
 * Fase bulk: órgão + A–Z antes das buscas individuais por nome.
 * Respeita SEMCAS, cedidos/recebidos (matrículas liberadas) e upsert idempotente.
 */
import { syncPorOrgao, syncPorLetraBulk } from './sync.js';
import { carregarCedenciasAtuais } from './rhsemcas.js';
import { getSupabase } from './supabase.js';
import { closeBrowser } from './scraper.js';
import { memoriaPressionada } from './metrics.js';

const CODIGO_ORGAO_SEMCAS = process.env.GIAP_CODIGO_ORGAO || '9';

/** Meta de registros na folha SEMCAS+órgão antes de pular bulk (configurável). */
export const GIAP_BULK_META = Math.max(
  1,
  Number(process.env.GIAP_BULK_META || 400)
);

function sb() {
  return getSupabase();
}

/** Conta registros SEMCAS ou do órgão na competência. */
export async function contarFolhaBulk(competencia, codigoOrgao = CODIGO_ORGAO_SEMCAS) {
  const { count, error } = await sb()
    .from('folha_pmsl')
    .select('id', { count: 'exact', head: true })
    .eq('competencia', competencia)
    .or(`lotacao.eq.SEMCAS,codigo_orgao.eq.${codigoOrgao}`);
  if (error) throw error;
  return count || 0;
}

/**
 * Executa fase bulk se folha < GIAP_BULK_META.
 * @returns {{ rodou: boolean, pulou_motivo?: string, orgao?: object, letras?: object }}
 */
export async function executarFaseBulk({
  competencia,
  codigoOrgao = CODIGO_ORGAO_SEMCAS,
  metricas = null,
  comTimeout = null,
  watchdogMs = 180000,
  onProgress = null
} = {}) {
  const folhaAntes = await contarFolhaBulk(competencia, codigoOrgao);

  if (folhaAntes >= GIAP_BULK_META) {
    return {
      rodou: false,
      pulou_motivo: `folha_${folhaAntes}_gte_meta_${GIAP_BULK_META}`,
      folha_antes: folhaAntes,
      bulk_meta: GIAP_BULK_META
    };
  }

  let cedencias = { ids: new Set(), mats: new Set() };
  try {
    cedencias = await carregarCedenciasAtuais();
  } catch (_) { /* ok */ }

  const matsCedidos = [...cedencias.mats];
  const resultado = {
    rodou: true,
    folha_antes: folhaAntes,
    bulk_meta: GIAP_BULK_META,
    orgao: null,
    letras: { feitas: 0, inseridos: 0, erros: 0 }
  };

  const runTimed = comTimeout
    ? (fn, label) => comTimeout(fn(), watchdogMs, label)
    : (fn) => fn();

  // 1) Órgão — 1 scrape, até 100 registros SEMCAS
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
    metricas?.registrarScrape('orgao', Date.now() - t0);
    metricas?.registrarUpsert(resultado.orgao?.registros_inseridos || 0);
    metricas?.addBulkRegistros(resultado.orgao?.registros_inseridos || 0);
  } catch (e) {
    metricas?.registrarErro();
    resultado.orgao = { erro: e.message, success: false };
    console.warn('[bulk] sync orgao falhou:', e.message);
    await closeBrowser().catch(() => {});
  }

  // 2) A–Z — até 26 scrapes; filtra SEMCAS + matrículas de cedidos
  const letras = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  for (let i = 0; i < letras.length; i++) {
    if (memoriaPressionada()) {
      console.warn('[bulk] memória alta — fecha Chrome antes da letra', letras[i]);
      await closeBrowser().catch(() => {});
    }

    const letra = letras[i];
    if (onProgress) {
      await onProgress({
        etapa: `bulk_letra_${letra}`,
        letra_idx: i + 1,
        letras_total: letras.length
      });
    }

    const t1 = Date.now();
    try {
      const r = await runTimed(
        () =>
          syncPorLetraBulk({
            letra,
            competencia,
            codigoOrgao: String(codigoOrgao),
            matsCedidos
          }),
        `bulk_letra_${letra}`
      );
      metricas?.registrarScrape('letra', Date.now() - t1);
      metricas?.registrarUpsert(r.registros_inseridos || 0);
      metricas?.addBulkRegistros(r.registros_inseridos || 0);
      resultado.letras.inseridos += r.registros_inseridos || 0;
      resultado.letras.feitas++;
    } catch (e) {
      resultado.letras.erros++;
      metricas?.registrarErro();
      console.warn('[bulk] letra', letra, e.message);
      if (String(e.message).startsWith('watchdog:')) {
        await closeBrowser().catch(() => {});
      }
    }
  }

  await closeBrowser().catch(() => {});
  resultado.folha_depois = await contarFolhaBulk(competencia, codigoOrgao);
  return resultado;
}
