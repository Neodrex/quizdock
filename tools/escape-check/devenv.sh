# Dev env for the escape check: the backend and frontend run natively against the
# compose postgres/redis (`docker compose up -d postgres redis` in live/). No secrets:
# it reads live/.env. Source it (bash or zsh) from anywhere:
#   source live/tools/escape-check/devenv.sh
# It leaves the shell in live/. See two-phones.mjs for the servers and the run.
_here="${BASH_SOURCE[0]:-${(%):-%x}}"
cd "$(dirname "$_here")/../.." || return
unset _here
source .envrc.local
set -a; source .env; set +a
# Temp files (Chrome profiles too) stay in the outer repo's .tmp/, on the SSD.
export TMPDIR="$(cd .. && pwd)/.tmp"
mkdir -p "$TMPDIR"
export DATABASE_URL="postgres://live:live@localhost:15432/quizdock"
export REDIS_URL="redis://localhost:16379"
export PORT=3000 VITE_API_URL=http://localhost:3000
