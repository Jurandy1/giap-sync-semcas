/**
 * Orquestração de jobs GIAP (sync órgão → enriquecer → exonerar).
 */
import { syncPorOrgao, syncPorNome } from './sync.js';
import {
  enriquecerFuncionarios,
  aplicarExoneracoes,
  CODIGO_ORGAO_SEMCAS,
  getSupabase
} from './rhsemcas.js';
import { competenciaAtual } from './utils.js';

const running = new Map(); // jobId -> promise

function sb() {
  return getSupabase();
}

async function updateJob(id, patch) {
  const { error } = await sb().from('giap_jobs').update(patch).eq('id', id);
  if (error) console.error('[jobs] update', id, error.message);
}

/**
 * Cria job e processa em background.
 */
export async function criarEExecutarJob({
  tipo = 'ciclo_completo',
  competencia = null,
  modo = 'manual',
  dryRun = false,
  createdBy = null,
  codigoOrgao = CODIGO_ORGAO_SEMCAS
} = {}) {
  const comp = Number(competencia || competenciaAtual());

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
      resumo: {},
      created_by: createdBy
    })
    .select('*')
    .single();

  if (error) throw error;

  const promise = executarJob(job.id, { tipo, competencia: comp, dryRun, codigoOrgao }).catch(
    (e) => {
      console.error('[jobs] falha', job.id, e);
    }
  );
  running.set(job.id, promise);

  return job;
}

async function executarJob(jobId, { tipo, competencia, dryRun, codigoOrgao }) {
  await updateJob(jobId, {
    status: 'running',
    started_at: new Date().toISOString(),
    progresso_pct: 0
  });

  const resumo = {};
  try {
    const setProgress = async (base, localPct, label) => {
      const pct = Math.min(99, Math.round(base + localPct * 0.3));
      await updateJob(jobId, {
        progresso_pct: pct,
        resumo: { ...resumo, etapa: label }
      });
    };

    // 1) Sync órgão (sempre no ciclo completo / sync_orgao)
    if (tipo === 'ciclo_completo' || tipo === 'sync_orgao') {
      await setProgress(0, 0, 'sync_orgao');
      const syncRes = await syncPorOrgao({
        codigoOrgao: String(codigoOrgao),
        codigoInstituicao: 1,
        competencia
      });
      // GIAP limita a 100 — completa com prefixos A–Z / nomes do RH sem matrícula na folha
      let extras = 0;
      const letras = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
      for (let i = 0; i < letras.length; i++) {
        try {
          const r = await syncPorNome({
            nomeServidor: letras[i],
            codigoInstituicao: 1,
            competencia,
            codigoOrgao: String(codigoOrgao)
          });
          extras += r.registros_inseridos || 0;
        } catch (err) {
          console.warn('[jobs] sync letra', letras[i], err.message);
        }
        await updateJob(jobId, {
          progresso_pct: Math.round(5 + ((i + 1) / letras.length) * 25),
          resumo: { ...resumo, etapa: `sync_letra_${letras[i]}` }
        });
      }
      resumo.sync = {
        encontrados: syncRes.registros_encontrados,
        inseridos: syncRes.registros_inseridos,
        extras_letras: extras,
        success: syncRes.success
      };
      await updateJob(jobId, { progresso_pct: 30, resumo: { ...resumo, etapa: 'sync_ok' } });
      if (tipo === 'sync_orgao') {
        await updateJob(jobId, {
          status: 'done',
          progresso_pct: 100,
          processados: (syncRes.registros_encontrados || 0) + extras,
          total: (syncRes.registros_encontrados || 0) + extras,
          finished_at: new Date().toISOString(),
          resumo
        });
        running.delete(jobId);
        return;
      }
    }

    // 2) Enriquecer
    if (tipo === 'ciclo_completo' || tipo === 'enriquecer') {
      await setProgress(30, 0, 'enriquecer');
      const enrich = await enriquecerFuncionarios({
        competencia,
        dryRun,
        jobId,
        onProgress: async ({ processados, total, pct }) => {
          await updateJob(jobId, {
            processados,
            total,
            progresso_pct: Math.round(30 + (pct / 100) * 40),
            resumo: { ...resumo, etapa: 'enriquecer' }
          });
        }
      });
      resumo.enriquecer = {
        matched: enrich.matched,
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

    // 3) Exonerações + revisão
    if (tipo === 'ciclo_completo' || tipo === 'exoneracoes') {
      await setProgress(70, 0, 'exoneracoes');
      const exo = await aplicarExoneracoes({
        competencia,
        dryRun,
        jobId,
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
        revisao_ausencia: exo.revisao_ausencia
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
    running.delete(jobId);
  }
}

/**
 * Cron mensal: se automatico=true e hoje = dia_mes, dispara ciclo.
 */
export async function tentarCronMensal() {
  const hoje = new Date();
  const dia = hoje.getDate();

  const { data: cfg, error } = await sb().from('giap_config').select('*').eq('id', 1).maybeSingle();
  if (error) throw error;
  if (!cfg?.automatico) {
    return { skipped: true, reason: 'automatico_desligado' };
  }
  if (dia !== Number(cfg.dia_mes)) {
    return { skipped: true, reason: 'dia_diferente', dia, dia_mes: cfg.dia_mes };
  }

  // Evita duplicar no mesmo dia
  const inicioDia = new Date(hoje);
  inicioDia.setHours(0, 0, 0, 0);
  const { data: existentes } = await sb()
    .from('giap_jobs')
    .select('id, status')
    .eq('modo', 'automatico')
    .gte('created_at', inicioDia.toISOString())
    .in('status', ['pending', 'running', 'done'])
    .limit(1);

  if (existentes?.length) {
    return { skipped: true, reason: 'ja_rodou_hoje', job_id: existentes[0].id };
  }

  const job = await criarEExecutarJob({
    tipo: 'ciclo_completo',
    competencia: competenciaAtual(),
    modo: 'automatico',
    dryRun: false,
    codigoOrgao: cfg.codigo_orgao || CODIGO_ORGAO_SEMCAS
  });

  return { skipped: false, job };
}

export async function obterJob(id) {
  const { data, error } = await sb().from('giap_jobs').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}
