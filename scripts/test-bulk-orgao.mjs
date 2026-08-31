/**
 * Teste controlado: bulk órgão + prefixos + matching local (competência informada).
 * Uso: node scripts/test-bulk-orgao.mjs [competencia] [maxCandidatos]
 */
import 'dotenv/config';
import { listarBuscasNomePendentes, carregarCedenciasAtuais } from '../src/rhsemcas.js';
import { executarFaseBulk } from '../src/bulk.js';
import { carregarIndiceHistorico, medirCoberturaHistorico } from '../src/historico.js';
import { closeBrowser } from '../src/scraper.js';

const COMP = Number(process.argv[2] || 202608);
const MAX = Number(process.argv[3] || 50);

async function main() {
  console.log(`Teste bulk competência ${COMP}, candidatos máx ${MAX}\n`);

  let pendentes = await listarBuscasNomePendentes(COMP);
  const cedencias = await carregarCedenciasAtuais();
  const indiceHistorico = await carregarIndiceHistorico(COMP);
  const cov = medirCoberturaHistorico(pendentes, indiceHistorico, cedencias);
  pendentes = cov.pendentes;

  console.log('--- Histórico (todos os pendentes) ---');
  console.log(JSON.stringify(cov.stats, null, 2));

  const t0 = Date.now();
  const bulk = await executarFaseBulk({
    competencia: COMP,
    pendentes: pendentes.slice(0, MAX)
  });
  await closeBrowser().catch(() => {});

  const stats = bulk.stats || {};
  console.log('\n--- Bulk órgão ---');
  console.log(
    JSON.stringify(
      {
        orgao_erro: bulk.orgao?.erro,
        orgao_request_url: bulk.orgao?.request_url,
        orgao_response_shape: bulk.orgao?.response_shape,
        orgao_bruto: stats.orgao_bruto,
        orgao_SEMCAS: stats.orgao_SEMCAS,
        orgao_matches_rh: stats.orgao_matches_rh,
        orgao_matches_matricula: stats.orgao_matches_matricula,
        orgao_matches_nome: stats.orgao_matches_nome,
        orgao_recebidos: stats.orgao_recebidos,
        orgao_descartados: stats.orgao_descartados,
        orgao_inseridos: stats.orgao_inseridos,
        tempo_orgao_ms: stats.tempo_orgao_ms,
        registros_giap: stats.registros_giap,
        registros_indexados: stats.registros_indexados,
        matches_rh: stats.matches_rh,
        registros_importados: stats.registros_importados,
        prefixos_feitos: bulk.prefixos?.feitos,
        restantes_apos_bulk: bulk.restantes_apos_bulk,
        tempo_bulk_ms: stats.tempo_bulk_ms,
        tempo_total_ms: Date.now() - t0
      },
      null,
      2
    )
  );

  const pendentesDepois = await listarBuscasNomePendentes(COMP);
  console.log(`\nPendentes antes: ${cov.stats.pendentes_total}`);
  console.log(`Pendentes depois: ${pendentesDepois.length}`);
  console.log(`Resolvidos neste teste: ${cov.stats.pendentes_total - pendentesDepois.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
