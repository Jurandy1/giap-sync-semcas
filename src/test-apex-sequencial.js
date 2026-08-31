/**
 * Teste sequencial APEX reutilizado — não altera folha/matching.
 */
import { scrapeRemuneracoes, closeBrowser, getScrapeMetrics } from './scraper.js';
import { ehFolhaSemcas } from './matching.js';

export const PREFIXOS_10 = [
  'TERESINHA',
  'MARIA',
  'ANA',
  'TAMARA',
  'MATEUS',
  'SORAYA',
  'JOSE',
  'PAULO',
  'CARLOS',
  'SANDRA'
];

export const PREFIXOS_20 = [
  ...PREFIXOS_10,
  'FRANCISCO',
  'ANTONIO',
  'LUCIANA',
  'FERNANDA',
  'PATRICIA',
  'ROBERTO',
  'JULIANA',
  'RICARDO',
  'ADRIANA',
  'MARCOS'
];

export const PREFIXOS_50 = [
  ...PREFIXOS_20,
  'ALINE',
  'BRUNO',
  'CAMILA',
  'DANIEL',
  'ELIANE',
  'FABIO',
  'GISELE',
  'HENRIQUE',
  'IVONE',
  'JULIO',
  'KARINA',
  'LEONARDO',
  'MONICA',
  'NELSON',
  'OLIVIA',
  'PRISCILA',
  'RAQUEL',
  'SERGIO',
  'TATIANA',
  'VANESSA',
  'WAGNER',
  'YARA',
  'ZELIA',
  'AMANDA',
  'BERNARDO',
  'CRISTINA',
  'DOUGLAS',
  'EDUARDO',
  'FABIANA',
  'GUSTAVO'
];

function memMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function statsTempos(vals) {
  if (!vals.length) return { media: null, min: null, max: null, p95: null, total: 0 };
  const sorted = [...vals].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p95Idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    media: Math.round(sum / sorted.length),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p95: sorted[p95Idx],
    total: sorted.length
  };
}

function montarLista(n) {
  if (n <= 10) return PREFIXOS_10.slice(0, n);
  if (n <= 20) return PREFIXOS_20.slice(0, n);
  if (n <= 50) return PREFIXOS_50.slice(0, n);
  const base = [...PREFIXOS_50];
  while (base.length < n) base.push(...PREFIXOS_50);
  return base.slice(0, n);
}

/**
 * @param {{ n: number, competencia?: number, org?: string, quantidade?: number }} opts
 */
export async function executarTesteApexSequencial({
  n = 10,
  competencia = 202608,
  org = '9',
  quantidade = 100
} = {}) {
  await closeBrowser().catch(() => {});

  const prefixos = montarLista(n);
  const tInicio = Date.now();
  const memoria_inicial_mb = memMb();
  let memoria_maxima_mb = memoria_inicial_mb;

  const relatorio = {
    n,
    competencia,
    codigo_instituicao: 1,
    codigo_orgao: org,
    quantidade,
    prefixos,
    consultas: [],
    memoria_inicial_mb
  };

  for (let i = 0; i < prefixos.length; i++) {
    const prefixo = prefixos[i];
    const t0 = Date.now();
    const memAntes = memMb();
    memoria_maxima_mb = Math.max(memoria_maxima_mb, memAntes);

    const r = await scrapeRemuneracoes({
      competencia,
      codigoInstituicao: 1,
      codigoOrgao: org,
      nomeServidor: prefixo,
      quantidade
    });

    const memDepois = memMb();
    memoria_maxima_mb = Math.max(memoria_maxima_mb, memDepois);
    const tempo_ms = Date.now() - t0;
    const lista = r.data || [];
    const semcas = lista.filter((i) => ehFolhaSemcas(i)).length;

    relatorio.consultas.push({
      seq: i + 1,
      prefixo,
      codigo_orgao: org,
      tempo_ms,
      status: r.status || (lista.length ? 'ok' : 'vazio'),
      quantidade: lista.length,
      quantidade_semcas: semcas,
      primeiro_nome: lista[0]?.funcionario || null,
      timeout: r.status === 'timeout',
      recuperado: !!r.timing?.recuperado,
      pagina_reutilizada: !!r.timing?.pagina_reutilizada,
      bootstrap: !!r.timing?.bootstrap,
      erro: r.erro || null,
      memoria_mb: memDepois
    });
  }

  const tempos = relatorio.consultas.filter((c) => !c.bootstrap).map((c) => c.tempo_ms);
  const temposPosBootstrap = relatorio.consultas.filter((c) => c.pagina_reutilizada).map((c) => c.tempo_ms);
  const ok = relatorio.consultas.filter((c) => c.status === 'ok' || c.status === 'ok_recuperado' || (c.quantidade > 0 && !c.timeout));
  const timeouts = relatorio.consultas.filter((c) => c.timeout);

  relatorio.resumo = {
    sucesso: ok.length,
    falhas: relatorio.consultas.length - ok.length,
    taxa_sucesso_pct: Math.round((ok.length / relatorio.consultas.length) * 1000) / 10,
    timeouts: timeouts.length,
    tempos_todos: statsTempos(relatorio.consultas.map((c) => c.tempo_ms)),
    tempos_pos_bootstrap: statsTempos(temposPosBootstrap.length ? temposPosBootstrap : tempos),
    bootstrap_ms: relatorio.consultas.find((c) => c.bootstrap)?.tempo_ms ?? null
  };

  relatorio.browser = getScrapeMetrics();
  relatorio.memoria_final_mb = memMb();
  relatorio.memoria_maxima_mb = memoria_maxima_mb;
  relatorio.duracao_total_ms = Date.now() - tInicio;

  relatorio.criterio = {
    n10_100pct: n === 10 ? relatorio.resumo.taxa_sucesso_pct >= 100 : null,
    n20_95pct: n === 20 ? relatorio.resumo.taxa_sucesso_pct >= 95 : null,
    n50_estavel: n === 50 ? relatorio.resumo.taxa_sucesso_pct >= 95 && relatorio.memoria_maxima_mb < 480 : null,
    sem_oom: relatorio.memoria_maxima_mb < 480
  };

  relatorio.aprovado =
    (n === 10 && relatorio.resumo.taxa_sucesso_pct >= 100 && timeouts.length === 0) ||
    (n === 20 && relatorio.resumo.taxa_sucesso_pct >= 95 && relatorio.criterio.sem_oom) ||
    (n === 50 && relatorio.resumo.taxa_sucesso_pct >= 95 && relatorio.criterio.sem_oom);

  return relatorio;
}

export async function executarTesteApexSequencialEFechar(opts) {
  try {
    return await executarTesteApexSequencial(opts);
  } finally {
    await closeBrowser().catch(() => {});
  }
}
