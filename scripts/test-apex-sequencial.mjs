/**
 * Teste sequencial APEX — uso: node scripts/test-apex-sequencial.mjs [n]
 */
import 'dotenv/config';
import { executarTesteApexSequencialEFechar } from '../src/test-apex-sequencial.js';

const N = Number(process.argv[2] || 10);
const COMP = Number(process.argv[3] || 202608);

console.log(`Teste APEX sequencial: n=${N} competencia=${COMP}`);

const r = await executarTesteApexSequencialEFechar({ n: N, competencia: COMP });

console.log('\n=== RESUMO ===');
console.log(JSON.stringify(r.resumo, null, 2));
console.log('\n=== BROWSER ===');
console.log(JSON.stringify(r.browser, null, 2));
console.log('\n=== CRITÉRIO ===');
console.log(JSON.stringify(r.criterio, null, 2));
console.log(`\naprovado: ${r.aprovado}`);

console.log('\n=== CONSULTAS ===');
for (const c of r.consultas) {
  console.log(
    `#${c.seq} ${c.prefixo}: ${c.tempo_ms}ms status=${c.status} qtd=${c.quantidade} semcas=${c.quantidade_semcas} reutil=${c.pagina_reutilizada} boot=${c.bootstrap}${c.timeout ? ' TIMEOUT' : ''}`
  );
}

process.exit(r.aprovado ? 0 : 1);
