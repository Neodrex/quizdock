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
# Licences (M7 §1.2): the static source with the Dev licence alone, as the backend
# tests, so a legacy create opens a hosted event and the older checks run unchanged.
# `LICENCES=all source devenv.sh` adds Acme (cap 8, 2 events, a brand) and Expired Co,
# as in apps/backend/src/escape/licences/dev-licences.ts: sessions.mjs's hosted part
# needs them (and a fresh backend: the static source counts Acme's uses in memory).
_dev_licence='{"id":"dev-licence","organisationId":"dev-org","package":"annual","participantCap":500,"validFrom":null,"expiresAt":4102444800000,"eventsLeft":null,"brand":null,"hosts":["*"]}'
_acme='{"id":"acme","organisationId":"acme-org","package":"bundle","participantCap":8,"validFrom":null,"expiresAt":4102444800000,"eventsLeft":2,"brand":{"name":"Acme","logoUrl":"http://localhost:5173/escape-dev/acme-logo.png","accent":"#c2410c","background":null,"baseTheme":"classic","intro":"Welcome to the Acme team escape."},"hosts":["*"]}'
_expired='{"id":"expired-co","organisationId":"expired-org","package":"single","participantCap":30,"validFrom":null,"expiresAt":1577836800000,"eventsLeft":1,"brand":null,"hosts":["*"]}'
export ESCAPE_LICENCE_SOURCE=static
if [ "${LICENCES:-dev}" = all ]; then
  export ESCAPE_STATIC_LICENCES="[$_dev_licence,$_acme,$_expired]"
else
  export ESCAPE_STATIC_LICENCES="[$_dev_licence]"
fi
unset _dev_licence _acme _expired
