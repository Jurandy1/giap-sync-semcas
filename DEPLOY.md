# Deploy online — GIAP no RHSEMCAS

Objetivo: o botão **Rodar agora** no menu Relatório API funcionar pela internet.

```
RH (navegador) → Edge Function giap-proxy → Railway (giap-sync-semcas) → Portal + Supabase
```

---

## A) Publicar a API no Railway (~10 min)

1. Crie conta em https://railway.app (pode logar com GitHub).
2. No GitHub, crie um repositório **novo** (ex.: `giap-sync-semcas`), **privado**.
3. Neste PC, na pasta do projeto:

```powershell
cd c:\Users\PC\Desktop\giap-sync-semcas
git init
git add .
git commit -m "API GIAP sync SEMCAS"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/giap-sync-semcas.git
git push -u origin main
```

4. No Railway: **New Project** → **Deploy from GitHub** → escolha `giap-sync-semcas`.
5. Em **Variables**, cadastre (iguais ao `.env` local, sem PORT):

| Variável | Valor |
|----------|--------|
| `API_KEY` | gere uma chave forte (ex. no PowerShell: `-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | % {[char]$_})`) |
| `SUPABASE_URL` | `https://isqslnnixdudhpunwnpx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | a service_role do Supabase |
| `PUPPETEER_DOCKER` | `1` |

6. Em **Settings → Networking → Public Networking**: **Generate Domain**.
7. Anote a URL, tipo: `https://giap-sync-semcas-production-xxxx.up.railway.app`
8. Teste no navegador: `https://SUA-URL/health` → deve mostrar `{"ok":true,...}`

---

## B) Edge Function `giap-proxy` no Supabase

1. Abra o projeto: https://supabase.com/dashboard/project/isqslnnixdudhpunwnpx  
2. **Edge Functions** → **Create function** → nome: `giap-proxy`  
3. Cole o conteúdo de `RHSEMCAS/supabase/functions/giap-proxy/index.ts`  
4. **Secrets** (Project Settings → Edge Functions → Secrets):

| Secret | Valor |
|--------|--------|
| `GIAP_API_URL` | URL do Railway **sem** barra no final |
| `GIAP_API_KEY` | o **mesmo** `API_KEY` do Railway |

5. Deploy a function.

Ou com CLI (se instalar depois):

```powershell
supabase login
supabase link --project-ref isqslnnixdudhpunwnpx
supabase secrets set GIAP_API_URL=https://SUA-URL.up.railway.app GIAP_API_KEY=sua-chave
supabase functions deploy giap-proxy
```

---

## C) Cron dia 27 (opcional, depois que A+B funcionarem)

No Railway → **Cron Jobs** (ou serviço HTTP cron):

- URL: `https://SUA-URL/cron/mensal`
- Method: `POST`
- Header: `X-API-Key: sua-chave`
- Schedule: `0 6 * * *` (todo dia 6h UTC; o endpoint só roda se `giap_config.automatico` e o dia for o configurado)

---

## D) Teste no sistema

1. Abra o RHSEMCAS logado.
2. Menu **Relatório API**.
3. Clique **Simular** ou **Rodar agora**.
4. A barra de % deve avançar.

Se der erro de proxy: confira secrets `GIAP_API_URL` / `GIAP_API_KEY` e se `/health` do Railway responde.
