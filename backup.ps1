$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# Lire les infos depuis .env
$envFile = Join-Path $root ".env"
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#=\s]+)\s*=\s*(.*)\s*$') {
        Set-Variable -Name $Matches[1] -Value $Matches[2]
    }
}

$dir = Join-Path $root "backups"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$stamp = Get-Date -Format "yyyy-MM-dd_HH-mm"
$file = Join-Path $dir "noor_inventory_$stamp.sql"

$env:MYSQL_PWD = $DB_PASSWORD
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe" -u $DB_USER -h $DB_HOST -P $DB_PORT --routines --triggers --single-transaction $DB_NAME | Out-File -FilePath $file -Encoding utf8

if ((Get-Item $file).Length -gt 1KB) {
    # Garder uniquement les 30 derniers backups
    Get-ChildItem $dir -Filter *.sql | Sort-Object LastWriteTime -Descending | Select-Object -Skip 30 | Remove-Item -Force
    Write-Output "OK: $file ($([math]::Round((Get-Item $file).Length/1KB,1)) KB)"
} else {
    Write-Output "ERREUR: backup vide!"
    exit 1
}
