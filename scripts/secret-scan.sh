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
[ $fail -eq 0 ] && echo "secret scan: clean ($(echo "$staged" | grep -c .) staged files)"
exit $fail
