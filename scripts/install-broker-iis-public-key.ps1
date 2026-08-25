[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$PublicKeyPath
)

$ErrorActionPreference = 'Stop'
$administratorsSid = [Security.Principal.SecurityIdentifier]'S-1-5-32-544'
$systemSid = [Security.Principal.SecurityIdentifier]'S-1-5-18'

function Assert-NoReparsePoint([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse point: $Path" }
}

function Assert-ClosedAcl([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $administratorsSid.Value) { throw 'Unexpected authorized_keys owner.' }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 2 -or $rules.Where({
        $_.IsInherited -or $_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $_.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
        $_.IdentityReference.Value -notin @($administratorsSid.Value, $systemSid.Value) }).Count -ne 0) {
        throw 'authorized_keys ACL is not closed to Administrators and SYSTEM.'
    }
}

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this script from an elevated PowerShell session.' }

if ([IO.Path]::GetExtension($PublicKeyPath) -ne '.pub') { throw 'Only a .pub public key file is accepted.' }
Assert-NoReparsePoint $PublicKeyPath

$publicKeyLines = @(Get-Content -LiteralPath $PublicKeyPath | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($publicKeyLines.Count -ne 1 -or $publicKeyLines[0] -notmatch '^ssh-ed25519 [A-Za-z0-9+/]+={0,3}(?: .*)?$') {
    throw 'The supplied file is not one valid Ed25519 public key.'
}

$sshDirectory = Join-Path $env:ProgramData 'ssh'
$authorizedKeys = Join-Path $sshDirectory 'administrators_authorized_keys'
New-Item -ItemType Directory -Path $sshDirectory -Force | Out-Null
Assert-NoReparsePoint $sshDirectory
if (-not (Test-Path -LiteralPath $authorizedKeys -PathType Leaf)) { New-Item -ItemType File -Path $authorizedKeys -Force | Out-Null }
Assert-NoReparsePoint $authorizedKeys

$closedAcl = [Security.AccessControl.FileSecurity]::new()
$closedAcl.SetOwner($administratorsSid)
$closedAcl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($administratorsSid, $systemSid)) {
    $closedAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
}
Set-Acl -LiteralPath $authorizedKeys -AclObject $closedAcl
Assert-ClosedAcl $authorizedKeys

$existing = @(Get-Content -LiteralPath $authorizedKeys -ErrorAction SilentlyContinue)
if ($existing -notcontains $publicKeyLines[0]) {
    Add-Content -LiteralPath $authorizedKeys -Value $publicKeyLines[0] -Encoding ascii
}
Assert-NoReparsePoint $authorizedKeys
Assert-ClosedAcl $authorizedKeys

Write-Output 'Broker public key authorized. No private key was read or copied.'
