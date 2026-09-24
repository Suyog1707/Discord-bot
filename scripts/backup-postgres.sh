#!/usr/bin/env bash
# Stream a custom-format, public-schema data dump to the PC. The remote mode
# pulls over Tailscale SSH after the database moves to the VPS.
set -euo pipefail
umask 077

backup_dir=${MUSIC_BACKUP_DIR:?Set MUSIC_BACKUP_DIR to an absolute private PC directory}
backup_source=${MUSIC_BACKUP_SOURCE:-local}

case "$backup_dir" in
  /*) ;;
  *) echo 'MUSIC_BACKUP_DIR must be absolute' >&2; exit 2 ;;
esac
case "$backup_source" in
  local|remote) ;;
  *) echo 'MUSIC_BACKUP_SOURCE must be local or remote' >&2; exit 2 ;;
esac

install -d -m 700 -- "$backup_dir"
temporary_dump=$(mktemp --tmpdir="$backup_dir" '.postgres-XXXXXXXX.dump')
cleanup() { rm -f -- "$temporary_dump"; }
trap cleanup EXIT

if [[ $backup_source == local ]]; then
  repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
  docker compose --env-file "$repository_root/.env" \
    -f "$repository_root/docker/docker-compose.yml" exec -T postgres \
    sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      --format=custom --schema=public --data-only --no-owner --no-acl' \
    > "$temporary_dump"
else
  ssh_target=${MUSIC_BACKUP_SSH_TARGET:?Set MUSIC_BACKUP_SSH_TARGET to user@VPS-Tailscale-host}
  ssh_port=${MUSIC_BACKUP_SSH_PORT:-22}
  if [[ ! $ssh_target =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$ ]] ||
     [[ ! $ssh_port =~ ^[0-9]{1,5}$ ]] || (( ssh_port < 1 || ssh_port > 65535 )); then
    echo 'Invalid backup SSH target or port' >&2
    exit 2
  fi
  ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -T -p "$ssh_port" \
    "$ssh_target" 'docker exec -i discord-music-postgres-1 sh -s' \
    > "$temporary_dump" <<'REMOTE_SCRIPT'
set -eu
exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --format=custom --schema=public --data-only --no-owner --no-acl
REMOTE_SCRIPT
fi

# pg_restore checks the archive format and TOC before anything is retained.
# It reads from stdin, so the private dump is never mounted into a container.
docker run --rm -i postgres:17-alpine pg_restore --list \
  < "$temporary_dump" > /dev/null
if [[ ! -s $temporary_dump ]]; then
  echo 'Database dump is empty' >&2
  exit 1
fi

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
suffix=${temporary_dump##*.postgres-}
suffix=${suffix%.dump}
finished_dump="$backup_dir/postgres-public-$timestamp-$suffix.dump"
mv -- "$temporary_dump" "$finished_dump"
trap - EXIT
sha256sum -- "$finished_dump" > "$finished_dump.sha256"
chmod 600 -- "$finished_dump" "$finished_dump.sha256"
echo "Verified database backup: $finished_dump"
