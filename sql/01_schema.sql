-- ============================================================
-- Schema do giap-sync-semcas
-- Rodar 1x no SQL Editor do Supabase
-- ============================================================

-- Tabela: folha oficial PMSL (source of truth externo)
CREATE TABLE IF NOT EXISTS folha_pmsl (
  id BIGSERIAL PRIMARY KEY,
  competencia INTEGER NOT NULL,
  codigo_instituicao INTEGER NOT NULL,
  codigo_orgao TEXT,
  lotacao TEXT,
  matricula TEXT NOT NULL,
  cpf TEXT,
  funcionario TEXT NOT NULL,
  funcionario_norm TEXT,
  cargo_origem TEXT,
  cargo_comissionado TEXT,
  horas_semanais INTEGER,
  vencimento_base NUMERIC(12,2),
  proventos NUMERIC(12,2),
  descontos NUMERIC(12,2),
  liquido NUMERIC(12,2),
  admissao DATE,
  demissao DATE,
  raw_json JSONB,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT folha_pmsl_uk UNIQUE (competencia, matricula, codigo_instituicao)
);

CREATE INDEX IF NOT EXISTS idx_folha_cpf ON folha_pmsl(cpf);
CREATE INDEX IF NOT EXISTS idx_folha_matricula ON folha_pmsl(matricula);
CREATE INDEX IF NOT EXISTS idx_folha_lotacao ON folha_pmsl(lotacao);
CREATE INDEX IF NOT EXISTS idx_folha_nome_norm ON folha_pmsl(funcionario_norm);
CREATE INDEX IF NOT EXISTS idx_folha_competencia ON folha_pmsl(competencia DESC);
CREATE INDEX IF NOT EXISTS idx_folha_demissao ON folha_pmsl(demissao) WHERE demissao IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_folha_orgao ON folha_pmsl(codigo_orgao);

-- Tabela: log de todas as operações de sync
CREATE TABLE IF NOT EXISTS giap_sync_log (
  id BIGSERIAL PRIMARY KEY,
  tipo TEXT NOT NULL,
  parametros JSONB NOT NULL DEFAULT '{}'::jsonb,
  registros_encontrados INTEGER DEFAULT 0,
  registros_inseridos INTEGER DEFAULT 0,
  registros_atualizados INTEGER DEFAULT 0,
  erro TEXT,
  duracao_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_log_tipo ON giap_sync_log(tipo, created_at DESC);

-- View: última competência conhecida de cada servidor
CREATE OR REPLACE VIEW folha_pmsl_atual AS
SELECT DISTINCT ON (matricula, codigo_instituicao) *
FROM folha_pmsl
ORDER BY matricula, codigo_instituicao, competencia DESC;

-- View: servidores com demissao preenchida
CREATE OR REPLACE VIEW folha_pmsl_exonerados AS
SELECT DISTINCT ON (matricula) *
FROM folha_pmsl
WHERE demissao IS NOT NULL
ORDER BY matricula, competencia DESC;
