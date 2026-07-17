-- ============================================================
-- Ajustes na sua tabela HR EXISTENTE (não roda automaticamente)
-- Ajusta os nomes de tabela/coluna se seu schema for diferente
-- ============================================================

-- Colunas que o /match/hr precisa
ALTER TABLE hr_servidores ADD COLUMN IF NOT EXISTS tipo_vinculo TEXT;
  -- valores esperados: 'efetivo' | 'terceirizado' | NULL (ainda não classificado)

ALTER TABLE hr_servidores ADD COLUMN IF NOT EXISTS exonerado BOOLEAN DEFAULT FALSE;

ALTER TABLE hr_servidores ADD COLUMN IF NOT EXISTS data_exoneracao DATE;

-- Índices pra acelerar o match
CREATE INDEX IF NOT EXISTS idx_hr_cpf ON hr_servidores(cpf);
CREATE INDEX IF NOT EXISTS idx_hr_matricula ON hr_servidores(matricula);
CREATE INDEX IF NOT EXISTS idx_hr_tipo_vinculo ON hr_servidores(tipo_vinculo);

-- Constraint opcional pra proteger valores
ALTER TABLE hr_servidores DROP CONSTRAINT IF EXISTS chk_tipo_vinculo;
ALTER TABLE hr_servidores ADD CONSTRAINT chk_tipo_vinculo
  CHECK (tipo_vinculo IS NULL OR tipo_vinculo IN ('efetivo', 'terceirizado', 'comissionado'));
