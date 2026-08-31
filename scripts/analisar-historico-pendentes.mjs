/**
 * Análise: pendentes 202608 × histórico folha_pmsl / funcionario_remuneracoes
 * Uso: node scripts/analisar-historico-pendentes.mjs [competencia]
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { normalizarNome, normalizarCPF } from '../src/utils.js';
import {
  carregarIndiceHistorico,
  buscarHistoricoServidor,
  classificarGrupoHistorico,
  medirCoberturaHistorico
} from '../src/historico.js';
import { matKey } from '../src/matching.js';

const COMP = Number(process.argv[2] || 202608);
const CODIGO_ORGAO = process.env.GIAP_CODIGO_ORGAO || '9';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function selectTudo(build) {
  const PAGE = 1000;
  let from = 0;
  const all = [];
  for (;;) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

function matriculaVazia(m) {
  const s = String(m ?? '').trim();
  return !s || s === '0' || s === '000000';
}

function tokensLen(nome) {
  return (normalizarNome(nome) || '').split(' ').filter(Boolean).length;
}

async function carregarIdsElegiveis() {
  const lots = await selectTudo(() =>
    sb.from('funcionario_lotacao').select('funcionario_id, vinculo_id, data_fim').eq('ativo', true)
  );
  const { data: vinculos } = await sb.from('vinculos').select('id, categoria');
  const catById = new Map(
    (vinculos || []).map((v) => [
      v.id,
      String(v.categoria || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .trim()
    ])
  );
  const excl = new Set(['TERCEIRIZADO', 'TERCEIRIZADA', 'PROCAD', 'ESTAGIARIO', 'ESTAGIO']);
  const ids = new Set();
  for (const l of lots) {
    if (l.data_fim) continue;
    const cat = catById.get(l.vinculo_id) || '';
    if (!cat || excl.has(cat) || cat.includes('PROCAD') || cat.includes('TERCEIRIZ')) continue;
    ids.add(l.funcionario_id);
  }
  return ids;
}

async function listarPendentes(comp) {
  const folha = await selectTudo(() =>
    sb.from('folha_pmsl').select('matricula, funcionario, funcionario_norm').eq('competencia', comp)
  );
  const nomesFolha = new Set(folha.map((f) => normalizarNome(f.funcionario)).filter(Boolean));
  const matsFolha = new Set(folha.map((f) => String(f.matricula ?? '').trim()).filter(Boolean));
  const idsEleg = await carregarIdsElegiveis();
  const funcs = await selectTudo(() =>
    sb.from('funcionarios').select('id, nome, matricula, cpf, data_admissao').eq('ativo', true)
  );
  const pendentes = [];
  const vistos = new Set();
  for (const hr of funcs) {
    if (!idsEleg.has(hr.id)) continue;
    const temMat = !matriculaVazia(hr.matricula);
    if (temMat && matsFolha.has(String(hr.matricula).trim())) continue;
    const nn = normalizarNome(hr.nome);
    if (!nn || nomesFolha.has(nn)) continue;
    if (tokensLen(hr.nome) < 2) continue;
    if (vistos.has(nn)) continue;
    vistos.add(nn);
    pendentes.push({
      funcionario_id: hr.id,
      nome: hr.nome,
      matricula: temMat ? String(hr.matricula).trim() : null,
      cpf: hr.cpf ? normalizarCPF(hr.cpf) : null,
      tem_matricula: temMat
    });
  }
  return pendentes;
}

async function carregarHistoricoFolha(compAtual) {
  return selectTudo(() =>
    sb
      .from('folha_pmsl')
      .select('competencia, matricula, cpf, funcionario, codigo_orgao, lotacao, admissao')
      .lt('competencia', compAtual)
      .order('competencia', { ascending: false })
  );
}

async function carregarRemuneracoes() {
  try {
    return await selectTudo(() =>
      sb
        .from('funcionario_remuneracoes')
        .select('funcionario_id, matricula, cpf, competencia, codigo_orgao, lotacao_giap')
        .order('competencia', { ascending: false })
    );
  } catch {
    return [];
  }
}

async function main() {
  console.log(`Analisando pendentes competência ${COMP}...\n`);
  const pendentes = await listarPendentes(COMP);

  const { data: cedencias } = await sb
    .from('v_cedencias_atuais')
    .select('funcionario_id, matricula')
    .limit(5000);
  const ced = {
    ids: new Set((cedencias || []).map((c) => c.funcionario_id)),
    mats: new Set((cedencias || []).map((c) => matKey(c.matricula)).filter(Boolean))
  };

  const indice = await carregarIndiceHistorico(COMP);
  const { stats, pendentes: enriquecidos } = medirCoberturaHistorico(pendentes, indice, ced);

  console.log(JSON.stringify(stats, null, 2));
  console.log(`\nFolha histórica: ${indice.total_folha} registros (< ${COMP})`);
  console.log(`Remunerações: ${indice.total_remuneracoes} registros`);
  console.log(`Índice matrículas: ${indice.porMat.size}`);
  console.log(`Índice CPFs: ${indice.porCpf.size}`);

  const teresinha = enriquecidos.find((p) =>
    normalizarNome(p.nome).includes('TERESINHA') && normalizarNome(p.nome).includes('REGO')
  );
  if (teresinha) {
    console.log('\n--- Caso Teresinha (pendente com histórico) ---');
    console.log(JSON.stringify({
      servidor_rh: teresinha.nome,
      matricula_rh: teresinha.matricula,
      grupo: teresinha.grupo_historico,
      competencia_anterior: teresinha.historico?.competencia,
      nome_giap_anterior: teresinha.historico?.funcionario,
      matricula_anterior: teresinha.historico?.matricula,
      cpf_anterior: teresinha.historico?.cpf ? '***' : null,
      orgao_anterior: teresinha.historico?.codigo_orgao,
      lotacao_anterior: teresinha.historico?.lotacao,
      fonte: teresinha.historico?._fonte,
      ligacao: teresinha.historico?._ligacao
    }, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
