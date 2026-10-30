param(
  [Parameter(Mandatory = $true)][int]$AppPid,
  [Parameter(Mandatory = $true)][string]$AppExe,
  [int]$Port = 0
)

# Detached helper: stop the desktop app tree-free, wait for it to go, start it again.
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as GBK.
#
# -Port is supplied by the host half from the request's own Host header, because the desktop
# app binds a fresh port on every launch. 0 means "unknown" and disables the port checks;
# the helper then waits on the process instead, which is slower but never wrong.

$ErrorActionPreference = 'SilentlyContinue'
$log = Join-Path $env:USERPROFILE '.dsh\desktop-quick-actions.log'
$port = $Port

function Write-Note([string]$text) {
  try {
    Add-Content -Path $log -Value ('[' + (Get-Date).ToString('o') + '] relaunch: ' + $text) -Encoding UTF8
  } catch {
  }
}

function Test-PortListening {
  if ($port -le 0) { return $null }
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

Write-Note ('helper start: pid=' + $AppPid + ' exe=' + $AppExe + ' port=' + $port)

# Let the HTTP response reach the browser before the window disappears.
Start-Sleep -Milliseconds 900

$target = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $AppPid) -ErrorAction SilentlyContinue

# Safety guard: only touch a pid that still belongs to the executable we are about to relaunch.
if ($null -ne $target -and $target.ExecutablePath -and ($target.ExecutablePath -ne $AppExe)) {
  Write-Note ('abort: pid ' + $AppPid + ' belongs to ' + $target.ExecutablePath)
  exit 0
}

# Reuse the original command line so custom flags (for example --user-data-dir) survive.
$extra = ''
if ($null -ne $target -and $target.CommandLine) {
  $cl = $target.CommandLine.Trim()
  if ($cl.StartsWith('"')) {
    $close = $cl.IndexOf('"', 1)
    if ($close -gt 0) { $extra = $cl.Substring($close + 1).Trim() }
  } else {
    $space = $cl.IndexOf(' ')
    if ($space -gt 0) { $extra = $cl.Substring($space + 1).Trim() }
  }
}

if ($null -ne $target) {
  Write-Note 'stopping app process'
  Stop-Process -Id $AppPid -Force -ErrorAction SilentlyContinue
} else {
  Write-Note 'app pid already gone'
}

# Wait for the app and its host to release the web port (single-instance lock depends on it).
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  $alive = Get-Process -Id $AppPid -ErrorAction SilentlyContinue
  $listening = Test-PortListening
  if ((-not $alive) -and ($listening -ne $true)) { break }
  if (($listening -eq $true) -and ($i -ge 8)) {
    foreach ($c in (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
      Write-Note ('freeing port owner ' + $c.OwningProcess)
      Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  }
}

Start-Sleep -Milliseconds 1500
$env:NODE_OPTIONS = ''
$dir = Split-Path -Parent $AppExe

# Start the app so that it owns NO console. Why WMI first:
#   Start-Process from this helper hands the app the helper's console. Closing that console
#   window then sends CTRL_CLOSE_EVENT to the app and shuts it down too - the exact symptom
#   users report. A WMI-created process is owned by WmiPrvSE and inherits no console, so
#   closing the leftover window cannot touch the app. Start-Process stays as a fallback.
function Start-App {
  $cmd = '"' + $AppExe + '"'
  if ($extra -ne '') { $cmd = $cmd + ' ' + $extra }
  Write-Note ('starting app via WMI: ' + $cmd)
  $ok = $false
  try {
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine      = $cmd
      CurrentDirectory = $dir
    } -ErrorAction Stop
    if ($null -ne $r -and $r.ReturnValue -eq 0) {
      $ok = $true
      Write-Note ('wmi start ok: new pid=' + $r.ProcessId)
    } else {
      Write-Note ('wmi start rejected: returnValue=' + $(if ($null -ne $r) { $r.ReturnValue } else { 'null' }))
    }
  } catch {
    Write-Note ('wmi start threw: ' + $_.Exception.Message)
  }
  if (-not $ok) {
    Write-Note 'fallback: Start-Process with hidden window'
    try {
      if ($extra -ne '') {
        Start-Process -FilePath $AppExe -ArgumentList $extra -WorkingDirectory $dir -WindowStyle Hidden | Out-Null
      } else {
        Start-Process -FilePath $AppExe -WorkingDirectory $dir -WindowStyle Hidden | Out-Null
      }
      Write-Note 'fallback start requested'
    } catch {
      Write-Note ('fallback start failed: ' + $_.Exception.Message)
    }
  }
}

try {
  Start-App
  Write-Note 'app start requested'
} catch {
  Write-Note ('start failed: ' + $_.Exception.Message)
}

# Second chance: if the app never comes back, start it once more before giving up.
$up = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 1000
  if ($port -gt 0) {
    if (Test-PortListening -eq $true) { $up = $true; break }
  } else {
    # No port to watch: treat a live process whose exe matches as "up".
    $p = Get-Process -Name (Split-Path -Leaf $AppExe).Replace('.exe', '') -ErrorAction SilentlyContinue
    if ($null -ne $p) { $up = $true; break }
  }
}
if ($up) {
  Write-Note 'app is up again; done'
} else {
  Write-Note 'app did not come up; retrying once'
  Start-Sleep -Milliseconds 1500
  try {
    Start-App
    Write-Note 'retry requested'
  } catch {
    Write-Note ('retry failed: ' + $_.Exception.Message)
  }
}
