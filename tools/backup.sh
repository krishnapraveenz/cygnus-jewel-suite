#!/usr/bin/env bash
# Cygnus Jewel Suite — automated backup in .cjs format (integrity-checked).
# Produces a .cjs file: magic header + JSON metadata (SHA-256 checksum) + gzip payload.
# Schedule: daily via cron or systemd timer.
#
# Usage:
#   ./backup.sh                            # uses defaults
#   DB_NAME=cygnus BACKUP_DIR=/mnt/backup KEEP_DAYS=30 ./backup.sh
#
# Restore:
#   Use the Settings → Backup & Restore UI, or POST /restore with the .cjs file.
#   Manual: see docs/03-delivery/backup-restore.md.
#
# Cron (daily at 2 AM):
#   0 2 * * * /opt/cygnus/backup.sh >> /var/log/cygnus-backup.log 2>&1

set -euo pipefail

# --- Configuration (override via environment) ---
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5433}"
DB_NAME="${DB_NAME:-cygnus}"
DB_USER="${DB_USER:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/cygnus-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
PG_DUMP="${PG_DUMP:-pg_dump}"

# --- Execution ---
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILENAME="cygnus_${TIMESTAMP}.cjs"
FILEPATH="${BACKUP_DIR}/${FILENAME}"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

mkdir -p "${BACKUP_DIR}"
echo "[$(date)] Starting .cjs backup → ${FILEPATH}"

# 1. pg_dump → raw SQL
RAW="${TMPDIR}/dump.sql"
${PG_DUMP} -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" --no-owner --no-acl > "${RAW}"
ORIGINAL_SIZE=$(stat -c%s "${RAW}")

# 2. Compress
COMPRESSED="${TMPDIR}/dump.sql.gz"
gzip -c "${RAW}" > "${COMPRESSED}"
COMPRESSED_SIZE=$(stat -c%s "${COMPRESSED}")

# 3. SHA-256 of the compressed payload
CHECKSUM="sha256:$(sha256sum "${COMPRESSED}" | cut -d' ' -f1)"

# 4. Build .cjs file: magic + JSON header + newline + payload
HEADER="{\"version\":1,\"timestamp\":\"$(date -Iseconds)\",\"db\":\"${DB_NAME}\",\"checksum\":\"${CHECKSUM}\",\"compressed_size\":${COMPRESSED_SIZE},\"original_size\":${ORIGINAL_SIZE}}"

{
  printf 'CYGNUS_BACKUP\n'
  printf '%s\n' "${HEADER}"
  cat "${COMPRESSED}"
} > "${FILEPATH}"

TOTAL_SIZE=$(du -h "${FILEPATH}" | cut -f1)
echo "[$(date)] ✓ Backup complete: ${FILENAME} (${TOTAL_SIZE}, payload ${COMPRESSED_SIZE} bytes, checksum ${CHECKSUM})"
logger -t cygnus-backup "OK: ${FILENAME} (${TOTAL_SIZE})"

# 5. Rotation: remove old backups
DELETED=$(find "${BACKUP_DIR}" -name "cygnus_*.cjs" -mtime "+${KEEP_DAYS}" -delete -print | wc -l)
if [ "${DELETED}" -gt 0 ]; then
    echo "[$(date)] Rotated ${DELETED} old backup(s)"
fi

echo "[$(date)] Done. ${BACKUP_DIR}: $(ls "${BACKUP_DIR}"/cygnus_*.cjs 2>/dev/null | wc -l) backup(s)"
