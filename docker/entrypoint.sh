#!/bin/sh
# AnimeArr container entrypoint (linuxserver.io conventions):
#   PUID / PGID  run as this user and group (default 1000:1000; Unraid 99:100, Synology 1026:100, TrueNAS 568:568)
#   UMASK        file mode mask for what AnimeArr creates (default 002: folders 775, files 664)
#   TZ           time zone (e.g. Europe/Berlin), used for the calendar and schedules
# Started as root, it fixes /config ownership when needed and drops privileges with su-exec.
# Started with --user (not root), it just runs as that user.
set -e
UMASK="${UMASK:-002}"
umask "$UMASK"
export UMASK
if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  case "$PUID$PGID" in *[!0-9]*) echo "PUID and PGID must be numbers" >&2; exit 1 ;; esac
  [ "$PUID" = "0" ] && echo "Warning: PUID=0 runs AnimeArr as root; use your media user's id instead" >&2
  mkdir -p /config
  # Only the config folder (never the media mounts); only when it isn't already owned by PUID:PGID.
  if [ "$(stat -c %u:%g /config)" != "$PUID:$PGID" ]; then
    echo "Setting the owner of /config to $PUID:$PGID"
    # -h: symlinks themselves, never what they point to.
    chown -R -h "$PUID:$PGID" /config
  fi
  export HOME=/config
  exec su-exec "$PUID:$PGID" "$@"
fi
exec "$@"
