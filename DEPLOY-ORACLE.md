# Deploy grátis — Oracle Cloud Always Free

A API GIAP (`giap-sync-semcas`) sobe numa VPS Always Free da Oracle (não usa seu PC).

Repo: https://github.com/Jurandy1/giap-sync-semcas

---

## 1. Criar conta Oracle Cloud

1. Acesse: https://www.oracle.com/cloud/free/
2. **Start for free** → cadastro (precisa de cartão para verificação; o Always Free não cobra se ficar nos limites).
3. Escolha região (ex.: **Brazil East (Sao Paulo)** se disponível, ou a mais próxima).

---

## 2. Abrir porta 3000 (firewall)

No console Oracle → **Networking** → **Virtual Cloud Networks** → sua VCN → **Security Lists** → Default:

- **Ingress Rule** nova:
  - Source: `0.0.0.0/0`
  - IP Protocol: TCP
  - Destination Port: **3000**
  - Description: `giap-api`

(Mantenha a regra da porta **22** para SSH.)

---

## 3. Criar a VM Always Free

**Compute → Instances → Create Instance**

| Campo | Valor sugerido |
|-------|----------------|
| Name | `giap-sync` |
| Image | **Canonical Ubuntu 22.04** |
| Shape | **VM.Standard.A1.Flex** (Ampere) — Always Free |
| OCPUs | 1 |
| Memory | 6 GB (Chrome/Puppeteer precisa de RAM) |
| SSH keys | Gere um par e **guarde o `.key` privado** |
| Subnet | Public subnet |
| Assign public IPv4 | **Yes** |

Se A1 estiver “out of capacity”, tente outra AD/região ou shape AMD Always Free (menos RAM — pode apertar para Puppeteer).

Anote o **IP público**.

---

## 4. Conectar e instalar Docker

No PowerShell (ajuste o caminho da chave e o IP):

```powershell
ssh -i C:\caminho\sua-chave.key ubuntu@IP_PUBLICO
```

Na VM:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io
sudo usermod -aG docker ubuntu
# saia e entre de novo no SSH para o grupo docker valer
exit
```

Entre de novo no SSH.

---

## 5. Subir a API

```bash
git clone https://github.com/Jurandy1/giap-sync-semcas.git
cd giap-sync-semcas

cat > .env << 'EOF'
API_KEY=troque-por-chave-forte
SUPABASE_URL=https://isqslnnixdudhpunwnpx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=COLE_A_SERVICE_ROLE_AQUI
PUPPETEER_DOCKER=1
PORT=3000
EOF

sudo docker build -t giap-sync .
sudo docker run -d --name giap-sync --restart unless-stopped \
  -p 3000:3000 --env-file .env \
  --shm-size=1gb \
  giap-sync
```

Teste:

```bash
curl http://127.0.0.1:3000/health
```

Do seu PC:

```powershell
Invoke-RestMethod http://IP_PUBLICO:3000/health
```

Deve retornar `ok: true`.

---

## 6. Ligar o botão do RH (Edge Function)

No Supabase → Edge Functions → secrets:

| Secret | Valor |
|--------|--------|
| `GIAP_API_URL` | `http://IP_PUBLICO:3000` (ou HTTPS se configurar depois) |
| `GIAP_API_KEY` | o mesmo `API_KEY` do `.env` |

Deploy da function `giap-proxy` (código em `RHSEMCAS/supabase/functions/giap-proxy`).

> Se o Supabase bloquear HTTP puro, use um túnel HTTPS grátis (Cloudflare Tunnel) apontando para a porta 3000, ou Nginx + Let's Encrypt no domínio.

---

## 7. Cron dia 27 (na própria VPS)

```bash
crontab -e
```

Adicione (06:00 todo dia; a API só roda se for o dia configurado e automático=ligado):

```
0 6 * * * curl -s -X POST http://127.0.0.1:3000/cron/mensal -H "X-API-Key: SUA_CHAVE" >/dev/null 2>&1
```

---

## Problemas comuns

| Problema | Solução |
|----------|---------|
| Shape A1 indisponível | Trocar Availability Domain / região |
| `/health` timeout de fora | Security List porta 3000 + iptables |
| Chrome crash / OOM | Subir memória da VM (até 24 GB no free Ampere compartilhado) ou `--shm-size=1gb` |
| Container reiniciando | `sudo docker logs giap-sync` |

---

## Depois que tiver o IP

1. Confirme `http://IP:3000/health`
2. Me envie o IP (sem colar a service_role / API_KEY no chat)
3. Seguimos com o `giap-proxy` no Supabase
