# Claude Code status line
# Output: Model | wheel Ctx 68% | wheel 5h 18% (2h 14m) | wheel 7d 42% (4d 6h)
# Reads the session JSON from stdin. Missing values show as "--%".

$ErrorActionPreference = 'SilentlyContinue'
try {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [Console]::InputEncoding  = $utf8
    [Console]::OutputEncoding = $utf8
} catch {}

$esc   = [char]27
$reset = "$esc[0m"
$dim   = "$esc[90m"

# Pie wheels, written as code points so this file stays plain ASCII
$wheelEmpty = [string][char]0x25CB   # o  0%
$wheelQ1    = [string][char]0x25D4   # 1-25%
$wheelHalf  = [string][char]0x25D1   # 26-50%
$wheelQ3    = [string][char]0x25D5   # 51-85%
$wheelFull  = [string][char]0x25CF   # 86-100%

$raw = ''
try { $raw = [Console]::In.ReadToEnd() } catch {}
# Strip a leading byte-order mark (U+FEFF) if the pipe adds one, then trim whitespace
$raw = $raw.TrimStart([char]0xFEFF).Trim()
$data = $null
try { if ($raw) { $data = $raw | ConvertFrom-Json } } catch {}

function Get-Prop($obj, [string[]]$path) {
    foreach ($name in $path) {
        if ($null -eq $obj) { return $null }
        $obj = $obj.$name
    }
    return $obj
}

function Format-Remaining([double]$epoch) {
    $secs = [math]::Floor($epoch - [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
    if ($secs -le 0) { return 'now' }
    $days  = [math]::Floor($secs / 86400)
    $hours = [math]::Floor(($secs % 86400) / 3600)
    $mins  = [math]::Floor(($secs % 3600) / 60)
    if ($days -ge 1)  { return "$($days)d $($hours)h" }
    if ($hours -ge 1) { return "$($hours)h $($mins)m" }
    return "$($mins)m"
}

function Format-Gauge([string]$label, $rawPct, $resetsAt) {
    if ($null -eq $rawPct) {
        return "$dim$wheelEmpty $label --%$reset"
    }
    $value = $rawPct -as [double]
    if ($null -eq $value) {
        return "$dim$wheelEmpty $label --%$reset"
    }

    $pct = [int][math]::Floor([math]::Min(100, [math]::Max(0, $value)) + 0.5)

    if     ($pct -eq 0)  { $wheel = $wheelEmpty }
    elseif ($pct -le 25) { $wheel = $wheelQ1 }
    elseif ($pct -le 50) { $wheel = $wheelHalf }
    elseif ($pct -le 85) { $wheel = $wheelQ3 }
    else                 { $wheel = $wheelFull }

    if     ($pct -lt 50) { $color = '32' }   # green
    elseif ($pct -lt 80) { $color = '33' }   # yellow
    else                 { $color = '31' }   # red

    $resetText = ''
    if ($null -ne $resetsAt) {
        $epoch = $resetsAt -as [double]
        if ($null -ne $epoch) { $resetText = ' (' + (Format-Remaining $epoch) + ')' }
    }

    return "$esc[$($color)m$wheel$reset $label $esc[$($color)m$pct%$reset$resetText"
}

$model = Get-Prop $data @('model', 'display_name')
if (-not $model) { $model = Get-Prop $data @('model', 'id') }
if (-not $model) { $model = 'Claude' }

$ctx   = Format-Gauge 'Ctx' (Get-Prop $data @('context_window', 'used_percentage')) $null
$five  = Format-Gauge '5h'  (Get-Prop $data @('rate_limits', 'five_hour', 'used_percentage')) (Get-Prop $data @('rate_limits', 'five_hour', 'resets_at'))
$seven = Format-Gauge '7d'  (Get-Prop $data @('rate_limits', 'seven_day', 'used_percentage')) (Get-Prop $data @('rate_limits', 'seven_day', 'resets_at'))

Write-Output "$model | $ctx | $five | $seven"
