/**
 * Investigação P6_REQUEST_URL_REMUNERACAO (não altera folha).
 * Uso: node scripts/investigar-request-url.mjs [competencia]
 */
import 'dotenv/config';
import { executarInvestigacaoRequestUrlEFechar } from '../src/investigar-request-url.js';

const COMP = Number(process.argv[2] || 202608);

console.log(`Investigando request URL — competencia=${COMP}…`);

const relatorio = await executarInvestigacaoRequestUrlEFechar({ competencia: COMP });

console.log('\n=== CONCLUSÃO ===');
console.log(JSON.stringify(relatorio.conclusao, null, 2));

console.log('\n=== CONSULTAS (URL mascarada) ===');
for (const c of relatorio.consultas) {
  console.log(`\n--- ${c.prefixo} (${c.tempo_apex_ms}ms) ---`);
  console.log('request_url:', JSON.stringify(c.request_url, null, 2));
  console.log('comparacao:', JSON.stringify(c.comparacao, null, 2));
  console.log('resultado:', c.resultado);
  console.log('teste URL APEX browser:', c.teste_request_url_apex?.browser);
  console.log('teste URL APEX node:', c.teste_request_url_apex?.node);
  console.log('ajax:', c.ajax_respostas?.length, 'resposta(s)');
  for (const a of c.ajax_respostas || []) {
    console.log('  ajax itens:', JSON.stringify(a.itens, null, 2));
  }
}

console.log('\n=== VARIAÇÃO ENTRE PREFIXOS ===');
console.log(JSON.stringify(relatorio.variacao_entre_prefixos, null, 2));

console.log('\n=== RELATÓRIO COMPLETO ===');
console.log(JSON.stringify(relatorio, null, 2));

process.exit(0);
