/**
 * Benchmark HTTP + sessão (não altera folha).
 * Uso: node scripts/benchmark-http-vs-puppeteer.mjs [competencia]
 */
import 'dotenv/config';
import { executarBenchmarkHttpEFechar } from '../src/benchmark-http.js';

const COMP = Number(process.argv[2] || 202608);

const relatorio = await executarBenchmarkHttpEFechar({ competencia: COMP, estabilidadeN: 10 });

console.log('\n=== RESUMO ===');
console.log(JSON.stringify({
  aprovado: relatorio.aprovado,
  criterios: relatorio.criterios,
  comparacao: relatorio.comparacao,
  http_sem_sessao: relatorio.http_sem_sessao,
  bootstrap_ms: relatorio.bootstrap?.tempo_total_ms,
  cookies: relatorio.bootstrap?.cookies_quantidade,
  estabilidade: {
    sucesso: relatorio.estabilidade.sucesso_consecutivo,
    memoria_antes: relatorio.estabilidade.memoria_antes_mb,
    memoria_depois: relatorio.estabilidade.memoria_depois_mb
  }
}, null, 2));

console.log('\n=== HTTP COM SESSÃO (6 prefixos) ===');
for (const h of relatorio.http_com_sessao) {
  console.log(
    `${h.prefixo}: ${h.tempo_http_ms}ms status=${h.status} qtd=${h.quantidade} semcas=${h.quantidade_semcas} primeiro=${h.primeiro_nome || '—'}${h.erro ? ` ERRO=${h.erro}` : ''}`
  );
}

console.log('\n=== RELATÓRIO COMPLETO ===');
console.log(JSON.stringify(relatorio, null, 2));

process.exit(relatorio.aprovado ? 0 : 1);
