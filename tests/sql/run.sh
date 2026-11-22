#!/usr/bin/env bash
# Valida las migraciones y su comportamiento en un Postgres local (requiere psql y un servidor).
set -euo pipefail
DB=${DB:-winktest}
PSQL=${PSQL:-"sudo -u postgres psql"}
cd "$(dirname "$0")/../.."
$PSQL -qc "drop database if exists $DB" -c "create database $DB"
$PSQL -v ON_ERROR_STOP=1 -q -d $DB -f tests/sql/supabase_stubs.sql
for f in supabase/migrations/*.sql; do $PSQL -v ON_ERROR_STOP=1 -q -d $DB -f "$f"; done
$PSQL -v ON_ERROR_STOP=1 -q -d $DB -f tests/sql/behaviour.sql
