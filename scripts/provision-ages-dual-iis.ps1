[CmdletBinding()]
param(
  [ValidateSet('Apply', 'Rollback', 'Validate', 'Plan')]
  [string]$Mode = 'Plan',
  [string]$StatePath = ''
)

$ErrorActionPreference = 'Stop'
$StatePathExplicit = [bool]$StatePath
$LegacyStatePath = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'ages-dual-iis.state.json'
$RuntimeRoot = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Solinges\CH09-BRK'
if (-not $StatePath) { $StatePath = Join-Path $RuntimeRoot 'ages-dual-iis.state.json' }
$Owner = 'CH09-BRK/AGES-dual/v2'
$Schema = 2
if (-not $StatePathExplicit -and (Test-Path -LiteralPath $LegacyStatePath)) {
  throw "Legacy v1 ledger found at '$LegacyStatePath'. Roll back with the v1 provisioner before upgrading."
}
$ExpectedPath = 'C:\Sistema\AGES'
$Targets = @(
  [pscustomobject]@{ Id = 'A'; Pool = 'AGES_A'; Site = 'AGES_A_Local'; Port = 18081; Root = Join-Path $RuntimeRoot 'iis-roots\AGES_A_Local' },
  [pscustomobject]@{ Id = 'B'; Pool = 'AGES_B'; Site = 'AGES_B_Local'; Port = 18082; Root = Join-Path $RuntimeRoot 'iis-roots\AGES_B_Local' }
)

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Save-Ledger($ledger) {
  $directory = Split-Path -Parent $StatePath
  if ($directory -and -not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory | Out-Null }
  $temporary = "$StatePath.tmp"
  $ledger | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $StatePath -Force
}

function Resolve-EffectivePath([string]$path) {
  $current = Get-Item -LiteralPath ([Environment]::ExpandEnvironmentVariables($path))
  for ($i = 0; $i -lt 8 -and $current.LinkType -and $current.Target; $i++) {
    $target = [string]@($current.Target)[0]
    if (-not [IO.Path]::IsPathRooted($target)) { $target = Join-Path $current.DirectoryName $target }
    $current = Get-Item -LiteralPath $target
  }
  return $current.FullName.TrimEnd('\')
}

function Get-PoolFingerprint([string]$name) {
  $pool = Get-Item "IIS:\AppPools\$name"
  return ([ordered]@{
    name = $name
    enable32Bit = [bool]$pool.enable32BitAppOnWin64
    runtime = [string]$pool.managedRuntimeVersion
    pipeline = [string]$pool.managedPipelineMode
    startMode = [string]$pool.startMode
    queueLength = [int]$pool.queueLength
    identityType = [string]$pool.processModel.identityType
    loadUserProfile = [bool]$pool.processModel.loadUserProfile
    idleTimeout = [string]$pool.processModel.idleTimeout
    maxProcesses = [int]$pool.processModel.maxProcesses
    periodicRestart = [string]$pool.recycling.periodicRestart.time
    overlapping = -not [bool]$pool.recycling.disallowOverlappingRotation
  } | ConvertTo-Json -Compress)
}

function Get-SiteFingerprint($target, [string]$physicalPath) {
  $site = Get-Website -Name $target.Site
  $app = Get-WebApplication -Site $target.Site -Name 'AGES'
  $bindings = @(Get-WebBinding -Name $target.Site | ForEach-Object { "$($_.protocol)|$($_.bindingInformation)" } | Sort-Object)
  $applications = @(Get-WebApplication -Site $target.Site | ForEach-Object {
    "$($_.Path)|$($_.ApplicationPool)|$(Resolve-EffectivePath ([string]$_.PhysicalPath))"
  } | Sort-Object)
  return ([ordered]@{
    name = $target.Site
    port = $target.Port
    bindings = $bindings
    applications = $applications
    rootPool = [string]$site.applicationPool
    rootPath = Resolve-EffectivePath ([string]$site.physicalPath)
    appPath = [string]$app.Path
    appPool = [string]$app.ApplicationPool
    physicalPath = Resolve-EffectivePath ([string]$app.PhysicalPath)
    expectedPath = $physicalPath
  } | ConvertTo-Json -Compress)
}

function Get-DirectoryFingerprint([string]$path) {
  $entries = @(Get-ChildItem -LiteralPath $path -Force | ForEach-Object { "$($_.Name)|$($_.PSIsContainer)" } | Sort-Object)
  return ([ordered]@{ path = Resolve-EffectivePath $path; entries = $entries } | ConvertTo-Json -Compress)
}

function Remove-OwnedDirectory([string]$path) {
  if (@(Get-ChildItem -LiteralPath $path -Force).Count) { throw "Owned directory '$path' contains foreign content; refusing deletion." }
  Remove-Item -LiteralPath $path
}

function Get-ResourceFingerprint($entry) {
  if ($entry.type -eq 'pool') { return Get-PoolFingerprint $entry.name }
  if ($entry.type -eq 'directory') { return Get-DirectoryFingerprint $entry.name }
  $target = $Targets | Where-Object Site -eq $entry.name
  return Get-SiteFingerprint $target $entry.physicalPath
}

function Test-ResourceExists($entry) {
  if ($entry.type -eq 'pool') { return Test-Path "IIS:\AppPools\$($entry.name)" }
  if ($entry.type -eq 'directory') { return Test-Path -LiteralPath $entry.name }
  return [bool](Get-Website -Name $entry.name -ErrorAction SilentlyContinue)
}

function Assert-ExclusivePoolUse($entry) {
  $foreignSites = @(Get-Website | Where-Object ApplicationPool -eq $entry.name)
  $foreignApps = @(Get-WebApplication | Where-Object ApplicationPool -eq $entry.name)
  if ($foreignSites.Count -or $foreignApps.Count) { throw "AppPool '$($entry.name)' has foreign consumers; refusing deletion." }
}

function Assert-Prerequisites([bool]$mutation, [bool]$requireSource = $true) {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'IIS provisioning is supported only on Windows.' }
  if (-not (Get-Module -ListAvailable WebAdministration)) { throw 'WebAdministration is not installed.' }
  if ($mutation -and -not (Test-IsAdministrator)) { throw 'Apply and Rollback require an elevated PowerShell session.' }
  Import-Module WebAdministration
  if (-not $requireSource) { return }
  if (-not (Test-Path 'IIS:\AppPools\AGES')) { throw "Source AppPool 'AGES' was not found." }
  $apps = @(Get-WebApplication | Where-Object Path -eq '/AGES')
  if ($apps.Count -ne 1) { throw "Expected exactly one source application '/AGES'; found $($apps.Count)." }
  $effectivePath = Resolve-EffectivePath ([string]$apps[0].PhysicalPath)
  if (-not $effectivePath.Equals($ExpectedPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Source /AGES resolves to '$effectivePath', expected '$ExpectedPath'."
  }
  foreach ($target in $Targets) {
    $otherBindings = @(Get-WebBinding | Where-Object bindingInformation -eq "*:$($target.Port):")
    if ($otherBindings.Count -and -not (Test-Path $StatePath)) { throw "Port $($target.Port) is already owned by another IIS binding." }
  }
  return [pscustomobject]@{ SourcePool = Get-Item 'IIS:\AppPools\AGES'; PhysicalPath = $effectivePath }
}

function Get-DesiredPoolFingerprint($target, $source) {
  return ([ordered]@{
    name = $target.Pool
    enable32Bit = [bool]$source.enable32BitAppOnWin64
    runtime = [string]$source.managedRuntimeVersion
    pipeline = [string]$source.managedPipelineMode
    startMode = [string]$source.startMode
    queueLength = [int]$source.queueLength
    identityType = [string]$source.processModel.identityType
    loadUserProfile = [bool]$source.processModel.loadUserProfile
    idleTimeout = [string]$source.processModel.idleTimeout
    maxProcesses = 1
    periodicRestart = '00:00:00'
    overlapping = $true
  } | ConvertTo-Json -Compress)
}

function Set-PoolConfiguration($target, $source) {
  $path = "IIS:\AppPools\$($target.Pool)"
  foreach ($property in @('enable32BitAppOnWin64', 'managedRuntimeVersion', 'managedPipelineMode', 'startMode', 'queueLength')) {
    Set-ItemProperty $path -Name $property -Value $source.$property
  }
  foreach ($property in @('identityType', 'loadUserProfile', 'idleTimeout')) {
    Set-ItemProperty $path -Name "processModel.$property" -Value $source.processModel.$property
  }
  if (@('SpecificUser', '3') -contains [string]$source.processModel.identityType) {
    $user = [string]$source.processModel.userName
    $password = [string]$source.processModel.password
    if (-not $user -or -not $password) { throw 'SpecificUser credentials cannot be read securely; no target resources were mutated.' }
    Set-ItemProperty $path -Name processModel.userName -Value $user
    Set-ItemProperty $path -Name processModel.password -Value $password
  }
  Set-ItemProperty $path -Name processModel.maxProcesses -Value 1
  Set-ItemProperty $path -Name recycling.periodicRestart.time -Value ([TimeSpan]::Zero)
  Set-ItemProperty $path -Name recycling.disallowOverlappingRotation -Value $false
}

function Assert-OwnedState($ledger) {
  if ($ledger.owner -ne $Owner -or $ledger.schema -ne $Schema -or $ledger.status -ne 'complete') { throw 'State ledger is incomplete or belongs to another provisioner.' }
  foreach ($entry in $ledger.resources) {
    if ($entry.status -ne 'created' -or (Get-ResourceFingerprint $entry) -ne $entry.fingerprint) {
      throw "Owned resource '$($entry.name)' no longer matches its exact fingerprint."
    }
  }
}

function Invoke-Apply {
  $context = Assert-Prerequisites $true
  if (Test-Path $StatePath) {
    $existing = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
    if ($existing.owner -eq $Owner -and $existing.status -eq 'apply-failed-clean') {
      if (@($existing.resources | Where-Object { Test-ResourceExists $_ }).Count) { throw 'Failed Apply still has owned resources; manual recovery required.' }
      Remove-Item -LiteralPath $StatePath -Force
    } elseif ($existing.owner -eq $Owner -and $existing.status -eq 'apply-cleanup') {
      throw 'A previous Apply requires recovery; run -Mode Rollback.'
    } else {
    Assert-OwnedState $existing
    Write-Host 'AGES dual IIS resources already match the owned state.'
    return
    }
  }
  foreach ($target in $Targets) {
    if ((Test-Path "IIS:\AppPools\$($target.Pool)") -or (Get-Website -Name $target.Site -ErrorAction SilentlyContinue) -or
        (Test-Path -LiteralPath $target.Root)) {
      throw "Target '$($target.Pool)', '$($target.Site)' or '$($target.Root)' already exists without ownership state."
    }
  }
  if (@('SpecificUser', '3') -contains [string]$context.SourcePool.processModel.identityType -and
      (-not [string]$context.SourcePool.processModel.userName -or -not [string]$context.SourcePool.processModel.password)) {
    throw 'SpecificUser credentials cannot be read securely; refusing all mutations.'
  }

  $ledger = [ordered]@{ owner = $Owner; schema = $Schema; status = 'applying'; backup = "AGES-dual-$((Get-Date).ToString('yyyyMMdd-HHmmss'))-$PID"; resources = @() }
  Save-Ledger $ledger
  $createdThisRun = [Collections.Generic.List[object]]::new()
  try {
    Backup-WebConfiguration -Name $ledger.backup
    foreach ($target in $Targets) {
      $poolEntry = [ordered]@{ type = 'pool'; name = $target.Pool; status = 'pending'; fingerprint = Get-DesiredPoolFingerprint $target $context.SourcePool }
      $ledger.resources += $poolEntry; Save-Ledger $ledger
      New-WebAppPool -Name $target.Pool | Out-Null
      $createdThisRun.Add([pscustomobject]@{ type = 'pool'; name = $target.Pool })
      Set-PoolConfiguration $target $context.SourcePool
      if ((Get-PoolFingerprint $target.Pool) -ne $poolEntry.fingerprint) { throw "AppPool '$($target.Pool)' configuration mismatch." }
      $poolEntry.status = 'created'; Save-Ledger $ledger

      $directoryEntry = [ordered]@{ type = 'directory'; name = $target.Root; status = 'pending'; fingerprint = '' }
      $ledger.resources += $directoryEntry; Save-Ledger $ledger
      New-Item -ItemType Directory -Path $target.Root | Out-Null
      $createdThisRun.Add([pscustomobject]@{ type = 'directory'; name = $target.Root })
      $directoryEntry.fingerprint = Get-DirectoryFingerprint $target.Root
      $directoryEntry.status = 'created'; Save-Ledger $ledger

      $siteEntry = [ordered]@{ type = 'site'; name = $target.Site; status = 'pending'; physicalPath = $context.PhysicalPath; fingerprint = '' }
      $ledger.resources += $siteEntry; Save-Ledger $ledger
      New-Website -Name $target.Site -Port $target.Port -IPAddress '*' -PhysicalPath $target.Root -ApplicationPool $target.Pool | Out-Null
      $createdThisRun.Add([pscustomobject]@{ type = 'site'; name = $target.Site })
      New-WebApplication -Site $target.Site -Name 'AGES' -PhysicalPath $context.PhysicalPath -ApplicationPool $target.Pool | Out-Null
      $siteEntry.fingerprint = Get-SiteFingerprint $target $context.PhysicalPath
      $siteEntry.status = 'created'; Save-Ledger $ledger
    }
    $ledger.status = 'complete'; Save-Ledger $ledger
    Write-Host 'AGES dual IIS provisioning applied.'
  } catch {
    $cleanupFailed = $false
    $ledger.status = 'apply-cleanup'; Save-Ledger $ledger
    for ($index = $createdThisRun.Count - 1; $index -ge 0; $index--) {
      $resource = $createdThisRun[$index]
      $entry = $ledger.resources | Where-Object { $_.type -eq $resource.type -and $_.name -eq $resource.name }
      $entry.status = 'deleting'; Save-Ledger $ledger
      try {
        if ($resource.type -eq 'site') { Remove-Website -Name $resource.name }
        elseif ($resource.type -eq 'directory') { Remove-OwnedDirectory $resource.name }
        else { Remove-WebAppPool -Name $resource.name }
        $entry.status = 'deleted'; Save-Ledger $ledger
      } catch { $cleanupFailed = $true }
    }
    if (-not $cleanupFailed) {
      $ledger.status = 'apply-failed-clean'; Save-Ledger $ledger
      Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
    }
    else { Write-Warning 'Cleanup was incomplete; ownership ledger retained for manual recovery.' }
    throw
  }
}

function Invoke-Rollback {
  Assert-Prerequisites $true $false | Out-Null
  if (-not (Test-Path $StatePath)) { throw 'No owned state ledger exists; refusing rollback.' }
  $ledger = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
  if ($ledger.owner -ne $Owner -or $ledger.schema -ne $Schema -or @('complete', 'apply-cleanup', 'rolling-back', 'rollback-complete') -notcontains $ledger.status) {
    throw 'State ledger is not eligible for rollback.'
  }
  if ($ledger.status -eq 'apply-cleanup') {
    foreach ($entry in $ledger.resources | Where-Object status -eq 'pending') {
      if (Test-ResourceExists $entry) { throw "Pending resource '$($entry.name)' exists ambiguously; refusing rollback." }
      $entry.status = 'deleted'; Save-Ledger $ledger
    }
    $ledger.status = 'rolling-back'; Save-Ledger $ledger
  }
  if ($ledger.status -eq 'complete') {
    Assert-OwnedState $ledger
    $ledger.status = 'rolling-back'; Save-Ledger $ledger
  }
  if ($ledger.status -eq 'rolling-back') {
    foreach ($entry in @($ledger.resources)[($ledger.resources.Count - 1)..0]) {
      if ($entry.status -eq 'deleted') {
        if (Test-ResourceExists $entry) { throw "Deleted resource '$($entry.name)' reappeared; refusing rollback." }
        continue
      }
      if ($entry.status -eq 'deleting' -and -not (Test-ResourceExists $entry)) {
        $entry.status = 'deleted'; Save-Ledger $ledger; continue
      }
      if (-not (Test-ResourceExists $entry) -or (Get-ResourceFingerprint $entry) -ne $entry.fingerprint) {
        throw "Owned resource '$($entry.name)' is missing or changed; refusing rollback."
      }
      if ($entry.type -eq 'pool') { Assert-ExclusivePoolUse $entry }
      $entry.status = 'deleting'; Save-Ledger $ledger
      if ($entry.type -eq 'site') { Remove-Website -Name $entry.name }
      elseif ($entry.type -eq 'directory') { Remove-OwnedDirectory $entry.name }
      else { Remove-WebAppPool -Name $entry.name }
      $entry.status = 'deleted'; Save-Ledger $ledger
    }
    $ledger.status = 'rollback-complete'; Save-Ledger $ledger
  }
  Remove-Item -LiteralPath $StatePath -Force
  Write-Host 'AGES dual IIS provisioning rolled back.'
}

function Invoke-Validate {
  $context = Assert-Prerequisites $false
  if (Test-Path $StatePath) {
    Assert-OwnedState (Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json)
    Write-Host 'Owned AGES dual IIS resources are valid.'
  } else {
    Write-Host "Source validated: /AGES -> $($context.PhysicalPath). Targets are not owned yet."
  }
}

switch ($Mode) {
  'Apply' { Invoke-Apply }
  'Rollback' { Invoke-Rollback }
  'Validate' { Invoke-Validate }
  'Plan' {
    if (-not (Test-IsAdministrator)) {
      Write-Host 'Read-only plan (IIS state not validated without elevation): create AGES_A/AGES_A_Local:18081 and AGES_B/AGES_B_Local:18082 for C:\Sistema\AGES.'
      break
    }
    $context = Assert-Prerequisites $false
    Write-Host "Plan: create AGES_A/AGES_A_Local:18081 and AGES_B/AGES_B_Local:18082 for /AGES -> $($context.PhysicalPath). No changes made."
  }
}
