# PostgreSQL backups and restore drill

`scripts/backup-postgres.sh` streams a custom-format, data-only dump of the
application's `public` schema to a private directory **on the PC**, outside
Git. The script verifies the archive before retaining it and writes a SHA-256
checksum. `scripts/check-backups.sh` fails if the latest dump is missing,
corrupt, or older than 36 hours; it warns about files older than 30 days but
does not delete them automatically. Redis presence, claims, and command queues
are deliberately **not** backed up or replayed.

The first PC backup and restore drill succeeded: a disposable PostgreSQL 17
container received all 17 Prisma migrations and the backup; it matched 713
history rows, 71 favorites, seven player records, 17 migration records, and a
three-row history checksum. The disposable container was removed afterward.

## Schedule on the PC

The user timer in `ops/systemd/user` runs daily around 02:30 and catches up
after a missed run when the PC comes back online (`Persistent=true`). The PC
must be on and able to reach the source; a powered-off PC cannot capture new
VPS writes. Use a second independent backup destination if your recovery
point objective requires more than this.

1. Copy `ops/systemd/backup.env.example` to
   `~/.config/discord-music/backup.env`, edit `MUSIC_BACKUP_DIR` to a private
   directory outside the repository, and set mode 0600. The example has no
   secrets, but the working file may later identify your VPS.
2. The units assume this repository is at `~/Projects/Discord-Bot`. If it is
   elsewhere, update both `ExecStart` paths in the service before linking.
3. Link the service and timer into the user systemd manager, then enable and
   test them:

   ```sh
   systemctl --user link "$PWD/ops/systemd/user/discord-music-backup.service"
   systemctl --user link "$PWD/ops/systemd/user/discord-music-backup.timer"
   systemctl --user daemon-reload
   systemctl --user enable --now discord-music-backup.timer
   systemctl --user start discord-music-backup.service
   systemctl --user status discord-music-backup.service
   systemctl --user list-timers discord-music-backup.timer
   ```

   If backups must run while you are logged out but the PC stays on, enable
   user lingering (`sudo loginctl enable-linger "$USER"`). Do this only after
   the first manual run succeeds. This Codex workspace has no user systemd
   bus, so timer activation must happen in the actual PC login session.

## Switch the source after VPS cutover

Set `MUSIC_BACKUP_SOURCE=remote` and
`MUSIC_BACKUP_SSH_TARGET=deploy@VPS-TAILSCALE-HOST` in the PC's private
`backup.env`. Use SSH keys with the VPS host key pinned in `known_hosts`;
the script requires batch mode and strict host-key checking. The VPS deploy
account must be able to run Docker (which is root-equivalent). The remote
PostgreSQL container must retain the Compose name
`discord-music-postgres-1`. Run the service manually again and confirm the
fresh dump appears on the PC before relying on the timer. No database, Redis,
Lavalink, or backup transfer port needs to be opened publicly; SSH runs over
Tailscale.

## Restore procedure

Keep at least two recent verified PC dumps plus the final pre-VPS-cutover
dump. Do not delete the Supabase export until the VPS is stable. For a real
restore, use a new empty PostgreSQL 17 database, apply committed Prisma
migrations, then restore the **data-only** dump with `pg_restore --data-only
--disable-triggers --single-transaction --exit-on-error --no-owner --no-acl`.
Clear the destination's duplicate `_prisma_migrations` rows before restoring
as shown in [VPS_CUTOVER.md](VPS_CUTOVER.md). Compare exact counts and sample
checksums before starting bots. Never restore directly into a live database
that still accepts writes.

Review old backups after confirming a second copy exists. The checker warns
about retention; it never deletes files automatically, so accidental cleanup
cannot silently erase the only viable restore point.
