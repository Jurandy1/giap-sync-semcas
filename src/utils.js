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
