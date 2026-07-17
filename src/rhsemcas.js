/**
 * Adaptador RHSEMCAS: enriquecimento + exoneração a partir da folha GIAP.
 *
 * Regras:
 * - matrícula: só se vazia
 * - nome: corrige com match confiável
 * - data_admissao: só se vazia
 * - vínculo: só se cargoorigem = SERVICO PRESTADO e RH for outro
 * - exoneração: só se demissao preenchida
 * - ausência sem demissão: fila giap_revisao_ausencia
 */
import { createClient } from '@supabase/supabase-js';
import { normalizarCPF, normalizarNome } from './utils.js';

const CODIGO_ORGAO_SEMCAS = process.env.GIAP_CODIGO_ORGAO || '9';
const LOTACAO_SEMCAS = 'SEMCAS';

let _sb = null;
function sb() {
  if (!_sb) {
    _sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );
  }
  return _sb;
}

function cargoEhServicoPrestado(cargo) {
  if (!cargo) return false;
  const n = String(cargo)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  return n === 'SERVICO PRESTADO' || n.includes('SERVICO PRESTADO');
}

function matriculaVazia(m) {
  return m == null || String(m).trim() === '';
}

/** Normaliza date/ISO/string para YYYY-MM-DD */
function normalizarDataISO(d) {
  if (d == null || d === '') return null;
  const s = String(d).trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

/**
 * Confere admissão RH × GIAP.
 * - Se o RH tem data: GIAP precisa ter a mesma (obrigatório).
 * - Se o RH não tem: retorna 'sem_rh' (só permite preencher admissão; sem nome/vínculo/matrícula).
 */
function statusAdmissao(hrAdmissao, folhaAdmissao) {
  const a = normalizarDataISO(hrAdmissao);
  const b = normalizarDataISO(folhaAdmissao);
  if (a) {
    if (!b) return 'divergente';
    return a === b ? 'ok' : 'divergente';
  }
  return 'sem_rh';
}

async function carregarFolhaSemcas(competencia) {
  const { data, error } = await sb()
    .from('folha_pmsl')
    .select('*')
    .eq('competencia', competencia)
    .or(`lotacao.eq.${LOTACAO_SEMCAS},codigo_orgao.eq.${CODIGO_ORGAO_SEMCAS}`);
  if (error) throw error;
  return data || [];
}

async function carregarFuncionariosAtivos() {
  const { data: funcs, error } = await sb()
    .from('funcionarios')
    .select('id, nome, cpf, matricula, data_admissao, ativo')
    .eq('ativo', true);
  if (error) throw error;

  const { data: lots, error: errLot } = await sb()
    .from('funcionario_lotacao')
    .select('id, funcionario_id, vinculo_id, ativo, data_fim')
    .eq('ativo', true);
  if (errLot) throw errLot;

  const { data: vinculos, error: errV } = await sb()
    .from('vinculos')
    .select('id, categoria');
  if (errV) throw errV;

  const vincById = new Map((vinculos || []).map((v) => [v.id, v]));
  const lotByFunc = new Map();
  for (const l of lots || []) {
    if (l.data_fim) continue;
    lotByFunc.set(l.funcionario_id, l);
  }

  const vincSp = (vinculos || []).find(
    (v) =>
      String(v.categoria || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .trim() === 'SERVICO PRESTADO'
  );

  return {
    funcionarios: funcs || [],
    lotByFunc,
    vincById,
    vinculoSpId: vincSp?.id || null
  };
}

function indexarFolha(folha) {
  const porCPF = new Map();
  const porMatricula = new Map();
  const porNome = new Map();
  for (const f of folha) {
    if (f.cpf) porCPF.set(f.cpf, f);
    if (f.matricula) porMatricula.set(String(f.matricula), f);
    if (f.funcionario_norm) {
      if (!porNome.has(f.funcionario_norm)) porNome.set(f.funcionario_norm, []);
      porNome.get(f.funcionario_norm).push(f);
    }
  }
  return { porCPF, porMatricula, porNome };
}

function encontrarMatch(hr, idx) {
  const cpf = normalizarCPF(hr.cpf);
  if (cpf && idx.porCPF.has(cpf)) {
    return { match: idx.porCPF.get(cpf), tipo: 'cpf' };
  }
  if (!matriculaVazia(hr.matricula) && idx.porMatricula.has(String(hr.matricula).trim())) {
    return { match: idx.porMatricula.get(String(hr.matricula).trim()), tipo: 'matricula' };
  }
  const nomeNorm = normalizarNome(hr.nome);
  if (nomeNorm) {
    const cands = idx.porNome.get(nomeNorm) || [];
    if (cands.length === 1) return { match: cands[0], tipo: 'nome' };
    if (cands.length > 1) return { match: null, tipo: 'ambiguo', candidatos: cands.length };
  }
  return { match: null, tipo: 'sem_match' };
}

/**
 * Enriquecimento dos funcionários ativos.
 */
export async function enriquecerFuncionarios({
  competencia,
  dryRun = false,
  onProgress = null,
  jobId = null
} = {}) {
  const folha = await carregarFolhaSemcas(competencia);
  const idx = indexarFolha(folha);
  const { funcionarios, lotByFunc, vincById, vinculoSpId } = await carregarFuncionariosAtivos();

  const relatorio = {
    competencia,
    total_hr: funcionarios.length,
    total_folha: folha.length,
    matched: 0,
    ambiguo: 0,
    sem_match: 0,
    skip_admissao: 0,
    matricula_preenchida: 0,
    nome_corrigido: 0,
    admissao_preenchida: 0,
    vinculo_sp_corrigido: 0,
    items: []
  };

  const total = funcionarios.length;
  let processados = 0;

  for (const hr of funcionarios) {
    const { match, tipo } = encontrarMatch(hr, idx);
    processados++;
    if (onProgress) {
      await onProgress({
        processados,
        total,
        pct: total ? Math.round((processados / total) * 1000) / 10 : 100
      });
    }

    if (tipo === 'ambiguo') {
      relatorio.ambiguo++;
      relatorio.items.push({
        funcionario_id: hr.id,
        nome: hr.nome,
        matricula: hr.matricula,
        acao: 'skip_ambiguo',
        status: 'skipped'
      });
      continue;
    }
    if (!match) {
      relatorio.sem_match++;
      continue;
    }

    const adm = statusAdmissao(hr.data_admissao, match.admissao);
    if (adm === 'divergente') {
      relatorio.skip_admissao++;
      relatorio.items.push({
        funcionario_id: hr.id,
        nome: hr.nome,
        matricula: hr.matricula,
        acao: 'skip_admissao_divergente',
        before_data: { data_admissao: hr.data_admissao },
        after_data: { admissao_giap: match.admissao },
        status: 'skipped'
      });
      if (jobId) {
        await sb().from('giap_job_items').insert({
          job_id: jobId,
          funcionario_id: hr.id,
          matricula: hr.matricula != null ? String(hr.matricula) : null,
          nome: hr.nome,
          acao: 'skip_admissao_divergente',
          before_data: { data_admissao: hr.data_admissao },
          after_data: { admissao_giap: match.admissao },
          status: 'skipped'
        });
      }
      continue;
    }

    relatorio.matched++;
    const patchFunc = {};
    const before = {
      nome: hr.nome,
      matricula: hr.matricula,
      data_admissao: hr.data_admissao
    };
    const acoes = [];

    // RH sem admissão: só preenche a data — não altera nome/matrícula/vínculo
    // (lotação NUNCA é alterada pela API; só vínculo SP quando admissão confere)
    if (adm === 'sem_rh') {
      if (match.admissao) {
        patchFunc.data_admissao = match.admissao;
        acoes.push('admissao');
        relatorio.admissao_preenchida++;
      }
    } else {
      // adm === 'ok' — admissão bate: pode enriquecer demais campos
      if (matriculaVazia(hr.matricula) && match.matricula) {
        patchFunc.matricula = String(match.matricula);
        acoes.push('matricula');
        relatorio.matricula_preenchida++;
      }

      if (match.funcionario && normalizarNome(hr.nome) !== normalizarNome(match.funcionario)) {
        if (tipo === 'cpf' || tipo === 'matricula') {
          patchFunc.nome = match.funcionario;
          acoes.push('nome');
          relatorio.nome_corrigido++;
        }
      }
    }

    // Vínculo SP: só corrige categoria do vínculo — NUNCA lotacao_id / unidade
    let vinculoPatch = null;
    if (adm === 'ok') {
      const lot = lotByFunc.get(hr.id);
      if (cargoEhServicoPrestado(match.cargo_origem) && vinculoSpId && lot) {
        const atual = vincById.get(lot.vinculo_id);
        const catAtual = String(atual?.categoria || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toUpperCase()
          .trim();
        if (catAtual !== 'SERVICO PRESTADO') {
          vinculoPatch = {
            funcionario_lotacao_id: lot.id,
            vinculo_id: vinculoSpId,
            de: atual?.categoria || null
          };
          acoes.push('vinculo_sp');
          relatorio.vinculo_sp_corrigido++;
        }
      }
    }

    if (!acoes.length) continue;

    const item = {
      funcionario_id: hr.id,
      nome: hr.nome,
      matricula: hr.matricula || match.matricula,
      acao: acoes.join('+'),
      before_data: before,
      after_data: { ...patchFunc, vinculo: vinculoPatch },
      status: dryRun ? 'pending' : 'applied'
    };

    if (!dryRun) {
      if (Object.keys(patchFunc).length) {
        const { error } = await sb().from('funcionarios').update(patchFunc).eq('id', hr.id);
        if (error) {
          item.status = 'error';
          item.erro = error.message;
        }
      }
      // Apenas vinculo_id — nunca lotacao_id / unidade operacional
      if (vinculoPatch && item.status !== 'error') {
        const { error } = await sb()
          .from('funcionario_lotacao')
          .update({ vinculo_id: vinculoPatch.vinculo_id })
          .eq('id', vinculoPatch.funcionario_lotacao_id);
        if (error) {
          item.status = 'error';
          item.erro = error.message;
        }
      }
    }

    relatorio.items.push(item);
    if (jobId) {
      await sb().from('giap_job_items').insert({
        job_id: jobId,
        funcionario_id: item.funcionario_id,
        matricula: item.matricula != null ? String(item.matricula) : null,
        nome: item.nome,
        acao: item.acao,
        before_data: item.before_data,
        after_data: item.after_data,
        status: item.status,
        erro: item.erro || null
      });
    }
  }

  return relatorio;
}

/**
 * Exoneração automática (demissao) + fila de revisão (ausência).
 */
export async function aplicarExoneracoes({
  competencia,
  dryRun = false,
  onProgress = null,
  jobId = null
} = {}) {
  const folha = await carregarFolhaSemcas(competencia);
  const porMatricula = new Map(folha.map((f) => [String(f.matricula), f]));

  const { data: funcs, error } = await sb()
    .from('funcionarios')
    .select('id, nome, matricula, ativo')
    .eq('ativo', true);
  if (error) throw error;

  const comMatricula = (funcs || []).filter((f) => !matriculaVazia(f.matricula));

  const relatorio = {
    competencia,
    total_com_matricula: comMatricula.length,
    exonerados: 0,
    revisao_ausencia: 0,
    items: []
  };

  const total = comMatricula.length;
  let processados = 0;

  for (const hr of comMatricula) {
    processados++;
    if (onProgress) {
      await onProgress({
        processados,
        total,
        pct: total ? Math.round((processados / total) * 1000) / 10 : 100
      });
    }

    const mat = String(hr.matricula).trim();
    const naFolha = porMatricula.get(mat);

    if (naFolha?.demissao) {
      const item = {
        funcionario_id: hr.id,
        nome: hr.nome,
        matricula: mat,
        acao: 'exoneracao',
        before_data: { ativo: true },
        after_data: { data_exoneracao: naFolha.demissao, demissao_giap: naFolha.demissao },
        status: dryRun ? 'pending' : 'applied'
      };

      if (!dryRun) {
        const { error: errRpc } = await sb().rpc('fn_exonerar_funcionario', {
          p_funcionario_id: hr.id,
          p_data_exoneracao: naFolha.demissao,
          p_motivo: `GIAP demissão ${naFolha.demissao} (competência ${competencia})`
        });
        if (errRpc) {
          item.status = 'error';
          item.erro = errRpc.message;
        } else {
          relatorio.exonerados++;
          // Resolve revisões pendentes se houver
          await sb()
            .from('giap_revisao_ausencia')
            .update({ status: 'exonerado', resolved_at: new Date().toISOString() })
            .eq('funcionario_id', hr.id)
            .eq('status', 'pendente');
        }
      } else {
        relatorio.exonerados++;
      }

      relatorio.items.push(item);
      if (jobId) {
        await sb().from('giap_job_items').insert({
          job_id: jobId,
          funcionario_id: item.funcionario_id,
          matricula: item.matricula,
          nome: item.nome,
          acao: item.acao,
          before_data: item.before_data,
          after_data: item.after_data,
          status: item.status,
          erro: item.erro || null
        });
      }
      continue;
    }

    // Ausente da folha SEMCAS desta competência, sem demissão → revisão
    if (!naFolha) {
      relatorio.revisao_ausencia++;
      const item = {
        funcionario_id: hr.id,
        nome: hr.nome,
        matricula: mat,
        acao: 'revisao_ausencia',
        before_data: { ativo: true },
        after_data: { competencia, motivo: 'ausente_folha_sem_demissao' },
        status: 'revisao'
      };
      relatorio.items.push(item);

      if (!dryRun) {
        await sb().from('giap_revisao_ausencia').upsert(
          {
            funcionario_id: hr.id,
            competencia,
            matricula: mat,
            nome: hr.nome,
            status: 'pendente',
            job_id: jobId
          },
          { onConflict: 'funcionario_id,competencia' }
        );
      }

      if (jobId) {
        await sb().from('giap_job_items').insert({
          job_id: jobId,
          funcionario_id: item.funcionario_id,
          matricula: item.matricula,
          nome: item.nome,
          acao: item.acao,
          before_data: item.before_data,
          after_data: item.after_data,
          status: item.status
        });
      }
    }
  }

  return relatorio;
}

export { CODIGO_ORGAO_SEMCAS, sb as getSupabase };
