#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

sleep_forever() {
  while :; do
    sleep 86400
  done
}

idle_or_exit() {
  # The Compose service should stay healthy and quiet when disabled, but tests and
  # manual probes need a way to verify config paths without leaving a sleeper behind.
  if [ "${DB_BACKUP_RUN_ONCE:-false}" = "true" ]; then
    exit 0
  fi
  sleep_forever
}

require_var() {
  name="$1"
  value="${!name:-}"
  if [ -z "$value" ]; then
    log "missing required environment variable: $name"
    exit 1
  fi
}

if [ "${DB_BACKUPS_ENABLED:-false}" != "true" ]; then
  log "database backups disabled; set DB_BACKUPS_ENABLED=true to enable"
  idle_or_exit
fi

if [ "${NODE_ENV:-production}" = "development" ]; then
  log "database backups disabled in development"
  idle_or_exit
fi

require_var DATABASE_URL
require_var DB_BACKUP_S3_BUCKET
require_var AWS_ACCESS_KEY_ID
require_var AWS_SECRET_ACCESS_KEY
require_var AWS_DEFAULT_REGION
require_var DB_BACKUP_ENCRYPTION_PASSPHRASE

DB_BACKUP_S3_PREFIX="${DB_BACKUP_S3_PREFIX:-backups/postgres}"
DB_BACKUP_RETENTION_DAYS="${DB_BACKUP_RETENTION_DAYS:-14}"
DB_BACKUP_TIMES_UTC="${DB_BACKUP_TIMES_UTC:-00:15,12:15,16:45}"
AWS_ENDPOINT_ARGS=()

if [ -n "${DB_BACKUP_S3_ENDPOINT:-}" ]; then
  AWS_ENDPOINT_ARGS=(--endpoint-url "$DB_BACKUP_S3_ENDPOINT")
fi

validate_time() {
  if [[ ! "$1" =~ ^[0-9]{2}:[0-9]{2}$ ]]; then
    log "invalid DB_BACKUP_TIMES_UTC entry: $1"
    exit 1
  fi

  hour="${1%%:*}"
  minute="${1##*:}"
  if [ "$hour" -gt 23 ] || [ "$minute" -gt 59 ]; then
    log "invalid DB_BACKUP_TIMES_UTC entry: $1"
    exit 1
  fi
}

seconds_until_next_run() {
  now_epoch="$(date -u '+%s')"
  today="$(date -u '+%Y-%m-%d')"
  tomorrow="$(date -u -d 'tomorrow' '+%Y-%m-%d')"
  best=""

  IFS="," read -ra run_times <<< "$DB_BACKUP_TIMES_UTC"
  for run_time in "${run_times[@]}"; do
    run_time="${run_time//[[:space:]]/}"
    validate_time "$run_time"

    candidate="$(date -u -d "$today $run_time:00 UTC" '+%s')"
    if [ "$candidate" -le "$now_epoch" ]; then
      candidate="$(date -u -d "$tomorrow $run_time:00 UTC" '+%s')"
    fi

    if [ -z "$best" ] || [ "$candidate" -lt "$best" ]; then
      best="$candidate"
    fi
  done

  printf '%s\n' "$((best - now_epoch))"
}

run_backup() {
  timestamp="$(date -u '+%Y-%m-%d-%H%M')"
  object_key="${DB_BACKUP_S3_PREFIX%/}/kanera-${timestamp}.sql.gz.gpg"
  tmp_dir="$(mktemp -d)"
  dump_path="$tmp_dir/kanera-${timestamp}.sql.gz.gpg"

  cleanup() {
    rm -rf "$tmp_dir"
  }
  trap cleanup RETURN

  log "starting full postgres backup: s3://${DB_BACKUP_S3_BUCKET}/${object_key}"
  # This is intentionally a full logical dump every run, not an incremental backup.
  # Compression happens before encryption so S3 only ever receives encrypted bytes;
  # level 6 keeps CPU pressure lower than max compression during live usage.
  if ! pg_dump "$DATABASE_URL" \
    --no-owner \
    --no-acl \
    | gzip -6 \
    | gpg \
      --batch \
      --yes \
      --pinentry-mode loopback \
      --passphrase-fd 3 \
      --symmetric \
      --cipher-algo AES256 \
      --output "$dump_path" \
      3<<< "$DB_BACKUP_ENCRYPTION_PASSPHRASE"; then
    log "failed to create full encrypted postgres backup"
    return 1
  fi

  if ! aws "${AWS_ENDPOINT_ARGS[@]}" s3 cp "$dump_path" "s3://${DB_BACKUP_S3_BUCKET}/${object_key}" \
    --only-show-errors \
    --metadata "kanera-backup-type=full,kanera-backup-compression=gzip,kanera-backup-encryption=gpg-symmetric-aes256"; then
    log "failed to upload full postgres backup: s3://${DB_BACKUP_S3_BUCKET}/${object_key}"
    return 1
  fi

  log "uploaded full postgres backup: s3://${DB_BACKUP_S3_BUCKET}/${object_key}"
  # Retention runs only after the current upload succeeds, so a transient backup
  # failure cannot reduce the set of recoverable backups.
  if ! prune_old_backups; then
    log "uploaded current backup, but retention prune failed"
    return 1
  fi
}

prune_old_backups() {
  cutoff="$(date -u -d "${DB_BACKUP_RETENTION_DAYS} days ago" '+%Y-%m-%dT%H:%M:%SZ')"
  prefix="${DB_BACKUP_S3_PREFIX%/}/"

  log "pruning backups older than ${DB_BACKUP_RETENTION_DAYS} days under s3://${DB_BACKUP_S3_BUCKET}/${prefix}"
  if ! keys="$(aws "${AWS_ENDPOINT_ARGS[@]}" s3api list-objects-v2 \
    --bucket "$DB_BACKUP_S3_BUCKET" \
    --prefix "$prefix" \
    --query "Contents[?LastModified<='${cutoff}'].Key" \
    --output text)"; then
    log "failed to list old postgres backups for retention prune"
    return 1
  fi

  if [ -z "$keys" ] || [ "$keys" = "None" ]; then
    log "no old postgres backups to prune"
    return
  fi

  for key in $keys; do
    case "$key" in
      "$prefix"*.sql.gz.gpg)
        if ! aws "${AWS_ENDPOINT_ARGS[@]}" s3 rm "s3://${DB_BACKUP_S3_BUCKET}/${key}" --only-show-errors; then
          log "failed to prune old postgres backup: s3://${DB_BACKUP_S3_BUCKET}/${key}"
          return 1
        fi
        log "pruned old postgres backup: s3://${DB_BACKUP_S3_BUCKET}/${key}"
        ;;
      *)
        log "skipping non-matching object during prune: s3://${DB_BACKUP_S3_BUCKET}/${key}"
        ;;
    esac
  done
}

log "database backup scheduler enabled; full backups run at ${DB_BACKUP_TIMES_UTC} UTC"
# One-shot mode is for deploy smoke tests and manual backup runs; the Compose
# service omits it so the scheduler keeps running for the lifetime of the container.
if [ "${DB_BACKUP_RUN_ONCE:-false}" = "true" ]; then
  run_backup
  exit $?
fi

while :; do
  delay="$(seconds_until_next_run)"
  log "next full postgres backup in ${delay}s"
  sleep "$delay"
  if ! run_backup; then
    log "full postgres backup failed"
  fi
done
