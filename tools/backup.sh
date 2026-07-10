#!/usr/bin/env bash
# Cygnus Jewel Suite — automated PostgreSQL backup with rotation.
# Place in: /opt/cygnus/backup.sh (or tools/backup.sh in the repo)
# Schedule: daily via cron or systemd timer.
#
# Usage:
#   PGPASSWORD=xxx ./backup.sh              # uses defaults
#   DB_NAME=cygnus DB_PORT=5433 BACKUP_DIR=/mnt/backup KEEP_DAYS=30 ./backup.sh
#
# What it does:
#   1. pg_dump → compressed .sql.gz with timestamp.
#   2. Removes backups older than KEEP_DAYS.
#   3. Logs success/failure to syslog (logger) and stdout.
#
# Recommended cron (daily at 2 AM):
#   0 2 * * * /opt/cygnus/backup.sh >> /var/log/cygnus-backup.log 2>&1

set -euo pipefail

# --- Configuration (override via environment) ---
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5433}"
DB_NAME="${DB_NAME:-cygnus}"
DB_USER="${DB_USER:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/cygnus-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"          # rotate: keep last N days
PG_DUMP="${PG_DUMP:-pg_dump}"         # path to pg_dump if not in PATH

# --- Execution ---
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILENAME="cygnus_${TIMESTAMP}.sql.gz"
FILEPATH="${BACKUP_DIR}/${FILENAME}"

mkdir -p "${BACKUP_DIR}"

echo "[$(date)] Starting backup → ${FILEPATH}"

if ${PG_DUMP} -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" --no-owner --no-acl | gzip > "${FILEPATH}"; then
    SIZE=$(du -h "${FILEPATH}" | cut -f1)
    echo "[$(date)] ✓ Backup complete: ${FILENAME} (${SIZE})"
    logger -t cygnus-backup "OK: ${FILENAME} (${SIZE})"
else
    echo "[$(date)] ✗ Backup FAILED"
    logger -t cygnus-backup "FAILED: ${DB_NAME}"
    exit 1
fi

# --- Rotation: remove backups older than KEEP_DAYS ---
DELETED=$(find "${BACKUP_DIR}" -name "cygnus_*.sql.gz" -mtime "+${KEEP_DAYS}" -delete -print | wc -l)
if [ "${DELETED}" -gt 0 ]; then
    echo "[$(date)] Rotated ${DELETED} old backup(s) (older than ${KEEP_DAYS} days)"
fi

echo "[$(date)] Done. Backups in ${BACKUP_DIR}: $(ls "${BACKUP_DIR}"/cygnus_*.sql.gz 2>/dev/null | wc -l) file(s)"
