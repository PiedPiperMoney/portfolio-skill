# Node.js для навыка без прав администратора (Windows): если нет Node 18+, качает официальный Node LTS с nodejs.org
# в %USERPROFILE%\.portfolio-node (со сверкой контрольной суммы) и печатает путь к node.exe. Есть свой — печатает его.
# Запускает агент:  $NODE = powershell -NoProfile -ExecutionPolicy Bypass -File <навык>\engine\get-node.ps1
# (Bypass — только для этого запуска: по умолчанию Windows скрипты .ps1 не запускает). Мак и Linux — get-node.sh рядом.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$dest = Join-Path $env:USERPROFILE '.portfolio-node'
$line = 'latest-v24.x'

$have = Get-Command node -ErrorAction SilentlyContinue
if ($have -and [int]((& node -p "process.versions.node.split('.')[0]")) -ge 18) { $have.Source; exit 0 }
if (Test-Path (Join-Path $dest 'node.exe')) { Join-Path $dest 'node.exe'; exit 0 }

$platform = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
$base = "https://nodejs.org/dist/$line"
$sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content -split "`n"
$row = $sums | Where-Object { $_ -match "node-v[0-9.]+-$platform\.zip$" } | Select-Object -First 1
if (-not $row) { Write-Error "На nodejs.org не нашёл сборку $platform." }
$want, $file = ($row.Trim() -split '\s+')

$tmp = Join-Path $env:TEMP ('portfolio-node-' + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
try {
  [Console]::Error.WriteLine("Качаю $file с nodejs.org…")
  Invoke-WebRequest "$base/$file" -OutFile (Join-Path $tmp $file) -UseBasicParsing
  $got = (Get-FileHash (Join-Path $tmp $file) -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $want) { Write-Error 'Контрольная сумма не сошлась — файл повреждён, ничего не ставлю.' }
  Expand-Archive (Join-Path $tmp $file) $tmp
  # переносим целиком в конце: оборвалось раньше — .portfolio-node не появится полусобранной
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Move-Item (Join-Path $tmp ($file -replace '\.zip$', '')) $dest
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Join-Path $dest 'node.exe'
