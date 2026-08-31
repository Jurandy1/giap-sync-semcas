/**
 * Compara busca com/sem codigo_orgao=9 e testa prefixos reais.
 * Uso: node scripts/test-prefixo-orgao.mjs [competencia]
 */
import 'dotenv/config';
import { scrapeRemuneracoes, closeBrowser } from '../src/scraper.js';
import { ehFolhaSemcas } from '../src/matching.js';

const COMP = Number(process.argv[2] || 202608);
const ORG = process.env.GIAP_CODIGO_ORGAO || '9';
const PREFIXOS = ['TERESINHA', 'TAMARA', 'MATEUS', 'SORAYA', 'VICTOR', 'RITA', 'ROSSANA'];

function medir(lista) {
  let semcas = 0;
  for (const item of lista) {
    if (ehFolhaSemcas(item)) semcas++;
  }
  return { total: lista.length, semcas, outros: lista.length - semcas };
}

async function buscar(nome, comOrgao) {
  const t0 = Date.now();
  const r = await scrapeRemuneracoes({
    competencia: COMP,
    codigoInstituicao: 1,
    nomeServidor: nome,
    codigoOrgao: comOrgao ? ORG : '',
    quantidade: 100
  });
  const ms = Date.now() - t0;
  const m = medir(r.data || []);
  return {
    nome,
    codigo_orgao: comOrgao ? ORG : null,
    ...m,
    tempo_ms: ms,
    request_url: r.requestUrl,
    codigo_orgao_enviado: r.codigo_orgao_enviado
  };
}

async function main() {
  console.log(`Comparativo prefixo × orgao — competência ${COMP}\n`);

  console.log('=== TESTE A vs B (TERESINHA) ===');
  const testeA = await buscar('TERESINHA', false);
  const testeB = await buscar('TERESINHA', true);
  console.log(JSON.stringify({ testeA_sem_orgao: testeA, testeB_com_orgao_9: testeB }, null, 2));

  console.log('\n=== PREFIXOS com codigo_orgao=9 ===');
  const resultados = [];
  for (const prefixo of PREFIXOS) {
    const r = await buscar(prefixo, true);
    resultados.push(r);
    console.log(
      `${prefixo}: ${r.total} resultados (${r.semcas} SEMCAS, ${r.outros} outros) em ${r.tempo_ms}ms`
    );
  }

  const totais = resultados.reduce(
    (a, r) => ({
      consultas: a.consultas + 1,
      resultados: a.resultados + r.total,
      semcas: a.semcas + r.semcas,
      outros: a.outros + r.outros,
      tempo_ms: a.tempo_ms + r.tempo_ms
    }),
    { consultas: 0, resultados: 0, semcas: 0, outros: 0, tempo_ms: 0 }
  );

  console.log('\n=== RESUMO ===');
  console.log(
    JSON.stringify(
      {
        competencia: COMP,
        codigo_orgao: ORG,
        ganho_teresinha:
          testeA.total > 0
            ? {
                reducao_resultados_pct: Math.round((1 - testeB.total / testeA.total) * 100),
                reducao_outros_orgaos: testeA.outros - testeB.outros,
                tempo_diff_ms: testeB.tempo_ms - testeA.tempo_ms
              }
            : null,
        prefixos: totais
      },
      null,
      2
    )
  );

  await closeBrowser().catch(() => {});
}

main().catch(async (e) => {
  console.error(e);
  await closeBrowser().catch(() => {});
  process.exit(1);
});
