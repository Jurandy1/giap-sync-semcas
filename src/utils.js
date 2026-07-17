/**
 * Normaliza CPF removendo qualquer coisa não-numérica e padding com zero à esquerda.
 * O GIAP retorna CPF como número, então CPFs que começam com 0 perdem o dígito.
 * padStart(11, '0') recupera isso.
 */
export function normalizarCPF(cpf) {
  if (cpf === null || cpf === undefined || cpf === '') return null;
  const digits = String(cpf).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length > 11) return null; // CPF válido tem <=11 dígitos
  return digits.padStart(11, '0');
}

/**
 * Normaliza nome pra comparação:
 * - Remove acentos (NFD + strip combining marks)
 * - UPPERCASE
 * - Remove caracteres não-alfanuméricos exceto espaço
 * - Colapsa múltiplos espaços
 */
export function normalizarNome(nome) {
  if (!nome) return null;
  return String(nome)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokens do nome (palavras), já normalizados. */
export function tokensNome(nome) {
  const n = normalizarNome(nome);
  if (!n) return [];
  return n.split(' ').filter(Boolean);
}

/**
 * Similaridade de nomes (0–1) por tokens em comum.
 * Exige que o menor nome tenha quase todos os tokens no maior
 * (evita casar "JOAO" com "JOAO PEDRO SILVA" sem mais evidência).
 */
export function similaridadeNome(a, b) {
  const ta = tokensNome(a);
  const tb = tokensNome(b);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  const comuns = ta.filter((t) => setB.has(t)).length;
  const menor = Math.min(ta.length, tb.length);
  const maior = Math.max(ta.length, tb.length);
  if (menor === 0) return 0;
  // Cobertura do menor + leve peso do tamanho
  const cobertura = comuns / menor;
  const tamanho = menor / maior;
  return cobertura * 0.85 + tamanho * 0.15;
}

/**
 * Nome "forte" para busca no GIAP: usa o nome completo.
 * Se tiver mais de 4 tokens, manda os 4 primeiros (limite prático do portal).
 */
export function nomeBuscaGiap(nome) {
  const tokens = tokensNome(nome);
  if (!tokens.length) return null;
  if (tokens.length <= 4) return tokens.join(' ');
  return tokens.slice(0, 4).join(' ');
}

/**
 * Converte data no formato DD-MM-YYYY (GIAP) pra ISO YYYY-MM-DD (Postgres).
 */
export function parseDataBR(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Retorna a competência YYYYMM "segura" — mês anterior ao atual.
 * A folha do mês corrente costuma ficar disponível só no fim do mês.
 */
export function competenciaAtual() {
  const d = new Date();
  const ano = d.getFullYear();
  const mes = d.getMonth(); // 0-indexed, então getMonth() = mês anterior
  if (mes === 0) return (ano - 1) * 100 + 12;
  return ano * 100 + mes;
}

/**
 * Valida formato de competência (YYYYMM).
 */
export function validarCompetencia(c) {
  const n = Number(c);
  if (!Number.isInteger(n)) return false;
  const ano = Math.floor(n / 100);
  const mes = n % 100;
  return ano >= 2000 && ano <= 2100 && mes >= 1 && mes <= 12;
}
