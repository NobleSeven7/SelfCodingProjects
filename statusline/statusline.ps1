# Claude Code status line
# Output: Model | wheel Ctx 68% | wheel 5h 18% (2h 14m) | wheel 7d 42% (4d 6h) | wheel Cache 96% (warm - 54m)
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

    $pct = [int][math]::Floor([math]::Min([double]100.0, [math]::Max([double]0.0, $value)) + 0.5)

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

# Prompt cache: hit rate and warm/cold. Uses prompt_cache.hit_ratio (0-1) and
# prompt_cache.warm when Claude Code sends them; otherwise works it out from
# context_window.current_usage:
#   cache_read / (cache_read + input + cache_creation)
# and calls the cache warm while the transcript was written less than the
# cache lifetime ago. While warm it counts down to when it goes cold, like
# "(warm - 54m)" (with a middle dot), rounded up so it never reads 0m.
# Lifetime: 1 hour if the last reply wrote 1-hour entries, 5 minutes if it
# wrote 5-minute ones; otherwise 1 hour on a Claude subscription (Claude Code
# only sends rate_limits then) and 5 minutes with an API key.
# Colors are inverted, since a high hit rate is good:
#   green 80%+ and warm, yellow 50-79%, red under 50% or cold.
function Get-CacheTtl($data, $usage) {
    $oneHour  = (Get-Prop $usage @('cache_creation', 'ephemeral_1h_input_tokens')) -as [double]
    $fiveMin  = (Get-Prop $usage @('cache_creation', 'ephemeral_5m_input_tokens')) -as [double]
    if ($oneHour -gt 0) { return 3600 }
    if ($fiveMin -gt 0) { return 300 }
    if ($null -ne (Get-Prop $data @('rate_limits'))) { return 3600 }
    return 300
}

function Format-Cache($data) {
    $ratio = Get-Prop $data @('prompt_cache', 'hit_ratio')
    $warm  = Get-Prop $data @('prompt_cache', 'warm')
    $pct = $null

    # Seconds until the cache goes cold: the cache lifetime minus how long ago
    # the transcript was last written. Unknown without a transcript.
    $left = $null
    $transcript = Get-Prop $data @('transcript_path')
    if ($transcript -and (Test-Path -LiteralPath $transcript)) {
        $ttlSecs = Get-CacheTtl $data (Get-Prop $data @('context_window', 'current_usage'))
        $age = ((Get-Date) - (Get-Item -LiteralPath $transcript).LastWriteTime).TotalSeconds
        $left = $ttlSecs - $age
    }

    if ($null -ne $ratio -and $null -ne ($ratio -as [double])) {
        $pct = [int][math]::Floor([math]::Min([double]1.0, [math]::Max([double]0.0, ($ratio -as [double]))) * 100 + 0.5)
    } else {
        $usage = Get-Prop $data @('context_window', 'current_usage')
        if ($null -ne $usage) {
            $read  = (Get-Prop $usage @('cache_read_input_tokens')) -as [double]
            $input = (Get-Prop $usage @('input_tokens')) -as [double]
            $write = (Get-Prop $usage @('cache_creation_input_tokens')) -as [double]
            if ($null -eq $read)  { $read = 0 }
            if ($null -eq $input) { $input = 0 }
            if ($null -eq $write) { $write = 0 }
            $total = $read + $input + $write
            if ($total -gt 0) { $pct = [int][math]::Floor($read / $total * 100 + 0.5) }

            if ($null -eq $warm) {
                if ($null -ne $left) {
                    $warm = $left -gt 0
                } else {
                    $warm = $true
                }
            }
        }
    }

    if ($null -eq $pct) { return "$dim$wheelEmpty Cache --%$reset" }
    $isWarm = [bool]$warm

    if     ($pct -eq 0)  { $wheel = $wheelEmpty }
    elseif ($pct -le 25) { $wheel = $wheelQ1 }
    elseif ($pct -le 50) { $wheel = $wheelHalf }
    elseif ($pct -le 85) { $wheel = $wheelQ3 }
    else                 { $wheel = $wheelFull }

    if     (-not $isWarm -or $pct -lt 50) { $color = '31' }   # red
    elseif ($pct -lt 80)                  { $color = '33' }   # yellow
    else                                  { $color = '32' }   # green

    $mdot = [string][char]0x00B7   # middle dot
    if (-not $isWarm) {
        $tag = 'cold'
    } elseif ($null -ne $left -and $left -gt 0) {
        $tag = "warm $mdot $([int][math]::Ceiling($left / 60))m"
    } else {
        $tag = 'warm'
    }
    return "$esc[$($color)m$wheel$reset Cache $esc[$($color)m$pct%$reset ($tag)"
}

$model = Get-Prop $data @('model', 'display_name')
if (-not $model) { $model = Get-Prop $data @('model', 'id') }
if (-not $model) { $model = 'Claude' }

$ctx   = Format-Gauge 'Ctx' (Get-Prop $data @('context_window', 'used_percentage')) $null
$five  = Format-Gauge '5h'  (Get-Prop $data @('rate_limits', 'five_hour', 'used_percentage')) (Get-Prop $data @('rate_limits', 'five_hour', 'resets_at'))
$seven = Format-Gauge '7d'  (Get-Prop $data @('rate_limits', 'seven_day', 'used_percentage')) (Get-Prop $data @('rate_limits', 'seven_day', 'resets_at'))

$cache = Format-Cache $data

Write-Output "$model | $ctx | $five | $seven | $cache"
