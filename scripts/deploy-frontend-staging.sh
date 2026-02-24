#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/home/useradmin/onloc"
BRANCH="main"
SERVICE_NAME="onloc-next.service"

echo "==> Frontend deploy (staging)"
echo "    repo:    $REPO_DIR"
echo "    branch:  $BRANCH"
echo "    service: $SERVICE_NAME"
echo

cd "$REPO_DIR"

# Проверка: git есть
command -v git >/dev/null 2>&1 || { echo "ОШИБКА: git не найден"; exit 1; }

# Проверка: npm есть
command -v npm >/dev/null 2>&1 || { echo "ОШИБКА: npm не найден"; exit 1; }

# Проверка: systemctl есть
command -v systemctl >/dev/null 2>&1 || { echo "ОШИБКА: systemctl не найден"; exit 1; }

# Проверка: sudo без пароля для нужного сервиса (non-interactive)
if ! sudo -n true 2>/dev/null; then
  echo "ОШИБКА: sudo требует пароль (ожидался NOPASSWD)."
  echo "Проверь sudoers для useradmin."
  exit 1
fi

# Проверка: нет незакоммиченных tracked-изменений
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "ОШИБКА: В репозитории есть незакоммиченные изменения (tracked files)."
  echo "Сначала проверь: git status"
  exit 1
fi

echo "==> Fetch / pull"
git fetch origin "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "==> Install dependencies"
npm ci

echo "==> Build"
npm run build

echo "==> Restart service"
sudo -n systemctl restart "$SERVICE_NAME"

echo "==> Service status"
sudo -n systemctl status "$SERVICE_NAME" --no-pager -l || true

echo "==> Port check (:3000)"
ss -ltnp | grep ':3000' || true

echo "==> Frontend deploy finished successfully"
