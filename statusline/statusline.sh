#!/usr/bin/env bash
# Claude Code status line for macOS and Linux (the same as statusline.ps1).
# Output: Model | ◕ Ctx 68% | ◔ 5h 18% (2h 14m) | ◑ 7d 42% (4d 6h) | ● Cache 96% (warm · 54m)
# Reads the session JSON from stdin. Missing values show as "--%".
# Needs jq. Works with the bash 3.2 that comes with macOS.

esc=$'\033'
reset="${esc}[0m"
dim="${esc}[90m"

input=$(cat)
if ! command -v jq >/dev/null 2>&1; then
  echo "Claude | status line needs jq (brew install jq, or apt install jq)"
  exit 0
fi

# Pull every value out in one jq call, one per line, in a fixed order.
# A missing value is an empty line, so the lines never shift.
fields=$(printf '%s' "$input" | jq -r '
  def n: if type == "number" then . else "" end;
  [
    (.model.display_name // .model.id // "Claude"),
    (.context_window.used_percentage | n),
    (.rate_limits.five_hour.used_percentage | n),
    (.rate_limits.five_hour.resets_at | n),
    (.rate_limits.seven_day.used_percentage | n),
    (.rate_limits.seven_day.resets_at | n),
    (.prompt_cache.hit_ratio | n),
    (.prompt_cache.warm | if type == "boolean" then tostring else "" end),
    (.context_window.current_usage.cache_read_input_tokens | n),
    (.context_window.current_usage.input_tokens | n),
    (.context_window.current_usage.cache_creation_input_tokens | n),
    (.context_window.current_usage.cache_creation.ephemeral_1h_input_tokens | n),
    (.context_window.current_usage.cache_creation.ephemeral_5m_input_tokens | n),
    (if .rate_limits then "yes" else "" end),
    (.transcript_path // "")
  ] | map(tostring) | .[]' 2>/dev/null)

if [ -z "$fields" ]; then
  echo "Claude | $dim○ Ctx --%$reset | $dim○ 5h --%$reset | $dim○ 7d --%$reset | $dim○ Cache --%$reset"
  exit 0
fi

{
  IFS= read -r model
  IFS= read -r ctx_pct
  IFS= read -r five_pct
  IFS= read -r five_reset
  IFS= read -r seven_pct
  IFS= read -r seven_reset
  IFS= read -r hit_ratio
  IFS= read -r warm
  IFS= read -r cache_read
  IFS= read -r cache_input
  IFS= read -r cache_write
  IFS= read -r eph_1h
  IFS= read -r eph_5m
  IFS= read -r has_limits
  IFS= read -r transcript
} <<EOF
$fields
EOF

# Round a number to a whole percent between 0 and 100.
percent() {
  awk -v v="$1" 'BEGIN { if (v < 0) v = 0; if (v > 100) v = 100; printf "%d", v + 0.5 }'
}

wheel() {
  if   [ "$1" -le 0 ];  then printf '○'
  elif [ "$1" -le 25 ]; then printf '◔'
  elif [ "$1" -le 50 ]; then printf '◑'
  elif [ "$1" -le 85 ]; then printf '◕'
  else printf '●'
  fi
}

# Time until an epoch second: "2h 14m", "4d 6h", "5m" or "now".
remaining() {
  now=$(date +%s)
  secs=$(awk -v a="$1" -v b="$now" 'BEGIN { printf "%d", a - b }')
  if [ "$secs" -le 0 ]; then printf 'now'; return; fi
  d=$((secs / 86400)); h=$((secs % 86400 / 3600)); m=$((secs % 3600 / 60))
  if   [ "$d" -ge 1 ]; then printf '%dd %dh' "$d" "$h"
  elif [ "$h" -ge 1 ]; then printf '%dh %dm' "$h" "$m"
  else printf '%dm' "$m"
  fi
}

# A usage gauge: green under 50%, yellow 50-79%, red 80% and up.
gauge() {
  label=$1; raw=$2; resets=$3
  if [ -z "$raw" ]; then printf '%s○ %s --%%%s' "$dim" "$label" "$reset"; return; fi
  pct=$(percent "$raw")
  if   [ "$pct" -lt 50 ]; then color=32
  elif [ "$pct" -lt 80 ]; then color=33
  else color=31
  fi
  extra=''
  if [ -n "$resets" ]; then extra=" ($(remaining "$resets"))"; fi
  printf '%s[%sm%s%s %s %s[%sm%s%%%s%s' "$esc" "$color" "$(wheel "$pct")" "$reset" "$label" "$esc" "$color" "$pct" "$reset" "$extra"
}

# When a file was last changed, in epoch seconds (GNU stat on Linux, BSD stat on macOS).
mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null
}

# Prompt cache: hit rate and warm/cold, with a countdown while warm.
# Uses prompt_cache.hit_ratio (0-1) and prompt_cache.warm when Claude Code
# sends them; otherwise works it out from context_window.current_usage:
#   cache_read / (cache_read + input + cache_creation)
# and calls the cache warm while the transcript was written less than the
# cache lifetime ago. Lifetime: 1 hour if the last reply wrote 1-hour entries,
# 5 minutes if it wrote 5-minute ones; otherwise 1 hour on a Claude
# subscription (Claude Code only sends rate_limits then), 5 minutes with an
# API key. Colors are inverted, since a high hit rate is good:
#   green 80%+ and warm, yellow 50-79%, red under 50% or cold.
cache_gauge() {
  pct=''
  if [ -n "$hit_ratio" ]; then
    pct=$(percent "$(awk -v r="$hit_ratio" 'BEGIN { print r * 100 }')")
  elif [ -n "$cache_read$cache_input$cache_write" ]; then
    pct=$(awk -v r="${cache_read:-0}" -v i="${cache_input:-0}" -v w="${cache_write:-0}" \
      'BEGIN { t = r + i + w; if (t > 0) printf "%d", r / t * 100 + 0.5 }')
  fi
  if [ -z "$pct" ]; then printf '%s○ Cache --%%%s' "$dim" "$reset"; return; fi

  left=''
  if [ -n "$transcript" ] && [ -f "$transcript" ]; then
    ttl=300
    if awk -v x="${eph_1h:-0}" 'BEGIN { exit !(x > 0) }'; then ttl=3600
    elif awk -v x="${eph_5m:-0}" 'BEGIN { exit !(x > 0) }'; then ttl=300
    elif [ -n "$has_limits" ]; then ttl=3600
    fi
    changed=$(mtime "$transcript")
    if [ -n "$changed" ]; then left=$((ttl - ($(date +%s) - changed))); fi
  fi

  is_warm=$warm
  if [ -z "$is_warm" ]; then
    if [ -n "$left" ] && [ "$left" -le 0 ]; then is_warm=false; else is_warm=true; fi
  fi

  if [ "$is_warm" != true ] || [ "$pct" -lt 50 ]; then color=31
  elif [ "$pct" -lt 80 ]; then color=33
  else color=32
  fi

  if [ "$is_warm" != true ]; then tag='cold'
  elif [ -n "$left" ] && [ "$left" -gt 0 ]; then tag="warm · $(( (left + 59) / 60 ))m"
  else tag='warm'
  fi

  printf '%s[%sm%s%s Cache %s[%sm%s%%%s (%s)' "$esc" "$color" "$(wheel "$pct")" "$reset" "$esc" "$color" "$pct" "$reset" "$tag"
}

printf '%s | %s | %s | %s | %s\n' \
  "$model" \
  "$(gauge Ctx "$ctx_pct" '')" \
  "$(gauge 5h "$five_pct" "$five_reset")" \
  "$(gauge 7d "$seven_pct" "$seven_reset")" \
  "$(cache_gauge)"
