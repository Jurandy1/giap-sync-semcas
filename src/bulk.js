/**
 * Fase bulk: órgão + prefixos dos pendentes (+ A–Z opcional).
 * Indexa brutos para matching local; não altera cadastro RH.
 */
import { syncPorPrefixoBulk, transformar, upsertRegistrosFolha } from './sync.js';
import { carregarCedenciasAtuais } from './rhsemcas.js';
import { getSupabase } from './supabase.js';
import { closeBrowser } from './scraper.js';
import { memoriaPressionada } from './metrics.js';
import {
  GiapBulkIndex,
  cruzarComIndice,
  letrasNecessariasPendentes,
  prefixosGlobaisDedup,
  criarStatsBusca,
  ehFolhaSemcas,
  matLiberada,
  matKey,
  CLASSIFICACAO,
  deveGravarMatch
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

function medirBrutoOrgao(bruto, matsSet) {
  let semcas = 0;
  let recebidos = 0;
  for (const item of bruto) {
    if (ehFolhaSemcas(item)) semcas++;
    if (matLiberada(matsSet, item.matricula)) recebidos++;
  }
  return {
    orgao_bruto: bruto.length,
    orgao_SEMCAS: semcas,
    orgao_recebidos: recebidos,
    orgao_outros: bruto.length - semcas
  };
}

function classificarMatchOrgao(avaliacao) {
  const fatores = avaliacao?.fatores || [];
  if (fatores.some((f) => f.includes('matricula'))) return 'matricula';
  if (fatores.some((f) => f.includes('cpf'))) return 'cpf';
  return 'nome';
}

async function aplicarCruzamento(restantes, indice, matsSet, cedencias, competencia, stats, resultado, ctx = {}) {
  if (!restantes.length) return restantes;

  const cruz = cruzarComIndice(restantes, indice, {
    matsCedidos: matsSet,
    cedidosIds: cedencias.ids
  });

  stats.divergencias += cruz.stats.divergencias;
  stats.matches_seguros += cruz.stats.matches_seguros;
  stats.matches_provaveis += cruz.stats.matches_provaveis;
  stats.chamadas_giap_evitadas += cruz.stats.chamadas_giap_evitadas;
  stats.chamadas_giap_evitadas_matching_local += cruz.stats.chamadas_giap_evitadas;
  stats.matches_rh += cruz.matches.length;

  for (const m of cruz.matches) {
    if (ctx.orgao) {
      stats.orgao_matches_rh++;
      const tipo = classificarMatchOrgao(m.score);
      if (tipo === 'matricula') stats.orgao_matches_matricula++;
      else if (tipo === 'cpf') stats.orgao_matches_matricula++;
      else stats.orgao_matches_nome++;
      if (m.pendente.eh_cedido) stats.orgao_recebidos++;
    }

    if (m.pendente.eh_cedido || m.pendente.grupo_historico === 'D') stats.cedidos_processados++;
    const reg = transformar({ ...m.item, competencia });
    const { inseridos } = await upsertRegistrosFolha([reg]);
    if (inseridos > 0) {
      resultado.bulk_matches++;
      stats.bulk_matches++;
      stats.registros_importados += inseridos;
      stats.bulk_inseridos += inseridos;
      if (ctx.orgao) stats.orgao_inseridos += inseridos;
      if (ctx.prefixo) stats.resultados_por_prefixo++;
      else stats.resultados_por_bulk++;
    }
  }

  if (ctx.orgao) {
    stats.orgao_descartados = Math.max(0, stats.orgao_bruto - stats.orgao_matches_rh);
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

  // Bulk = prefixos + codigo_orgao=9 (consulta global sem nome retorna vazio no portal)
  resultado.orgao = {
    pulou: true,
    motivo: 'bulk_e_prefixos_com_orgao_9_sem_nome_vazio_no_portal'
  };

  stats.bulk_util = indice.size;

  // Prefixos derivados do histórico / pendentes — cada um com codigo_orgao=9
  const prefixos = restantes.length > 0 ? prefixosGlobaisDedup(restantes) : [];
  stats.prefixos_unicos = prefixos.length;
  stats.consultas_giap_prefixo = 0;

  for (const prefixo of prefixos) {
    if (memoriaPressionada()) await closeBrowser().catch(() => {});

    if (onProgress) await onProgress({ etapa: `bulk_prefixo`, prefixo });

    const detalhe = {
      prefixo,
      codigo_orgao: String(codigoOrgao),
      bruto: 0,
      semcas: 0,
      outros_orgaos: 0,
      inseridos: 0,
      matches_local: 0,
      tempo_ms: 0
    };
    try {
      const t1 = Date.now();
      const r = await runTimed(
        () =>
          syncPorPrefixoBulk({
            prefixo,
            competencia,
            codigoOrgao: String(codigoOrgao),
            matsCedidos,
            modo: 'indexar'
          }),
        `bulk_prefixo_${prefixo}`
      );
      detalhe.tempo_ms = Date.now() - t1;
      stats.consultas_giap_prefixo++;
      const bruto = Array.isArray(r.data_bruta) ? r.data_bruta : [];
      const med = medirBrutoOrgao(bruto, matsSet);
      detalhe.bruto = bruto.length;
      detalhe.semcas = med.orgao_SEMCAS;
      detalhe.outros_orgaos = med.orgao_outros;
      detalhe.codigo_orgao_enviado = r.codigo_orgao_enviado;
      detalhe.request_url = r.parametros?.request_url;
      indice.addItems(bruto, `prefixo:${prefixo}`);
      stats.registros_giap += bruto.length;
      stats.bulk_bruto += bruto.length;
      stats.registros_indexados = indice.size;
      metricas?.registrarScrape('letra', Date.now() - t1);
      resultado.prefixos.feitos++;

      const antes = restantes.length;
      restantes = await aplicarCruzamento(
        restantes,
        indice,
        matsSet,
        cedencias,
        competencia,
        stats,
        resultado,
        { prefixo: true }
      );
      detalhe.matches_local = antes - restantes.length;
      detalhe.inseridos = detalhe.matches_local;
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
            matsCedidos,
            modo: 'indexar'
          }),
        `bulk_letra_${letra}`
      );
      const bruto = Array.isArray(r.data_bruta) ? r.data_bruta : [];
      detalhe.bruto = bruto.length;
      indice.addItems(bruto, `letra:${letra}`);
      stats.registros_giap += bruto.length;
      stats.bulk_bruto += bruto.length;
      stats.registros_indexados = indice.size;
      metricas?.registrarScrape('letra', Date.now() - t1);
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
      detalhe.inseridos = detalhe.matches_local;
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
