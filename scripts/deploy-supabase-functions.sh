#!/usr/bin/env bash
set -euo pipefail

# ===== Local source (Git source-of-truth) =====
PROJECT_ROOT="/home/useradmin/onloc"
SRC_FUNCTIONS_DIR="$PROJECT_ROOT/supabase/functions"
SRC_DENO_JSON="$PROJECT_ROOT/supabase/deno.json"

# ===== Remote runtime (self-hosted Supabase) =====
REMOTE_USER="useradmin"
REMOTE_HOST="192.168.3.24"
REMOTE_RUNTIME_FUNCTIONS_DIR="/opt/supabase-test/supabase/docker/volumes/functions"
REMOTE_COMPOSE_DIR="/opt/supabase-test/supabase/docker"
REMOTE_FUNCTIONS_SERVICE="functions"

# ===== Options =====
DRY_RUN=false
NO_RESTART=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --no-restart) NO_RESTART=true ;;
    *)
      echo "Неизвестный аргумент: $arg"
      echo "Использование: $0 [--dry-run] [--no-restart]"
      exit 1
      ;;
  esac
done

echo "==> Supabase Edge Functions deploy (staging)"
echo "    source functions: $SRC_FUNCTIONS_DIR"
echo "    source deno.json: $SRC_DENO_JSON"
echo "    remote host:      $REMOTE_USER@$REMOTE_HOST"
echo "    remote runtime:   $REMOTE_RUNTIME_FUNCTIONS_DIR"
echo "    compose dir:      $REMOTE_COMPOSE_DIR"
echo "    service:          $REMOTE_FUNCTIONS_SERVICE"
echo "    dry-run:          $DRY_RUN"
echo "    no-restart:       $NO_RESTART"
echo

# ===== Local checks =====
command -v rsync >/dev/null 2>&1 || { echo "ОШИБКА: rsync не найден"; exit 1; }
command -v ssh >/dev/null 2>&1 || { echo "ОШИБКА: ssh не найден"; exit 1; }
command -v scp >/dev/null 2>&1 || { echo "ОШИБКА: scp не найден"; exit 1; }

[[ -d "$SRC_FUNCTIONS_DIR" ]] || { echo "ОШИБКА: не найдена папка $SRC_FUNCTIONS_DIR"; exit 1; }
[[ -f "$SRC_DENO_JSON" ]] || { echo "ОШИБКА: не найден файл $SRC_DENO_JSON"; exit 1; }

# ===== SSH check (passwordless expected) =====
echo "==> SSH check to $REMOTE_USER@$REMOTE_HOST"
ssh -o BatchMode=yes -o ConnectTimeout=5 "$REMOTE_USER@$REMOTE_HOST" "echo ok" >/dev/null || {
  echo "ОШИБКА: нет SSH-доступа к $REMOTE_USER@$REMOTE_HOST (ожидался ключ без пароля)."
  exit 1
}

# ===== Ensure remote paths exist =====
echo "==> Ensure remote directories exist"
ssh "$REMOTE_USER@$REMOTE_HOST" "mkdir -p '$REMOTE_RUNTIME_FUNCTIONS_DIR'"

# ===== Sync functions =====
echo "==> Sync functions (rsync)"
RSYNC_ARGS=(-avz --delete)
if [[ "$DRY_RUN" == "true" ]]; then
  RSYNC_ARGS+=(--dry-run)
fi

rsync "${RSYNC_ARGS[@]}" \
  "$SRC_FUNCTIONS_DIR/" \
  "$REMOTE_USER@$REMOTE_HOST:$REMOTE_RUNTIME_FUNCTIONS_DIR/"

# ===== Sync deno.json =====
echo "==> Sync deno.json"
if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] scp '$SRC_DENO_JSON' -> '$REMOTE_USER@$REMOTE_HOST:$REMOTE_RUNTIME_FUNCTIONS_DIR/deno.json'"
else
  scp "$SRC_DENO_JSON" \
      "$REMOTE_USER@$REMOTE_HOST:$REMOTE_RUNTIME_FUNCTIONS_DIR/deno.json"
fi

# ===== Restart functions service =====
if [[ "$NO_RESTART" == "true" ]]; then
  echo "==> Skip restart (--no-restart)"
elif [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] ssh $REMOTE_USER@$REMOTE_HOST 'cd $REMOTE_COMPOSE_DIR && docker compose restart $REMOTE_FUNCTIONS_SERVICE'"
else
  echo "==> Restart remote functions service"
  ssh "$REMOTE_USER@$REMOTE_HOST" \
    "cd '$REMOTE_COMPOSE_DIR' && docker compose restart '$REMOTE_FUNCTIONS_SERVICE' && docker compose ps '$REMOTE_FUNCTIONS_SERVICE'"
fi

echo "==> Supabase functions deploy finished successfully"
