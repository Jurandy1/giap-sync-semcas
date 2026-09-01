/**
 * Orquestração de jobs GIAP (sync órgão → enriquecer → exonerar).
 */
import { syncPorOrgao, syncPorNome } from './sync.js';
import { executarFaseBulk, contarFolhaBulk, GIAP_BULK_META } from './bulk.js';
import { criarMetricas, memoriaPressionada } from './metrics.js';
import { processarPendentesInteligente } from './busca-inteligente.js';
import { carregarIndiceHistorico, medirCoberturaHistorico } from './historico.js';
import { GiapSearchCache } from './matching.js';
import {
  enriquecerFuncionarios,
  aplicarExoneracoes,
  CODIGO_ORGAO_SEMCAS,
  getSupabase,
  listarBuscasNomePendentes,
  buscarDemissoesVinculos,
  auditarSaidas,
  carregarCedenciasAtuais
} from './rhsemcas.js';
import { competenciaAtual } from './utils.js';
import { closeBrowser } from './scraper.js';

/** Candidatos preparados por job (scrapes permanecem sequenciais — 1 Chrome ativo). */
const CANDIDATOS_POR_JOB = Math.max(1, Number(process.env.GIAP_CANDIDATOS_POR_JOB || 50));
/** Limite efetivo de buscas por nome por execução. */
const MAX_BUSCAS_NOME = Math.max(
  0,
  Number(process.env.GIAP_MAX_BUSCAS_NOME ?? CANDIDATOS_POR_JOB)
);
/** No free tier: 1 = só nome completo (evita 5 scrapes/pessoa). */
const MAX_VARIANTES_NOME = Math.max(1, Number(process.env.GIAP_MAX_VARIANTES_NOME || 1));
/** Fecha o Chrome a cada N pessoas (libera RAM). */
const CLOSE_BROWSER_EVERY_NOME = Math.max(
  1,
  Number(process.env.GIAP_CLOSE_BROWSER_EVERY_NOME || 5)
);

/** Encadeia lotes no servidor (continua com o navegador fechado). */
const AUTO_CONTINUAR = process.env.GIAP_AUTO_CONTINUAR !== '0';
const CONTINUAR_DELAY_MS = Math.max(
  2000,
  Number(process.env.GIAP_CONTINUAR_DELAY_MS || 5000)
);
const MAX_CADEIA = Math.max(1, Number(process.env.GIAP_MAX_CONTINUACOES || 400));

const TIPOS_SYNC_FOLHA = ['sync_orgao', 'sync_folha', 'ciclo_completo'];

/** Watchdog por scrape — acima disso considera pendurado e reseta o Chrome. */
const SCRAPE_WATCHDOG_MS = Math.max(
  60000,
  Number(process.env.GIAP_SCRAPE_WATCHDOG_MS || 180000)
);

const running = new Map(); // jobId -> promise
/** Quando true, não agenda próximo lote (Parar lotes no RH). */
let cadeiaCancelada = false;

export function cancelarCadeiaContinua() {
  cadeiaCancelada = true;
  console.log('[jobs] cadeia de lotes cancelada pelo usuário');
  return { ok: true, cadeiaCancelada: true };
}

export function resetCadeiaContinua() {
  cadeiaCancelada = false;
}

function sb() {
  return getSupabase();
}

/** Rejeita se a promise não resolver a tempo (o scrape continua rodando — chame closeBrowser depois). */
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

/**
 * Marca como erro jobs presos em pending/running (processo morreu no meio —
 * OOM/restart do Railway deixa o job órfão). Chamado no boot e antes de novo job.
 */
export async function limparJobsOrfaos(motivo = 'Interrompido: o serviço reiniciou (OOM/deploy) com o job em andamento.') {
  const { data, error } = await sb()
    .from('giap_jobs')
    .update({
      status: 'error',
      erro: motivo,
      finished_at: new Date().toISOString()
    })
    .in('status', ['pending', 'running'])
    .select('id');
  if (error) {
    console.error('[jobs] limpar órfãos:', error.message);
    return 0;
  }
  if (data?.length) console.log('[jobs] jobs órfãos marcados como erro:', data.map((j) => j.id).join(', '));
  return data?.length || 0;
}

async function updateJob(id, patch) {
  const { error } = await sb().from('giap_jobs').update(patch).eq('id', id);
  if (error) console.error('[jobs] update', id, error.message);
}

/**
 * Rede de segurança para a cadeia de lotes de sync da folha.
 *
 * `agendarProximoLote` dispara o próximo lote de dentro do próprio processo
 * (setTimeout + closeBrowser + criarEExecutarJob), sem HTTP e sem depender do
 * navegador — mas se o processo cair no meio dessa janela (OOM do Chromium,
 * deploy, restart do Render), a promise em memória some com ele e nenhum job
 * novo chega a ser inserido no banco. O job anterior fica marcado "done" com
 * resumo.continuara=true para sempre, e nada nunca retoma.
 *
 * Esta função procura exatamente esse caso — competência cujo job mais
 * recente terminou "done" com continuara=true, sem job ativo e sem pendentes
 * zerados — e cria a continuação. Chamada no boot (recupera de crash) e por
 * um intervalo periódico (rede de segurança enquanto o processo está de pé).
 */
export async function retomarCadeiasInterrompidas() {
  if (cadeiaCancelada) return { retomados: 0, motivo: 'cadeia_cancelada' };

  const { data: recentes, error } = await sb()
    .from('giap_jobs')
    .select('id, tipo, competencia, status, modo, dry_run, resumo, erro, created_at')
    .in('tipo', TIPOS_SYNC_FOLHA)
    .order('id', { ascending: false })
    .limit(50);
  if (error) {
    console.error('[jobs] retomar cadeias: listar recentes:', error.message);
    return { retomados: 0, erro: error.message };
  }

  // Último job por competência (já veio ordenado por id desc).
  const ultimoPorCompetencia = new Map();
  for (const j of recentes || []) {
    if (!ultimoPorCompetencia.has(j.competencia)) ultimoPorCompetencia.set(j.competencia, j);
  }

  let retomados = 0;
  for (const job of ultimoPorCompetencia.values()) {
    // Dois casos legítimos de retomada:
    // 1) job terminou um lote normalmente e avisou que tem mais gente (done_parcial).
    // 2) job ficou "running" quando o processo caiu no meio do lote — o boot já
    //    marcou como "error" com essa mensagem específica (limparJobsOrfaos), o
    //    que é diferente de um erro real de scrape/matching (esses não têm essa
    //    marca e não devem virar retry automático em loop).
    const parcialConcluido = job.status === 'done' && job.resumo?.continuara === true;
    const orfaoPorRestart = job.status === 'error' && /reiniciou/i.test(job.erro || '');
    if (!parcialConcluido && !orfaoPorRestart) continue;

    // Só a competência vigente. Sem isso, qualquer mês antigo que tenha
    // ficado com continuara=true pendurado (ex.: 202607, 202508 — meses já
    // fechados) volta a ser puxado sozinho pra sempre. Retomar competência
    // passada só deve acontecer se o usuário pedir manualmente (botão
    // "Buscar e gravar folha" com aquele mês selecionado).
    if (job.competencia !== competenciaAtual()) continue;

    const { count: ativos } = await sb()
      .from('giap_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('competencia', job.competencia)
      .in('status', ['pending', 'running']);
    if ((ativos || 0) > 0) continue;

    let ainda = [];
    try {
      ainda = await listarBuscasNomePendentes(job.competencia);
    } catch (e) {
      console.warn('[jobs] retomar cadeias: checar pendentes falhou, tenta mesmo assim:', e.message);
      ainda = [{ funcionario_id: -1 }]; // não bloqueia a retomada por falha transitória
    }
    if (!ainda.length) continue;

    console.warn(
      `[jobs] retomando cadeia interrompida (${orfaoPorRestart ? 'job travado por restart' : 'done_parcial sem continuação'}): ` +
        `competência ${job.competencia}, job anterior #${job.id}, ~${ainda.length} pendente(s)`
    );

    const filtrosAnteriores = job.resumo?.filtros || {};
    try {
      await criarEExecutarJob({
        tipo: job.tipo,
        competencia: job.competencia,
        modo: 'continuar',
        dryRun: !!job.dry_run,
        limparOrfaos: false,
        filtros: {
          ...filtrosAnteriores,
          continuarAteCompletar: true,
          _cadeia: Number(filtrosAnteriores._cadeia || 0) + 1,
          _job_anterior: job.id,
          _retomado_apos_interrupcao: true
        }
      });
      retomados++;
    } catch (e) {
      console.error('[jobs] retomar cadeias: falha ao criar job de continuação:', e.message);
    }
  }
  return { retomados };
}

const WATCHDOG_INTERVAL_MS = Math.max(
  30000,
  Number(process.env.GIAP_WATCHDOG_INTERVAL_MS || 120000)
);
let watchdogTimer = null;

/** Inicia a checagem periódica de cadeias interrompidas (chamar 1x no boot). */
export function iniciarWatchdogCadeias() {
  if (watchdogTimer) return;
  const tick = async () => {
    try {
      const r = await retomarCadeiasInterrompidas();
      if (r.retomados) console.log(`[jobs] watchdog retomou ${r.retomados} cadeia(s)`);
    } catch (e) {
      console.error('[jobs] watchdog de cadeias falhou:', e.message);
    }
  };
  watchdogTimer = setInterval(tick, WATCHDOG_INTERVAL_MS);
  tick();
}

/**
 * Trava em memória por competência: agendarProximoLote (fire-and-forget logo
 * após um lote terminar) e o watchdog de retomada podem disparar quase ao
 * mesmo instante pra mesma competência. Sem isso, os dois passam pelo SELECT
 * "tem job ativo?" antes de qualquer um ter inserido a linha, e cada um cria
 * o seu — dois scrapes/Chrome concorrentes na mesma competência (visto em
 * produção: jobs #123 e #124 rodando juntos pra 202608). Só protege dentro
 * do mesmo processo Node; não substitui um lock no banco se um dia houver
 * mais de uma instância do serviço rodando ao mesmo tempo.
 */
const competenciasEmCriacao = new Set();

/**
 * Cria job e processa em background.
 */
export async function criarEExecutarJob({
  tipo = 'ciclo_completo',
  competencia = null,
  modo = 'manual',
  dryRun = false,
  createdBy = null,
  codigoOrgao = CODIGO_ORGAO_SEMCAS,
  filtros = null,
  limparOrfaos = true
} = {}) {
  const comp = Number(competencia || competenciaAtual());

  if (modo !== 'continuar') {
    resetCadeiaContinua();
  }

  const ehSyncFolha = TIPOS_SYNC_FOLHA.includes(tipo);
  if (ehSyncFolha) {
    while (competenciasEmCriacao.has(comp)) {
      await new Promise((r) => setTimeout(r, 200));
    }
    competenciasEmCriacao.add(comp);
  }

  try {
    // Evita dois jobs concorrentes na mesma competência (sync folha). Roda
    // sempre pra esse tipo — inclusive em modo='continuar' e com
    // limparOrfaos=false (é exatamente o caso do agendarProximoLote e do
    // watchdog) — porque agora dois caminhos independentes podem chamar
    // isso pra mesma competência quase ao mesmo tempo; só o lock acima
    // garante que essa checagem e o INSERT abaixo aconteçam como uma
    // unidade só. limparOrfaos continua controlando só o limparJobsOrfaos()
    // global logo abaixo (esse sim tem que ficar de fora de continuações,
    // senão uma cadeia rápida numa competência derruba o job "running"
    // de outra competência que esteja encadeando ao mesmo tempo).
    if (ehSyncFolha) {
      const { data: ativo } = await sb()
        .from('giap_jobs')
        .select('*')
        .eq('competencia', comp)
        .in('tipo', TIPOS_SYNC_FOLHA)
        .in('status', ['pending', 'running'])
        .order('id', { ascending: false })
        .limit(1);
      if (ativo?.length) {
        console.log(
          '[jobs] job ativo para competência',
          comp,
          '— retorna existente #',
          ativo[0].id
        );
        return ativo[0];
      }
    }

    // Jobs órfãos (Render OOM/restart) ficam "running" — cancela ao iniciar outro
    // (em lotes de continuação não limpa: o job anterior já está "done")
    if (limparOrfaos !== false) {
      await limparJobsOrfaos('Interrompido ou substituído por novo job (serviço reiniciou/OOM).');
    }

    const { data: job, error } = await sb()
      .from('giap_jobs')
      .insert({
        tipo,
        status: 'pending',
        modo,
        competencia: comp,
        dry_run: !!dryRun,
        progresso_pct: 0,
        total: 0,
        processados: 0,
        resumo: { filtros: filtros || {} },
        created_by: createdBy
      })
      .select('*')
      .single();

    if (error) throw error;

    const promise = executarJob(job.id, {
      tipo,
      competencia: comp,
      dryRun,
      codigoOrgao,
      filtros: filtros || {}
    }).catch((e) => {
      console.error('[jobs] falha', job.id, e);
    });
    running.set(job.id, promise);

    return job;
  } finally {
    if (ehSyncFolha) competenciasEmCriacao.delete(comp);
  }
}

/**
 * Agenda o próximo lote no próprio servidor (2º plano).
 * Assim o usuário pode fechar o navegador.
 */
async function agendarProximoLote({
  tipo,
  competencia,
  dryRun,
  codigoOrgao,
  filtros,
  jobAnteriorId,
  pendentesEstimados
}) {
  if (!AUTO_CONTINUAR) return null;
  if (filtros?.continuarAteCompletar === false) return null;
  if (cadeiaCancelada) {
    console.log('[jobs] continuação cancelada (flag parar)');
    return null;
  }
  // Encadeamento automático da folha (sync_orgao/sync_folha/ciclo_completo)
  // só pra competência vigente. Um mês antigo (ex.: já virou 202608 e isso
  // ainda é 202607) não deve ficar se auto-continuando pra sempre — quem
  // quiser reprocessar um mês fechado clica de novo, lote a lote,
  // manualmente. Não vale pra auditoria_saidas: essa varre competências
  // passadas de propósito (é o objetivo dela).
  if (TIPOS_SYNC_FOLHA.includes(tipo) && Number(competencia) !== competenciaAtual()) {
    console.log(
      `[jobs] continuação automática pulada: competência ${competencia} não é mais a vigente (${competenciaAtual()})`
    );
    return null;
  }

  const cadeia = Number(filtros?._cadeia || 0) + 1;
  if (cadeia > MAX_CADEIA) {
    console.warn('[jobs] max cadeia atingida', { cadeia, MAX_CADEIA, jobAnteriorId });
    return null;
  }

  console.log(
    `[jobs] agendando continuação #${cadeia} em ${CONTINUAR_DELAY_MS}ms ` +
      `(após job #${jobAnteriorId}, pendentes≈${pendentesEstimados})`
  );

  await new Promise((r) => setTimeout(r, CONTINUAR_DELAY_MS));
  await closeBrowser().catch(() => {});

  if (cadeiaCancelada) {
    console.log('[jobs] continuação cancelada após espera (flag parar)');
    return null;
  }

  // Se o usuário (ou o cron) já disparou outro job na mesma competência, não empilha
  const { count: ativos } = await sb()
    .from('giap_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('competencia', competencia)
    .in('status', ['pending', 'running']);
  if ((ativos || 0) > 0) {
    console.log('[jobs] continuação cancelada: já existe job ativo');
    return null;
  }

  // Auditoria de saídas tem sua própria lista de pendentes (filtros.pendentes_ids);
  // a checagem via listarBuscasNomePendentes é da Conferência de folha.
  if (tipo !== 'auditoria_saidas') {
    try {
      const ainda = await listarBuscasNomePendentes(competencia);
      if (!ainda.length) {
        console.log('[jobs] continuação cancelada: ninguém pendente');
        return null;
      }
    } catch (e) {
      console.warn('[jobs] checagem pendentes falhou, segue mesmo assim:', e.message);
    }
  } else if (!(filtros?.pendentes_ids?.length)) {
    console.log('[jobs] continuação de auditoria cancelada: sem pendentes_ids');
    return null;
  }

  return criarEExecutarJob({
    tipo,
    competencia,
    modo: 'continuar',
    dryRun,
    codigoOrgao,
    limparOrfaos: false,
    filtros: {
      ...(filtros || {}),
      _cadeia: cadeia,
      _total_inicial: filtros?._total_inicial,
      continuarAteCompletar: true,
      _job_anterior: jobAnteriorId
    }
  });
}

async function executarJob(jobId, { tipo, competencia, dryRun, codigoOrgao, filtros = {} }) {
  await updateJob(jobId, {
    status: 'running',
    started_at: new Date().toISOString(),
    progresso_pct: 0
  });

  const resumo = { filtros };
  // Quem foi pesquisado por nome nesta execução — gate da fila de ausência
  let verificadosNome = null;
  // funcionario_id → matrícula única achada pela busca por nome (a busca já
  // validou a pessoa com filtro de similaridade; o enriquecer aproveita o link)
  let matriculasBusca = null;
  try {
    const setProgress = async (base, localPct, label) => {
      const pct = Math.min(99, Math.round(base + localPct * 0.3));
      await updateJob(jobId, {
        progresso_pct: pct,
        resumo: { ...resumo, etapa: label }
      });
    };

    // 0a) Auditoria de saídas — dirigida por pessoa, com checkpoint retomável.
    if (tipo === 'auditoria_saidas') {
      const compRef = Number(filtros.compRef || competencia);
      const compPiso = Number(filtros.compPiso || competencia);
      const escopo = filtros.escopo || 'todos_ativos';
      const pendentesIds = Array.isArray(filtros.pendentes_ids) ? filtros.pendentes_ids : null;
      const loteMax = Math.max(1, Number(process.env.GIAP_AUD_LOTE || 25));
      // Todos os lotes desta auditoria compartilham um job_raiz (o id do primeiro lote).
      const jobRaiz = Number(filtros._job_raiz || jobId);

      await setProgress(0, 0, pendentesIds ? 'auditoria_continua' : 'auditoria_inicio');

      // 1º lote: se folha do compRef está magra, dispara sync_orgao (uma vez).
      // Não usa forcarLetras (o A-Z pesado ficou pra lá — a estratégia agora é
      // por nome individual só pra quem faltou).
      if (!pendentesIds) {
        let folhaRef = 0;
        try {
          const { count } = await sb()
            .from('folha_pmsl')
            .select('id', { count: 'exact', head: true })
            .eq('competencia', compRef);
          folhaRef = count || 0;
        } catch { /* ok */ }
        if (folhaRef < Math.max(1, Number(process.env.GIAP_FOLHA_MIN_SKIP_ORGAO || 30))) {
          try {
            await comTimeout(
              syncPorOrgao({
                codigoOrgao: String(codigoOrgao),
                codigoInstituicao: 1,
                competencia: compRef
              }),
              SCRAPE_WATCHDOG_MS,
              'auditoria_sync_orgao'
            );
          } catch (e) {
            console.warn('[aud] sync_orgao compRef falhou (segue):', e.message);
          }
          await closeBrowser().catch(() => {});
        }
      }

      const auditRes = { comps: [], stats: {}, pendentesIds: [], concluido: true };

      const onResultado = async (v) => {
        try {
          await sb()
            .from('giap_auditoria_saidas')
            .upsert(
              {
                job_id: jobRaiz,
                funcionario_id: v.funcionario_id,
                matricula: v.matricula,
                nome: v.nome,
                status: v.status,
                competencia: v.competencia,
                demissao: v.demissao,
                fonte: v.fonte,
                updated_at: new Date().toISOString()
              },
              { onConflict: 'job_id,funcionario_id' }
            );
        } catch (e) {
          console.warn('[aud] upsert giap_auditoria_saidas', v.nome, e.message);
        }
      };

      try {
        const r = await auditarSaidas({
          compRef,
          compPiso,
          escopo,
          pendentesIds,
          loteMax,
          jobId,
          onResultado,
          onProgress: async ({ processados, total, pct, scrapes, etapa, nome }) => {
            await updateJob(jobId, {
              processados,
              total,
              progresso_pct: Math.min(99, Math.round(pct)),
              resumo: {
                ...resumo,
                etapa: etapa || 'auditoria',
                scrapes: scrapes || 0,
                nome: nome || undefined,
                compRef,
                compPiso,
                escopo
              }
            });
          }
        });
        Object.assign(auditRes, r);
      } catch (e) {
        await closeBrowser().catch(() => {});
        throw e;
      }

      resumo.auditoria = {
        compRef,
        compPiso,
        escopo,
        job_raiz: jobRaiz,
        stats: auditRes.stats,
        pendentes_ids: auditRes.pendentesIds,
        concluido: auditRes.concluido,
        cadeia: Number(filtros?._cadeia || 0)
      };

      await closeBrowser().catch(() => {});
      await updateJob(jobId, {
        status: 'done',
        progresso_pct: auditRes.concluido ? 100 : 90,
        finished_at: new Date().toISOString(),
        resumo: { ...resumo, etapa: auditRes.concluido ? 'auditoria_done' : 'auditoria_lote_ok' }
      });
      running.delete(jobId);

      // Continuação em 2º plano (o navegador pode estar fechado)
      if (!auditRes.concluido && auditRes.pendentesIds.length) {
        agendarProximoLote({
          tipo,
          competencia: compRef,
          dryRun,
          codigoOrgao,
          filtros: {
            ...(filtros || {}),
            compRef,
            compPiso,
            escopo,
            _job_raiz: jobRaiz,
            pendentes_ids: auditRes.pendentesIds
          },
          jobAnteriorId: jobId,
          pendentesEstimados: auditRes.pendentesIds.length
        }).catch((e) => console.error('[jobs] falha ao continuar auditoria:', e.message || e));
      }
      // Front acha a última auditoria pelo próprio giap_jobs
      // (tipo='auditoria_saidas', status='done', maior id) — resumo.auditoria.job_raiz
      // aponta para o job_id na tabela giap_auditoria_saidas.
      return;
    }

    // 0) Busca demissões (comissionados/contratos — sem Efetivo/SP/terceirizado)
    if (tipo === 'buscar_demissoes') {
      await setProgress(0, 0, 'buscar_demissoes');
      const dem = await buscarDemissoesVinculos({
        competencia,
        dryRun,
        jobId,
        mesesAtras: Number(filtros.mesesAtras || 12),
        soForaDaFolhaAtual: filtros.soForaDaFolhaAtual !== false,
        onProgress: async ({ processados, total, pct, scrapes, etapa, nome }) => {
          await updateJob(jobId, {
            processados,
            total,
            progresso_pct: Math.min(99, Math.round(pct)),
            resumo: {
              ...resumo,
              etapa: etapa || 'buscar_demissoes',
              scrapes: scrapes || 0,
              nome: nome || undefined
            }
          });
        }
      });
      resumo.demissoes = dem;
      await closeBrowser().catch(() => {});
      await updateJob(jobId, {
        status: 'done',
        progresso_pct: 100,
        finished_at: new Date().toISOString(),
        resumo: { ...resumo, etapa: 'done' }
      });
      running.delete(jobId);
      return;
    }

    // 1) Sync órgão (ciclo / sync_orgao / sync_folha = só grava buscas)
    if (tipo === 'ciclo_completo' || tipo === 'sync_orgao' || tipo === 'sync_folha') {
      const metricas = criarMetricas(jobId, competencia);
      const cadeiaAtual = Number(filtros._cadeia || 0);
      const isPrimeiroLote = cadeiaAtual === 0;
      await setProgress(0, 0, isPrimeiroLote ? 'bulk_inicio' : 'sync_nomes');

      let folhaAntes = 0;
      try {
        folhaAntes = await contarFolhaBulk(competencia, codigoOrgao);
      } catch {
        /* ignore */
      }

      let syncRes = {
        success: true,
        registros_encontrados: 0,
        registros_filtrados: 0,
        registros_inseridos: 0,
        pulou_orgao: true,
        folha_antes: folhaAntes
      };
      let bulkRes = null;
      let extras = 0;
      let letrasFeitas = 0;
      let pulouLetras = true;
      let pulouBulk = false;
      let todasPendentes = [];
      const pularBuscasNome = filtros?.pularBuscasNome === true;
      const jobCache = filtros._cache_busca || new GiapSearchCache();

      let indiceHistorico = null;
      let statsHistorico = null;

      if (!pularBuscasNome) {
        try {
          todasPendentes = await listarBuscasNomePendentes(competencia);
          if (!filtros._total_inicial && todasPendentes.length) {
            filtros._total_inicial = todasPendentes.length;
          }
          let cedPre = { ids: new Set(), mats: new Set() };
          try {
            cedPre = await carregarCedenciasAtuais();
          } catch (_) { /* ok */ }
          indiceHistorico = await carregarIndiceHistorico(competencia);
          const cov = medirCoberturaHistorico(todasPendentes, indiceHistorico, cedPre);
          todasPendentes = cov.pendentes;
          statsHistorico = cov.stats;
          console.log(JSON.stringify({ evento: 'giap_historico_cobertura', competencia, ...cov.stats }));

          if (Array.isArray(filtros.funcionario_ids) && filtros.funcionario_ids.length) {
            const ids = new Set(filtros.funcionario_ids.map(Number));
            todasPendentes = todasPendentes.filter((p) => ids.has(p.funcionario_id));
          }
        } catch (e) {
          console.warn('[jobs] listar pendentes antes do bulk:', e.message);
        }
      }

      // Fase bulk: prefixos deduplicados no 1º lote (pular se filtros.pularBulk)
      const pularBulkFase = filtros.pularBulk === true;
      if (isPrimeiroLote && folhaAntes < GIAP_BULK_META && !pularBuscasNome && !pularBulkFase) {
        await updateJob(jobId, {
          progresso_pct: 2,
          resumo: {
            ...resumo,
            etapa: 'bulk_orgao',
            bulk_meta: GIAP_BULK_META,
            folha_antes: folhaAntes
          }
        });

        bulkRes = await executarFaseBulk({
          competencia,
          codigoOrgao: String(codigoOrgao),
          pendentes: todasPendentes,
          metricas,
          manterBrowser: true,
          cache: jobCache,
          comTimeout,
          watchdogMs: SCRAPE_WATCHDOG_MS,
          onProgress: async (p) => {
            await updateJob(jobId, {
              progresso_pct: Math.min(15, 2 + (p.letra_idx || 0)),
              resumo: { ...resumo, etapa: p.etapa, bulk: p }
            });
          }
        });

        syncRes = {
          success: true,
          registros_encontrados: bulkRes.stats?.orgao_bruto || bulkRes.orgao?.registros_giap || 0,
          registros_filtrados: bulkRes.stats?.orgao_SEMCAS || 0,
          registros_inseridos: bulkRes.stats?.registros_importados || bulkRes.stats?.orgao_inseridos || 0,
          pulou_orgao: false,
          folha_antes: folhaAntes,
          bulk: bulkRes
        };
        extras = bulkRes.letras?.inseridos || 0;
        letrasFeitas = bulkRes.letras?.feitas || 0;
        pulouLetras = false;
        folhaAntes = bulkRes.folha_depois ?? folhaAntes;
        // Recarrega pendentes após bulk + matching local
        try {
          const recarregados = await listarBuscasNomePendentes(competencia);
          let cedPre = { ids: new Set(), mats: new Set() };
          try {
            cedPre = await carregarCedenciasAtuais();
          } catch (_) { /* ok */ }
          if (!indiceHistorico) indiceHistorico = await carregarIndiceHistorico(competencia);
          const cov = medirCoberturaHistorico(recarregados, indiceHistorico, cedPre);
          todasPendentes = cov.pendentes;
          statsHistorico = cov.stats;
        } catch (_) { /* ok */ }
      } else {
        pulouBulk = true;
        const motivo = isPrimeiroLote
          ? `folha_${folhaAntes}_gte_meta_${GIAP_BULK_META}`
          : `continuacao_lote_${cadeiaAtual}`;
        await updateJob(jobId, {
          progresso_pct: 15,
          resumo: { ...resumo, etapa: `skip_bulk_${motivo}`, folha_antes: folhaAntes }
        });
      }

      // Mantém a mesma aba do Chrome para as buscas por nome (sem closeBrowser aqui)

      let buscasNome = [];
      let buscasPendentes = 0;
      let maxBuscasEfetivo = MAX_BUSCAS_NOME;
      let totalPendentesInicial = Number(filtros._total_inicial || todasPendentes.length || 0);
      let buscaInteligenteRes = null;
      verificadosNome = new Set();
      matriculasBusca = new Map();

      if (!pularBuscasNome) {
        maxBuscasEfetivo = Math.max(1, Number(filtros.maxBuscas ?? MAX_BUSCAS_NOME));
        todasPendentes.sort((a, b) => {
          const ord = { A: 0, B: 1, D: 2, C: 3, E: 4 };
          const ga = ord[a.grupo_historico] ?? 5;
          const gb = ord[b.grupo_historico] ?? 5;
          if (ga !== gb) return ga - gb;
          return (
            (b.variantes?.[0] || b.busca || '').split(' ').length -
            (a.variantes?.[0] || a.busca || '').split(' ').length
          );
        });
        totalPendentesInicial = Number(filtros._total_inicial || todasPendentes.length);
        metricas.setTotalServidores(totalPendentesInicial);
        buscasPendentes = Math.max(0, todasPendentes.length - maxBuscasEfetivo);
        buscasNome = todasPendentes.slice(0, maxBuscasEfetivo);
        const lotesRestantes = Math.ceil(buscasPendentes / Math.max(1, maxBuscasEfetivo));
        metricas.setLote(cadeiaAtual + 1, lotesRestantes);
        metricas.setPendentes(buscasPendentes);
      }

      const debugNomes = [];
      let cedencias = { ids: new Set(), mats: new Set() };
      try {
        cedencias = await carregarCedenciasAtuais();
      } catch (_) { /* ok */ }

      if (!pularBuscasNome && buscasNome.length) {
        buscaInteligenteRes = await processarPendentesInteligente({
          pendentes: buscasNome,
          competencia,
          bulkIndex: bulkRes?.indice || null,
          cache: jobCache,
          indiceHistorico,
          cedencias,
          codigoOrgao: String(codigoOrgao),
          maxBuscas: maxBuscasEfetivo,
          comTimeout,
          watchdogMs: SCRAPE_WATCHDOG_MS,
          metricas,
          onProgress: async ({ i, total, nome }) => {
            await updateJob(jobId, {
              progresso_pct: Math.round(18 + (i / Math.max(total, 1)) * 12),
              processados: i,
              total,
              resumo: {
                ...resumo,
                etapa: `sync_nome_inteligente_${i}/${total}`,
                nome_atual: nome
              }
            });
          }
        });

        for (const r of buscaInteligenteRes.resultados || []) {
          verificadosNome.add(r.pendente.funcionario_id);
          if (!r.pendente.tem_matricula && r.registros?.length === 1) {
            const mat = String(r.registros[0].matricula ?? '').trim();
            if (mat) matriculasBusca.set(r.pendente.funcionario_id, mat);
          }
        }
        if (buscaInteligenteRes.debug_nomes?.length) {
          debugNomes.push(...buscaInteligenteRes.debug_nomes);
        }
      }

      const extrasNomes = buscaInteligenteRes?.nomes_encontrados || 0;
      const nomesEncontrados = extrasNomes;
      const nomesEncontradosReais = extrasNomes;
      const nomesVazios = buscaInteligenteRes?.nomes_vazios || 0;
      const nomesScrapeVazio = nomesVazios;
      const nomesRejeitadosFiltro = buscaInteligenteRes?.stats?.divergencias || 0;
      const nomesSemMatricula = 0;
      const scrapesNome = buscaInteligenteRes?.scrapes_nome || 0;

      // Restart controlado pelo scraper (GIAP_RESTART_BROWSER_AFTER_N) — não fechar aqui

      // Recalcula pendentes reais após bulk + busca inteligente
      if (!pularBuscasNome) {
        try {
          const ainda = await listarBuscasNomePendentes(competencia);
          buscasPendentes = Math.max(0, ainda.length);
          metricas.setPendentes(buscasPendentes);
        } catch (_) { /* ok */ }
      }

      // Fecha Chrome antes do enriquecimento (só Node + Supabase)
      await closeBrowser();

      const bulkRegistros =
        (syncRes.registros_inseridos || 0) + extras;
      const processadosTotal = Math.max(
        0,
        totalPendentesInicial - buscasPendentes
      );

      const lotesRestantesFim = Math.ceil(
        buscasPendentes / Math.max(1, MAX_BUSCAS_NOME)
      );

      const matchingStats = {
        ...(statsHistorico || {}),
        ...(bulkRes?.stats || {}),
        ...(buscaInteligenteRes?.stats || {}),
        divergencias_detalhe: buscaInteligenteRes?.divergencias?.slice(0, 10) || [],
        estrategias_resumo: buscaInteligenteRes?.stats?.estrategias_resumo || []
      };

      resumo.sync = {
        candidatos_por_job: MAX_BUSCAS_NOME,
        orgao_bruto: bulkRes?.stats?.orgao_bruto ?? syncRes.registros_encontrados,
        orgao_SEMCAS: bulkRes?.stats?.orgao_SEMCAS ?? 0,
        orgao_matches_rh: bulkRes?.stats?.orgao_matches_rh ?? 0,
        orgao_matches_matricula: bulkRes?.stats?.orgao_matches_matricula ?? 0,
        orgao_matches_nome: bulkRes?.stats?.orgao_matches_nome ?? 0,
        orgao_recebidos: bulkRes?.stats?.orgao_recebidos ?? 0,
        orgao_descartados: bulkRes?.stats?.orgao_descartados ?? 0,
        orgao_inseridos: bulkRes?.stats?.orgao_inseridos ?? syncRes.registros_inseridos,
        tempo_orgao_ms: bulkRes?.stats?.tempo_orgao_ms ?? 0,
        registros_giap: bulkRes?.stats?.registros_giap ?? syncRes.registros_encontrados,
        registros_indexados: bulkRes?.stats?.registros_indexados ?? bulkRes?.indice?.size ?? 0,
        matches_rh: bulkRes?.stats?.matches_rh ?? 0,
        registros_importados: bulkRes?.stats?.registros_importados ?? syncRes.registros_inseridos,
        orgao_filtrado: syncRes.registros_filtrados,
        orgao_encontrados: syncRes.registros_filtrados,
        orgao_request_url: bulkRes?.orgao?.request_url,
        orgao_response_shape: bulkRes?.orgao?.response_shape,
        orgao_erro: bulkRes?.orgao?.erro,
        encontrados: syncRes.registros_filtrados,
        inseridos: syncRes.registros_inseridos,
        extras_letras: extras,
        letras_feitas: letrasFeitas,
        pulou_letras: pulouLetras,
        pulou_bulk: pulouBulk,
        bulk_meta: GIAP_BULK_META,
        bulk_registros: bulkRegistros,
        folha_antes: folhaAntes,
        extras_nomes: extrasNomes,
        buscas_nome: buscasNome.length,
        buscas_nome_pendentes: buscasPendentes,
        total_pendentes_inicial: totalPendentesInicial,
        buscas_sem_matricula: buscasNome.filter((b) => !b.tem_matricula).length,
        buscas_com_matricula: buscasNome.filter((b) => b.tem_matricula).length,
        nomes_verificados: verificadosNome.size,
        nomes_encontrados: nomesEncontrados,
        nomes_vazios: nomesVazios,
        nomes_scrape_vazio: nomesScrapeVazio,
        nomes_rejeitados_filtro: nomesRejeitadosFiltro,
        nomes_sem_matricula: nomesSemMatricula,
        nomes_encontrados_reais: nomesEncontradosReais,
        scrapes_nome: scrapesNome,
        debug_nomes: debugNomes,
        success: syncRes.success,
        bulk: bulkRes || undefined,
        matching: matchingStats
      };
      resumo.progresso = {
        bulk_registros: bulkRegistros,
        pendentes: buscasPendentes,
        processados: processadosTotal,
        total_servidores: totalPendentesInicial,
        lote_atual: cadeiaAtual + 1,
        lotes_restantes: lotesRestantesFim,
        max_buscas_nome: MAX_BUSCAS_NOME
      };
      resumo.metricas = metricas.log('sync_folha_fim');
      resumo.sincronizar_remuneracoes = buscasPendentes === 0;
      await updateJob(jobId, { progresso_pct: 30, resumo: { ...resumo, etapa: 'sync_ok' } });
      if (tipo === 'sync_orgao' || tipo === 'sync_folha') {
        // Só marca a competência como "buscada" quando não restam nomes pendentes
        if (buscasPendentes === 0) {
          try {
            const { data: cfg } = await sb()
              .from('giap_config')
              .select('competencias_buscadas')
              .eq('id', 1)
              .maybeSingle();
            const lista = Array.isArray(cfg?.competencias_buscadas)
              ? [...cfg.competencias_buscadas]
              : [];
            if (!lista.includes(competencia)) lista.push(competencia);
            lista.sort((a, b) => b - a);
            await sb()
              .from('giap_config')
              .upsert({
                id: 1,
                competencias_buscadas: lista.slice(0, 36),
                updated_at: new Date().toISOString()
              });
          } catch (e) {
            console.warn('[job] marcar competencia buscada:', e.message);
          }
        }
        await updateJob(jobId, {
          status: 'done',
          progresso_pct: 100,
          processados: (syncRes.registros_encontrados || 0) + extras + extrasNomes,
          total: (syncRes.registros_encontrados || 0) + extras + extrasNomes,
          finished_at: new Date().toISOString(),
          resumo: {
            ...resumo,
            etapa: buscasPendentes > 0 ? 'done_parcial' : 'done',
            sync: resumo.sync,
            progresso: resumo.progresso,
            metricas: resumo.metricas,
            sincronizar_remuneracoes: resumo.sincronizar_remuneracoes,
            continuara:
              buscasPendentes > 0 &&
              AUTO_CONTINUAR &&
              filtros?.continuarAteCompletar !== false &&
              !cadeiaCancelada
          }
        });
        running.delete(jobId);
        await closeBrowser().catch(() => {});

        // 2º plano: próximo lote no servidor (navegador pode fechar)
        if (buscasPendentes > 0) {
          agendarProximoLote({
            tipo,
            competencia,
            dryRun,
            codigoOrgao,
            filtros,
            jobAnteriorId: jobId,
            pendentesEstimados: buscasPendentes
          }).catch((e) => console.error('[jobs] falha ao continuar lote:', e.message || e));
        }
        return;
      }
    }

    // 2) Enriquecer — no ciclo_completo só simula (aplicação é manual na UI)
    if (tipo === 'ciclo_completo' || tipo === 'enriquecer') {
      await setProgress(30, 0, 'enriquecer');
      let lastEnrichPct = -1;
      const enrich = await enriquecerFuncionarios({
        competencia,
        dryRun: tipo === 'ciclo_completo' ? true : dryRun,
        jobId,
        matchesBusca: matriculasBusca,
        onProgress: async ({ processados, total, pct }) => {
          if (pct - lastEnrichPct < 2 && processados < total) return;
          lastEnrichPct = pct;
          await updateJob(jobId, {
            processados,
            total,
            progresso_pct: Math.round(30 + (pct / 100) * 40),
            resumo: { ...resumo, etapa: 'enriquecer' }
          });
        }
      });
      resumo.enriquecer = {
        total_hr: enrich.total_hr,
        total_elegiveis: enrich.total_elegiveis,
        matched: enrich.matched,
        via_busca_nome: enrich.via_busca_nome,
        matricula_preenchida: enrich.matricula_preenchida,
        nome_corrigido: enrich.nome_corrigido,
        admissao_preenchida: enrich.admissao_preenchida,
        vinculo_sp_corrigido: enrich.vinculo_sp_corrigido,
        skip_admissao: enrich.skip_admissao,
        ambiguo: enrich.ambiguo,
        sem_match: enrich.sem_match
      };
      await updateJob(jobId, { progresso_pct: 70, resumo: { ...resumo, etapa: 'enriquecer_ok' } });
      if (tipo === 'enriquecer') {
        await updateJob(jobId, {
          status: 'done',
          progresso_pct: 100,
          finished_at: new Date().toISOString(),
          resumo
        });
        running.delete(jobId);
        return;
      }
    }

    // 3) Exonerações — NUNCA no ciclo_completo (pessoa pode reaparecer noutro cargo).
    //    Só job explícito tipo=exoneracoes, e mesmo assim só com filtros.aplicar===true.
    if (tipo === 'exoneracoes') {
      const aplicar = !!(filtros && filtros.aplicar === true);
      await setProgress(70, 0, 'exoneracoes');
      const exo = await aplicarExoneracoes({
        competencia,
        dryRun: !aplicar || dryRun,
        jobId,
        verificadosIds: null,
        onProgress: async ({ processados, total, pct }) => {
          await updateJob(jobId, {
            processados,
            total,
            progresso_pct: Math.round(70 + (pct / 100) * 29),
            resumo: { ...resumo, etapa: 'exoneracoes' }
          });
        }
      });
      resumo.exoneracoes = {
        exonerados: exo.exonerados,
        revisao_ausencia: exo.revisao_ausencia,
        ausencia_nao_verificada: exo.ausencia_nao_verificada,
        ausencia_pausada_folha_magra: exo.ausencia_pausada_folha_magra,
        folha_registros: exo.folha_registros,
        aplicar
      };
    } else if (tipo === 'ciclo_completo') {
      resumo.exoneracoes = {
        pulado: true,
        motivo: 'Exoneração só manual no RHSEMCAS (demissão GIAP pode ser temporária).'
      };
    }

    await updateJob(jobId, {
      status: 'done',
      progresso_pct: 100,
      finished_at: new Date().toISOString(),
      resumo: { ...resumo, etapa: 'done' }
    });
  } catch (e) {
    await updateJob(jobId, {
      status: 'error',
      erro: e.message,
      finished_at: new Date().toISOString(),
      resumo
    });
  } finally {
    await closeBrowser().catch(() => {});
    running.delete(jobId);
  }
}

/**
 * Cron mensal: se automatico=true, entre dia_mes e o fim do mês tenta a
 * competência alvo até a folha nova aparecer (ex.: julho → 202607).
 * Roda 1x por dia; se a competência já tiver registros, não dispara de novo.
 */
export async function tentarCronMensal() {
  const hoje = new Date();
  const dia = hoje.getDate();

  const { data: cfg, error } = await sb().from('giap_config').select('*').eq('id', 1).maybeSingle();
  if (error) throw error;
  if (!cfg?.automatico) {
    return { skipped: true, reason: 'automatico_desligado' };
  }

  const diaInicio = Math.min(31, Math.max(1, Number(cfg.dia_mes) || 20));
  if (dia < diaInicio) {
    return { skipped: true, reason: 'antes_da_janela', dia, dia_inicio: diaInicio };
  }

  const comp = competenciaAtual(hoje);

  // Folha da competência já gravada → não precisa buscar de novo
  const { count: naFolha } = await sb()
    .from('folha_pmsl')
    .select('id', { count: 'exact', head: true })
    .eq('competencia', comp);
  if ((naFolha || 0) > 0) {
    return {
      skipped: true,
      reason: 'competencia_ja_na_folha',
      competencia: comp,
      count: naFolha
    };
  }

  // Evita duplicar no mesmo dia
  const inicioDia = new Date(hoje);
  inicioDia.setHours(0, 0, 0, 0);
  const { data: existentes } = await sb()
    .from('giap_jobs')
    .select('id, status')
    .eq('modo', 'automatico')
    .eq('competencia', comp)
    .gte('created_at', inicioDia.toISOString())
    .in('status', ['pending', 'running', 'done'])
    .limit(1);

  if (existentes?.length) {
    return { skipped: true, reason: 'ja_rodou_hoje', job_id: existentes[0].id, competencia: comp };
  }

  const job = await criarEExecutarJob({
    tipo: 'ciclo_completo',
    competencia: comp,
    modo: 'automatico',
    dryRun: false,
    codigoOrgao: cfg.codigo_orgao || CODIGO_ORGAO_SEMCAS
  });

  return { skipped: false, job, competencia: comp };
}

export async function obterJob(id) {
  const { data, error } = await sb().from('giap_jobs').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}
