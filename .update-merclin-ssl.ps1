$files = @(
  @{ Path = 'C:\Servidor\Solinges\ecosystem\dockerzone\CH09-BRK\.env'; HostSsl = '44048' },
  @{ Path = 'C:\Servidor\Solinges\ecosystem\ch09-brk\config\.env'; HostSsl = '44048' },
  @{ Path = 'C:\Servidor\Solinges\ecosystem\dockerzone\CH09-BRK_Testing\.env'; HostSsl = '54048' },
  @{ Path = 'C:\Servidor\Solinges\ecosystem\ch09-brk_Testing\config\.env'; HostSsl = '54048' }
)

function Set-Key($path, $key, $value) {
  $raw = Get-Content -LiteralPath $path -Raw
  $pattern = '(?m)^\s*' + [regex]::Escape($key) + '\s*=.*$'
  if ($raw -match $pattern) {
    $raw = [regex]::Replace($raw, $pattern, '    ' + $key + '=' + $value)
    Set-Content -LiteralPath $path -Value $raw -Encoding ascii
  } else {
    Add-Content -LiteralPath $path -Value ('    ' + $key + '=' + $value)
  }
}

foreach ($item in $files) {
  $p = $item.Path
  $bak = $p + '.bak_ssl_' + (Get-Date -Format 'yyyyMMddHHmmss')
  Copy-Item -LiteralPath $p -Destination $bak -Force
  Set-Key $p 'PORT_SSL' '44048'
  Set-Key $p 'HOST_SSL_PORT' $item.HostSsl
  Set-Key $p 'CONTAINER_SSL_PORT' '44048'
  Set-Key $p 'SSL_CERT_DOMAIN' 'merclin.gotdns.org'
  Write-Host "UPDATED=$p"
  Write-Host "BACKUP=$bak"
}

Set-Location 'C:\Servidor\Solinges\ecosystem\dockerzone\CH09-BRK'
docker compose config --quiet
Write-Host 'prod compose ok'
Set-Location 'C:\Servidor\Solinges\ecosystem\dockerzone\CH09-BRK_Testing'
docker compose config --quiet
Write-Host 'testing compose ok'
