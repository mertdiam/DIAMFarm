#!/bin/sh
# Runtime entrypoint for the production image.
#
# The container starts as root only to fix one thing: the persistent volumes
# mounted at server/data (farm.db + backups) and server/gcode (uploads) may
# already hold root-owned files from an earlier root-run image, so a plain
# USER switch in the Dockerfile would make the app EACCES on the first write
# (and, because /api/health touches no disk, it would pass the health check
# and only fail later on a backup or dispatch). We chown the volumes to the
# unprivileged runtime user, then drop privileges and exec the real command.
#
# When the platform already starts us as non-root, the chown/drop is skipped
# and we exec directly.
set -e

if [ "$(id -u)" = "0" ]; then
  chown -R farmapp:farmapp server/data server/gcode 2>/dev/null || true
  exec gosu farmapp "$@"
fi

exec "$@"
