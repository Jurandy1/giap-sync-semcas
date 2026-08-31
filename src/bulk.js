/**

 * Fase bulk: órgão + A–Z adaptativo com índice para matching local.

 */

import { syncPorOrgao, syncPorLetraBulk, transformar, upsertRegistrosFolha } from './sync.js';

import { carregarCedenciasAtuais } from './rhsemcas.js';

import { getSupabase } from './supabase.js';

import { closeBrowser } from './scraper.js';

import { memoriaPressionada } from './metrics.js';

import {

  GiapBulkIndex,

  cruzarComIndice,

  letrasNecessariasPendentes,

  criarStatsBusca

} from './matching.js';


const CODIGO_ORGAO_SEMCAS = process.env.GIAP_CODIGO_ORGAO || '9';

const MIN_PENDENTES_AZ = Math.max(

  10,

  Number(process.env.GIAP_BULK_AZ_MIN_PENDENTES || 30)

);



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

 * Indexa TODOS os brutos para cruzamento local; insere só elegíveis.

 */

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

    letras: { feitas: 0, inseridos: 0, erros: 0, detalhes: [] },

    indice,

    stats,

    bulk_matches: 0

  };



  const runTimed = comTimeout

    ? (fn, label) => comTimeout(fn(), watchdogMs, label)

    : (fn) => fn();



  let restantes = [...pendentes];



  // 1) Órgão — indexa bruto completo, insere só órgão SEMCAS

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

    metricas?.addBulkRegistros(resultado.orgao?.registros_inseridos || 0);



    // Cruzamento local com pendentes (inclui cedidos de outros órgãos no índice)

    if (restantes.length) {

      const cruz = cruzarComIndice(restantes, indice, {

        matsCedidos: matsSet,

        cedidosIds: cedencias.ids

      });

      for (const m of cruz.matches) {

        const reg = transformar({ ...m.item, competencia });

        const { inseridos } = await upsertRegistrosFolha([reg]);

        if (inseridos > 0) {

          resultado.bulk_matches++;

          stats.bulk_matches++;

          metricas?.registrarUpsert(inseridos);

        }

      }

      restantes = cruz.restantes;

      stats.matches_seguros += cruz.stats.matches_seguros;

      stats.matches_provaveis += cruz.stats.matches_provaveis;

    }

  } catch (e) {

    metricas?.registrarErro();

    resultado.orgao = { erro: e.message, success: false };

    console.warn('[bulk] sync orgao falhou:', e.message);

    await closeBrowser().catch(() => {});

  }



  stats.bulk_util = indice.size;



  // 2) A–Z adaptativo — só letras dos pendentes e se ainda há fila grande

  const letras =

    restantes.length >= MIN_PENDENTES_AZ

      ? letrasNecessariasPendentes(restantes)

      : [];



  resultado.letras.letras_necessarias = letras.length;

  resultado.letras.pulou_az = letras.length === 0;

  resultado.letras.motivo_pulo = letras.length

    ? null

    : `pendentes_${restantes.length}_lt_${MIN_PENDENTES_AZ}`;



  for (let i = 0; i < letras.length; i++) {

    if (memoriaPressionada()) {

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

    const detalhe = {

      letra,

      bruto: 0,

      filtrados: 0,

      descartados: 0,

      inseridos: 0,

      matches_local: 0

    };

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

      const bruto = r.data_bruta || [];

      detalhe.bruto = bruto.length;

      detalhe.filtrados = r.registros_filtrados || 0;

      detalhe.descartados = r.registros_descartados || 0;

      detalhe.inseridos = r.registros_inseridos || 0;

      indice.addItems(bruto, `letra:${letra}`);

      stats.bulk_bruto += bruto.length;



      metricas?.registrarScrape('letra', Date.now() - t1);

      metricas?.registrarUpsert(r.registros_inseridos || 0);

      metricas?.addBulkRegistros(r.registros_inseridos || 0);

      resultado.letras.inseridos += r.registros_inseridos || 0;

      resultado.letras.feitas++;



      if (restantes.length) {

        const cruz = cruzarComIndice(restantes, indice, {

          matsCedidos: matsSet,

          cedidosIds: cedencias.ids

        });

        for (const m of cruz.matches) {

          const reg = transformar({ ...m.item, competencia });

          const { inseridos } = await upsertRegistrosFolha([reg]);

          if (inseridos > 0) {

            detalhe.matches_local++;

            resultado.bulk_matches++;

            stats.bulk_matches++;

            metricas?.registrarUpsert(inseridos);

          }

        }

        restantes = cruz.restantes;

      }

    } catch (e) {

      resultado.letras.erros++;

      detalhe.erro = e.message;

      metricas?.registrarErro();

      console.warn('[bulk] letra', letra, e.message);

      if (String(e.message).startsWith('watchdog:')) {

        await closeBrowser().catch(() => {});

      }

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


