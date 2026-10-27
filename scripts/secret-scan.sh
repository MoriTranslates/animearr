#!/usr/bin/env bash
# Pre-commit secret scan: run before every commit. Fails on staged .devconfig/key files, on long hex/alnum
# key-like strings, on apikey/api_key/token assignments with literal values, and (optionally) on the real key values
# found in KEYDIR (compared without printing them).
set -u
fail=0
staged=$(git diff --cached --name-only --diff-filter=ACMR)
if echo "$staged" | grep -Eq '(^|/)\.devconfig|\.db$|\.key$|(^|/)\.(sab|radarr|prowlarr)$|-key$'; then
  echo "BLOCKED: staged files include a .devconfig folder, database or key file:"; echo "$staged" | grep -E '(^|/)\.devconfig|\.db$|\.key$|-key$'; fail=1
fi
for f in $staged; do
  [ -f "$f" ] || continue
  case "$f" in package-lock.json|*.png|*.svg|test/fixtures/*.xml) continue ;; esac
  if git show ":$f" | grep -nE '\b[0-9a-f]{32,}\b' | grep -vE 'sha512-|integrity' >/dev/null; then
    echo "SUSPICIOUS (32+ hex chars) in $f:"; git show ":$f" | grep -nE '\b[0-9a-f]{32,}\b' | grep -vE 'sha512-|integrity' | cut -c1-120; fail=1
  fi
  if git show ":$f" | grep -niE '(api_?key|apikey|token|password|secret)["'"'"' ]*[:=] *["'"'"'][A-Za-z0-9+/_-]{16,}["'"'"']' >/dev/null; then
    echo "SUSPICIOUS (literal credential) in $f:"; git show ":$f" | grep -niE '(api_?key|apikey|token|password|secret)["'"'"' ]*[:=] *["'"'"'][A-Za-z0-9+/_-]{16,}["'"'"']' | cut -c1-120; fail=1
  fi
done
if [ -n "${KEYDIR:-}" ]; then
  keys=$( { cat "$KEYDIR/.sonarr-key" "$KEYDIR/.prowlarr-key"; sed -n 2p "$KEYDIR/.radarr"; sed -n 's/.*api_key = //p' "$KEYDIR/.sab"; } 2>/dev/null | tr -d '\r' | grep -E '.{16,}')
  for f in $staged; do
    [ -f "$f" ] || continue
    while IFS= read -r k; do
      [ -n "$k" ] && git show ":$f" | grep -qF "$k" && { echo "BLOCKED: a real service key is in $f"; fail=1; }
    done <<< "$keys"
  done
fi
# Personal data: added lines must not carry the owner's network/host/identity details. The patterns live in
# local/pii-patterns.txt (gitignored: one extended regex per line), plus generic ones: real-looking private IPs
# (anything but the 192.168.1.x / 10.0.0.x documentation examples), Unraid share paths, and e-mail addresses
# that aren't GitHub noreply ones.
pii="local/pii-patterns.txt"
generic='(192\.168\.([02-9]|[1-9][0-9]+)\.[0-9]+)|(/mnt/user/[A-Za-z])|([A-Za-z0-9._%+-]+@(gmail|outlook|hotmail|yahoo|proton)\.[a-z]+)'
for f in $staged; do
  [ -f "$f" ] || continue
  case "$f" in package-lock.json|*.png|*.jpg|*.webp|scripts/secret-scan.sh) continue ;; esac
  # Unraid templates use Unraid's standard share paths (/mnt/user/appdata, /mnt/user/data): generic, not personal.
  generic_f="$generic"
  case "$f" in docker/unraid/*) generic_f='(192\.168\.([02-9]|[1-9][0-9]+)\.[0-9]+)|([A-Za-z0-9._%+-]+@(gmail|outlook|hotmail|yahoo|proton)\.[a-z]+)' ;; esac
  added=$(git diff --cached -U0 -- "$f" | grep -E '^\+[^+]' || true)
  [ -n "$added" ] || continue
  if echo "$added" | grep -nE "$generic_f" >/dev/null; then
    echo "PERSONAL DATA? (private IP / share path / e-mail) in $f:"; echo "$added" | grep -nE "$generic_f" | cut -c1-120; fail=1
  fi
  if [ -f "$pii" ] && echo "$added" | grep -niEf "$pii" >/dev/null; then
    echo "PERSONAL DATA (local/pii-patterns.txt) in $f:"; echo "$added" | grep -niEf "$pii" | cut -c1-120; fail=1
  fi
done
[ $fail -eq 0 ] && echo "secret scan: clean ($(echo "$staged" | grep -c .) staged files)"
exit $fail
