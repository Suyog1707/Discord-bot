#!/usr/bin/env bash
# Fail if the newest off-VPS PostgreSQL backup is stale or corrupt.
set -euo pipefail

backup_dir=${MUSIC_BACKUP_DIR:?Set MUSIC_BACKUP_DIR to the private PC backup directory}
max_age_hours=${MUSIC_BACKUP_MAX_AGE_HOURS:-36}
retention_days=${MUSIC_BACKUP_RETENTION_DAYS:-30}
if [[ ! $max_age_hours =~ ^[0-9]+$ ]] || [[ ! $retention_days =~ ^[0-9]+$ ]]; then
  echo 'Backup age and retention must be whole numbers' >&2
  exit 2
fi
if [[ ! -d $backup_dir ]]; then
  echo 'Backup directory does not exist' >&2
  exit 1
fi

shopt -s nullglob
dumps=("$backup_dir"/postgres-public-*.dump)
if (( ${#dumps[@]} == 0 )); then
  echo 'No PostgreSQL backups found' >&2
  exit 1
fi
latest=${dumps[0]}
for dump in "${dumps[@]}"; do
  if [[ $dump -nt $latest ]]; then latest=$dump; fi
done

now=$(date +%s)
modified=$(stat -c %Y -- "$latest")
age_hours=$(( (now - modified) / 3600 ))
if (( age_hours > max_age_hours )); then
  echo "Newest PostgreSQL backup is $age_hours hours old (limit $max_age_hours)" >&2
  exit 1
fi
if [[ ! -f $latest.sha256 ]]; then
  echo 'Newest PostgreSQL backup has no checksum file' >&2
  exit 1
fi
sha256sum --check --status -- "$latest.sha256"
docker run --rm -i postgres:17-alpine pg_restore --list \
  < "$latest" > /dev/null

old_count=0
for dump in "${dumps[@]}"; do
  if (( now - $(stat -c %Y -- "$dump") > retention_days * 86400 )); then
    old_count=$((old_count + 1))
  fi
done
if (( old_count > 0 )); then
  echo "Warning: $old_count backups exceed $retention_days days; review retention after confirming secondary copies" >&2
fi
echo "Backup healthy: $latest ($age_hours hours old; ${#dumps[@]} retained)"
