import 'dotenv/config';
import { writeFileSync } from 'fs';
import { executarTesteFolha50EFechar } from '../src/teste-folha-50.js';

process.env.GIAP_HTTP_DIRECT = '0';
process.env.GIAP_SCRAPE_TIMEOUT_MS = '30000';
process.env.GIAP_RESTART_BROWSER_AFTER_N = '20';
process.env.GIAP_BROWSER_RESTART_EVERY = '20';
process.env.GIAP_CLOSE_BROWSER_EVERY_NOME = '999';
process.env.GIAP_MAX_BUSCAS_NOME = '50';

const out = 'teste-folha-50-result.json';
console.log('[run-teste-folha-50] iniciando competencia=202608 n=50 idempotencia=true');
const t0 = Date.now();
const relatorio = await executarTesteFolha50EFechar({
  competencia: 202608,
  n: 50,
  idempotencia: true
});
writeFileSync(out, JSON.stringify(relatorio, null, 2));
console.log(`[run-teste-folha-50] concluído em ${Math.round((Date.now() - t0) / 1000)}s → ${out}`);
console.log(JSON.stringify(relatorio.resumo, null, 2));
console.log('aprovado:', relatorio.aprovado);
