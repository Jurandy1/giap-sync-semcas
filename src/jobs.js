/**
 * Orquestração de jobs GIAP (sync órgão → enriquecer → exonerar).
 */
import { syncPorOrgao, syncPorNome } from './sync.js';
import {
  enriquecerFuncionarios,
  aplicarExoneracoes,
  CODIGO_ORGAO_SEMCAS,
  getSupabase,
  listarBuscasNomePendentes
} from './rhsemcas.js';
import { competenciaAtual } from './utils.js';
import { closeBrowser } from './scraper.js';

/** Limite de buscas por nome por execução (Railway free). Página reutilizada ≈ 1 scrape leve. */
const MAX_BUSCAS_NOME = Math.max(0, Number(process.env.GIAP_MAX_BUSCAS_NOME || 40));

/** Varredura A–Z desligada por padrão — busca por nome completo é mais precisa.
 *  Reative com GIAP_SYNC_LETRAS=1 se precisar engordar a folha em massa. */
const SYNC_LETRAS_ATIVO = process.env.GIAP_SYNC_LETRAS === '1';

/** Se já tem muitos registros SEMCAS na folha, pula A–Z (só busca nomes faltantes). */
const FOLHA_MIN_SKIP_LETRAS = Math.max(
  50,
  Number(process.env.GIAP_FOLHA_MIN_SKIP_LETRAS || 400)
);

/** Watchdog por scrape — acima disso considera pendurado e reseta o Chrome. */
const SCRAPE_WATCHDOG_MS = Math.max(
  60000,
  Number(process.env.GIAP_SCRAPE_WATCHDOG_MS || 180000)
);

const running = new Map(); // jobId -> promise

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
  await limparJobsOrfaos('Interrompido ou substituído por novo job (serviço reiniciou/OOM).');

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

    // 1) Sync órgão (sempre no ciclo completo / sync_orgao)
    if (tipo === 'ciclo_completo' || tipo === 'sync_orgao') {
      await setProgress(0, 0, 'sync_orgao');
      const syncRes = await comTimeout(
        syncPorOrgao({
          codigoOrgao: String(codigoOrgao),
          codigoInstituicao: 1,
          competencia
        }),
        SCRAPE_WATCHDOG_MS,
        'sync_orgao'
      ).catch(async (err) => {
        await closeBrowser().catch(() => {});
        throw err;
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

      if (!SYNC_LETRAS_ATIVO) {
        pulouLetras = true;
        await updateJob(jobId, {
          progresso_pct: 20,
          resumo: { ...resumo, etapa: 'skip_letras_desativado' }
        });
      } else if (folhaAntes >= FOLHA_MIN_SKIP_LETRAS) {
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
            const r = await comTimeout(
              syncPorNome({
                nomeServidor: letras[i],
                codigoInstituicao: 1,
                competencia,
                filtrarOrgao: String(codigoOrgao)
              }),
              SCRAPE_WATCHDOG_MS,
              `sync_letra_${letras[i]}`
            );
            extras += r.registros_inseridos || 0;
            letrasFeitas++;
          } catch (err) {
            console.warn('[jobs] sync letra', letras[i], err.message);
            if (String(err.message).startsWith('watchdog:')) {
              await closeBrowser().catch(() => {});
            }
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
      let nomesScrapeVazio = 0;
      let nomesRejeitadosFiltro = 0;
      let nomesSemMatricula = 0;
      let nomesEncontradosReais = 0;
      let scrapesNome = 0;
      let buscasNome = [];
      let buscasPendentes = 0;
      verificadosNome = new Set();
      matriculasBusca = new Map();
      try {
        const todas = await listarBuscasNomePendentes(competencia);
        // Sem matrícula primeiro (preencher matrícula); dentro do grupo,
        // nomes mais longos primeiro (prefixo mais específico no GIAP)
        todas.sort((a, b) => {
          const grupo = Number(a.tem_matricula) - Number(b.tem_matricula);
          if (grupo !== 0) return grupo;
          return (
            (b.variantes?.[0] || b.busca || '').split(' ').length -
            (a.variantes?.[0] || a.busca || '').split(' ').length
          );
        });
        buscasPendentes = Math.max(0, todas.length - MAX_BUSCAS_NOME);
        buscasNome = todas.slice(0, MAX_BUSCAS_NOME);
      } catch (err) {
        console.warn('[jobs] listar buscas nome', err.message);
      }
      const debugNomes = [];
      for (let i = 0; i < buscasNome.length; i++) {
        const item = buscasNome[i];
        // Sem matrícula: apenas nome completo (1 scrape), como no portal:
        // nome_servidor=NOME+COMPLETO&quantidade=1&codigo_orgao=
        const variantes = !item.tem_matricula
          ? [item.busca || (item.variantes && item.variantes[0])].filter(Boolean)
          : (item.variantes && item.variantes.length)
            ? item.variantes
            : [item.busca];
        let bruto = 0;
        let posFiltro = 0;
        let inseridos = 0;
        let linhasInseridas = [];
        let ultimaResposta = null;
        let ultimaBusca = null;
        let ultimaDuracao = 0;
        let ultimosNomesRetornados = null;
        try {
          for (const busca of variantes) {
            scrapesNome++;
            ultimaBusca = busca;
            const r = await comTimeout(
              syncPorNome({
                nomeServidor: busca,
                codigoInstituicao: 1,
                competencia,
                filtrarNomeAlvo: item.nome
              }),
              SCRAPE_WATCHDOG_MS,
              `sync_nome_${busca}`
            );
            bruto = r.registros_encontrados || 0;
            posFiltro = r.registros_filtrados || 0;
            inseridos = r.registros_inseridos || 0;
            if (inseridos > 0) linhasInseridas = r.resultado || [];
            ultimaResposta = r.raw_amostra;
            ultimaDuracao = r.duracao_ms || 0;
            if (r.nomes_retornados_amostra) {
              ultimosNomesRetornados = r.nomes_retornados_amostra;
            }
            // Só para quando a PESSOA foi achada (pós-filtro) — homônimo
            // bruto não conta; senão "MARIA LIMA" impedia de tentar "AMPARO"
            if (posFiltro > 0) break;
          }
          // Todas as variantes rodaram sem erro — ausência verificável
          verificadosNome.add(item.funcionario_id);
          // Matrícula única achada p/ quem estava sem — o enriquecer usa o link
          if (inseridos > 0 && !item.tem_matricula) {
            const mats = [
              ...new Set(
                linhasInseridas.map((x) => String(x.matricula ?? '').trim()).filter(Boolean)
              )
            ];
            if (mats.length === 1) matriculasBusca.set(item.funcionario_id, mats[0]);
          }
          extrasNomes += inseridos;
          if (inseridos > 0) {
            nomesEncontrados++;
            nomesEncontradosReais++;
          } else {
            nomesVazios++;
            if (bruto === 0) nomesScrapeVazio++;
            else if (posFiltro === 0) nomesRejeitadosFiltro++;
            else nomesSemMatricula++;
          }
          if (inseridos === 0 && debugNomes.length < 3) {
            debugNomes.push({
              nome_rh: item.nome,
              variantes_tentadas: variantes,
              ultima_busca: ultimaBusca,
              bruto,
              pos_filtro: posFiltro,
              duracao_ms: ultimaDuracao,
              raw_amostra: ultimaResposta,
              nomes_retornados_amostra: ultimosNomesRetornados
            });
          }
        } catch (err) {
          nomesVazios++;
          nomesScrapeVazio++;
          console.warn('[jobs] sync nome', ultimaBusca || item.busca, err.message);
          if (String(err.message).startsWith('watchdog:')) {
            await closeBrowser().catch(() => {});
          }
          if (debugNomes.length < 3) {
            debugNomes.push({
              nome_rh: item.nome,
              variantes_tentadas: variantes,
              ultima_busca: ultimaBusca,
              erro: err.message
            });
          }
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
        orgao_bruto: syncRes.registros_encontrados,
        orgao_filtrado: syncRes.registros_filtrados,
        orgao_encontrados: syncRes.registros_filtrados,
        orgao_inseridos: syncRes.registros_inseridos,
        encontrados: syncRes.registros_filtrados,
        inseridos: syncRes.registros_inseridos,
        extras_letras: extras,
        letras_feitas: letrasFeitas,
        pulou_letras: pulouLetras,
        folha_antes: folhaAntes,
        extras_nomes: extrasNomes,
        buscas_nome: buscasNome.length,
        buscas_nome_pendentes: buscasPendentes,
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

    // 3) Exonerações + revisão
    if (tipo === 'ciclo_completo' || tipo === 'exoneracoes') {
      await setProgress(70, 0, 'exoneracoes');
      const exo = await aplicarExoneracoes({
        competencia,
        dryRun,
        jobId,
        // No ciclo completo, ausência só vale p/ quem foi pesquisado por nome;
        // no job avulso de exonerações (sem fase de busca) mantém comportamento antigo
        verificadosIds: verificadosNome ? [...verificadosNome] : null,
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
        folha_registros: exo.folha_registros
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
