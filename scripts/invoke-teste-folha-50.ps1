$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
$apiKey = $env:GIAP_RENDER_API_KEY
if (-not $apiKey -and (Test-Path $envFile)) {
  $apiKey = (Get-Content $envFile | Where-Object { $_ -match '^\s*API_KEY=' }) -replace '^\s*API_KEY=\s*','' -replace '\s*$',''
}
if (-not $apiKey) { throw 'Defina GIAP_RENDER_API_KEY ou API_KEY no .env' }
$payload = Join-Path $root 'teste-folha-50-payload.json'
$out = Join-Path $root 'teste-folha-50-result.json'
$log = Join-Path $root 'teste-folha-50-run.log'
Write-Host "[teste-folha-50] POST Render $(Get-Date -Format o)"
$curlOut = curl.exe -s -X POST "https://giap-sync-semcas.onrender.com/debug/teste-folha-50" `
  -H "Content-Type: application/json" `
  -H "X-API-Key: $apiKey" `
  --data-binary "@$payload" `
  --max-time 3600 `
  -o $out `
  -w "`nHTTP:%{http_code} TIME:%{time_total}s`n"
Add-Content -Path $log -Value $curlOut
Write-Host $curlOut
if (Test-Path $out) {
  $raw = Get-Content $out -Raw
  if ($raw -match '^\s*\{') {
    $j = $raw | ConvertFrom-Json
    if ($j.resumo) { $j.resumo | Format-List }
    if ($j.aprovado -ne $null) { Write-Host "aprovado: $($j.aprovado)" }
  } else {
    Write-Host $raw
  }
}
