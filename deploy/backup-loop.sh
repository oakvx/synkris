#!/bin/sh
# Local PostgreSQL backups: publish only after dump/list/hash complete.
set -u
umask 077
folder=${SYNK_BACKUP_DIR:-/backups}
interval=${SYNK_BACKUP_INTERVAL_SECONDS:-86400}
once=${SYNK_BACKUP_ONCE:-0}
case "$interval" in ''|*[!0-9]*) echo 'Intervallo backup non valido' >&2; exit 64 ;; esac
if [ "${#interval}" -gt 6 ] || [ "$interval" -lt 60 ] || [ "$interval" -gt 604800 ]; then
  echo 'Intervallo backup fuori limite' >&2; exit 64
fi
case "$once" in 0|1) ;; *) echo 'Modalita backup non valida' >&2; exit 64 ;; esac
mkdir -p "$folder" && chgrp 1000 "$folder" && chmod 0750 "$folder" || exit 1
pending=''
pending_hash=''
cleanup() {
  [ -z "$pending" ] || rm -f -- "$pending"
  [ -z "$pending_hash" ] || rm -f -- "$pending_hash"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
make_backup() {
  name="synk-$(date -u +%Y%m%d-%H%M%S).dump"
  final="$folder/$name"
  if [ -e "$final" ] || [ -e "$final.sha256" ]; then return 1; fi
  pending=$(mktemp "$folder/.synk-pending.XXXXXX") || return 1
  pending_hash="$pending.sha256"
  if ! pg_dump -Fc --file="$pending" || [ ! -s "$pending" ] || ! pg_restore --list "$pending" >/dev/null; then
    cleanup; pending=''; pending_hash=''; return 1
  fi
  digest=$(sha256sum "$pending") || { cleanup; pending=''; pending_hash=''; return 1; }
  digest=${digest%% *}
  printf '%s  %s\n' "$digest" "$name" >"$pending_hash" || return 1
  chgrp 1000 "$pending" "$pending_hash" && chmod 0640 "$pending" "$pending_hash" || return 1
  # No overwrite on collisions. The checksum appears first; readers only list
  # final .dump files, never staging files or a checksum without its dump.
  mv -n "$pending_hash" "$final.sha256" || return 1
  if [ -e "$pending_hash" ]; then return 1; fi
  pending_hash=''
  if ! mv -n "$pending" "$final" || [ -e "$pending" ]; then
    rm -f -- "$final.sha256"
    cleanup; pending=''; return 1
  fi
  pending=''
  echo 'Backup locale PostgreSQL completato e checksum creato; ripristino non certificato'
  pattern='synk-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9].dump'
  if ! find "$folder" -maxdepth 1 -type f -name "$pattern" -mtime +14 -exec sh -c 'for file do rm -f -- "$file" "$file.sha256"; done' sh {} +; then
    echo 'ATTENZIONE: backup riuscito, pulizia dei backup scaduti da verificare' >&2
  fi
  return 0
}
while true; do
  result=0
  make_backup || result=$?
  if [ "$result" -ne 0 ]; then
    cleanup; pending=''; pending_hash=''
    echo 'ERRORE: backup non pubblicato; conservati i backup precedenti' >&2
  fi
  if [ "$once" = 1 ]; then exit "$result"; fi
  sleep "$interval"
done
