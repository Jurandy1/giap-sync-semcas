/**
 * Orquestração de jobs GIAP (sync órgão → enriquecer → exonerar).
 */
import { syncPorOrgao, syncPorNome } from './sync.js';
import {
  enriquecerFuncionarios,
  aplicarExoneracoes,
  CODIGO_ORGAO_SEMCAS,
  getSupabase,
  listarBuscasNomeSemMatricula
} from './rhsemcas.js';
import { competenciaAtual } from './utils.js';
import { closeBrowser } from './scraper.js';

/** Limite de buscas por nome (Render free). Página reutilizada ≈ 1 scrape leve. */
const MAX_BUSCAS_NOME = Math.max(0, Number(process.env.GIAP_MAX_BUSCAS_NOME || 20));

/** Se já tem muitos registros SEMCAS na folha, pula A–Z (só busca nomes faltantes). */
const FOLHA_MIN_SKIP_LETRAS = Math.max(
  50,
  Number(process.env.GIAP_FOLHA_MIN_SKIP_LETRAS || 400)
);

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

  // Jobs órfãos (Render OOM/restart) ficam "running" — cancela ao iniciar outro
  await sb()
    .from('giap_jobs')
    .update({
      status: 'error',
      erro: 'Interrompido ou substituído por novo job (serviço reiniciou/OOM).',
      finished_at: new Date().toISOString()
    })
    .in('status', ['pending', 'running']);

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
      // GIAP limita a ~100 — completa com A–Z só se a folha ainda estiver magra
      let extras = 0;
      let letrasFeitas = 0;
      let pulouLetras = false;
      let folhaAntes = 0;
      try {
        const { count } = await sb()
          .from('folha_pmsl')
          .select('id', { count: 'exact', head: true })
          .eq('competencia', competencia)
          .or(`lotacao.eq.SEMCAS,codigo_orgao.eq.${codigoOrgao}`);
        folhaAntes = count || 0;
      } catch {
        /* ignore */
      }

      if (folhaAntes >= FOLHA_MIN_SKIP_LETRAS) {
        pulouLetras = true;
        await updateJob(jobId, {
          progresso_pct: 20,
          resumo: {
            ...resumo,
            etapa: `skip_letras_folha_${folhaAntes}`
          }
        });
      } else {
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
            letrasFeitas++;
          } catch (err) {
            console.warn('[jobs] sync letra', letras[i], err.message);
          }
          await updateJob(jobId, {
            progresso_pct: Math.round(5 + ((i + 1) / letras.length) * 12),
            resumo: { ...resumo, etapa: `sync_letra_${letras[i]}` }
          });
        }
      }

      // Mantém a mesma aba do Chrome para as buscas por nome (sem closeBrowser aqui)

      let extrasNomes = 0;
      let nomesEncontrados = 0;
      let nomesVazios = 0;
      let scrapesNome = 0;
      let buscasNome = [];
      let buscasPendentes = 0;
      try {
        const todas = await listarBuscasNomeSemMatricula(competencia);
        todas.sort(
          (a, b) =>
            (b.variantes?.[0] || b.busca || '').split(' ').length -
            (a.variantes?.[0] || a.busca || '').split(' ').length
        );
        buscasPendentes = Math.max(0, todas.length - MAX_BUSCAS_NOME);
        buscasNome = todas.slice(0, MAX_BUSCAS_NOME);
      } catch (err) {
        console.warn('[jobs] listar buscas nome', err.message);
      }
      for (let i = 0; i < buscasNome.length; i++) {
        const item = buscasNome[i];
        // 1 tentativa: nome completo (como no Portal Dados Abertos)
        const busca = (item.variantes && item.variantes[0]) || item.busca;
        try {
          scrapesNome++;
          const r = await syncPorNome({
            nomeServidor: busca,
            codigoInstituicao: 1,
            competencia,
            codigoOrgao: '',
            filtrarNomeAlvo: item.nome
          });
          extrasNomes += r.registros_inseridos || 0;
          if ((r.registros_inseridos || 0) > 0) nomesEncontrados++;
          else nomesVazios++;
        } catch (err) {
          nomesVazios++;
          console.warn('[jobs] sync nome', busca, err.message);
        }

        if (i % 3 === 0 || i === buscasNome.length - 1) {
          await updateJob(jobId, {
            progresso_pct: Math.round(
              18 + ((i + 1) / Math.max(buscasNome.length, 1)) * 12
            ),
            resumo: {
              ...resumo,
              etapa: `sync_nome_${i + 1}/${buscasNome.length}`
            }
          });
        }
      }

      // Fecha Chrome antes do enriquecimento (só Node + Supabase)
      await closeBrowser();

      resumo.sync = {
        orgao_encontrados: syncRes.registros_encontrados,
        orgao_inseridos: syncRes.registros_inseridos,
        encontrados: syncRes.registros_encontrados,
        inseridos: syncRes.registros_inseridos,
        extras_letras: extras,
        letras_feitas: letrasFeitas,
        pulou_letras: pulouLetras,
        folha_antes: folhaAntes,
        extras_nomes: extrasNomes,
        buscas_nome: buscasNome.length,
        buscas_nome_pendentes: buscasPendentes,
        nomes_encontrados: nomesEncontrados,
        nomes_vazios: nomesVazios,
        scrapes_nome: scrapesNome,
        success: syncRes.success
      };
      await updateJob(jobId, { progresso_pct: 30, resumo: { ...resumo, etapa: 'sync_ok' } });
      if (tipo === 'sync_orgao') {
        await updateJob(jobId, {
          status: 'done',
          progresso_pct: 100,
          processados: (syncRes.registros_encontrados || 0) + extras + extrasNomes,
          total: (syncRes.registros_encontrados || 0) + extras + extrasNomes,
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
      let lastEnrichPct = -1;
      const enrich = await enriquecerFuncionarios({
        competencia,
        dryRun,
        jobId,
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
    await closeBrowser().catch(() => {});
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
