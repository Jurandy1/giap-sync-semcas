$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
$apiKey = $env:GIAP_RENDER_API_KEY
if (-not $apiKey -and (Test-Path $envFile)) {
  $apiKey = (Get-Content $envFile | Where-Object { $_ -match '^\s*API_KEY=' }) -replace '^\s*API_KEY=\s*','' -replace '\s*$',''
}
if (-not $apiKey) { throw 'Defina GIAP_RENDER_API_KEY ou API_KEY no .env' }

$base = 'https://giap-sync-semcas.onrender.com'
$payload = Join-Path $root 'teste-folha-50-payload.json'
$out = Join-Path $root 'teste-folha-50-result.json'
$pollSec = if ($env:GIAP_POLL_SEC) { [int]$env:GIAP_POLL_SEC } else { 60 }
$maxWaitMin = if ($env:GIAP_POLL_MAX_MIN) { [int]$env:GIAP_POLL_MAX_MIN } else { 90 }

Write-Host "[poll] POST async teste-folha-50 $(Get-Date -Format o)"
$startResp = curl.exe -s -X POST "$base/debug/teste-folha-50" `
  -H "Content-Type: application/json" `
  -H "X-API-Key: $apiKey" `
  --data-binary "@$payload" `
  --max-time 120
$start = $startResp | ConvertFrom-Json
if (-not $start.run_id) {
  Write-Host $startResp
  throw 'Falha ao iniciar teste async'
}
$runId = $start.run_id
Write-Host "[poll] run_id=$runId poll=$($start.poll)"

$deadline = (Get-Date).AddMinutes($maxWaitMin)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds $pollSec
  $raw = curl.exe -s -H "X-API-Key: $apiKey" "$base/debug/teste-folha-50/$runId" --max-time 60
  $st = $raw | ConvertFrom-Json
  Write-Host "[poll] $(Get-Date -Format o) status=$($st.status)"
  if ($st.status -eq 'done') {
    $st.relatorio | ConvertTo-Json -Depth 20 | Set-Content -Path $out -Encoding UTF8
    if ($st.relatorio.resumo) { $st.relatorio.resumo | Format-List }
    if ($st.relatorio.aprovado -ne $null) { Write-Host "aprovado: $($st.relatorio.aprovado)" }
    exit 0
  }
  if ($st.status -eq 'error') {
    Write-Host "ERRO: $($st.error)"
    exit 1
  }
}
Write-Host "Timeout aguardando run $runId"
exit 2
