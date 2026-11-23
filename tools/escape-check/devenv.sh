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
# Sign-in (M8 §6): `AUTH=site source devenv.sh` signs Live in with the Site's
# Supabase (OAuth 2.1 server, the `live_roles` claim from its access token hook).
# Needs the Site's stack (`pnpm db:start` in app/) and `pnpm seed`, which writes
# the client id and secret to .tmp/live-oidc.env. The frontend runs on 5174, the
# redirect the seed registers. The default stays AUTH_MODE=none (live/.env).
# Never run `pnpm test` after sourcing this: it would inherit these variables.
if [ "${AUTH:-none}" = site ]; then
  if [ ! -f "$TMPDIR/live-oidc.env" ]; then
    echo "devenv: $TMPDIR/live-oidc.env is missing: run pnpm seed in app/ first" >&2
    return 1
  fi
  export AUTH_MODE=oidc
  export OIDC_ISSUER=http://127.0.0.1:54321/auth/v1
  unset OIDC_INTERNAL_URL
  export OIDC_ROLES_CLAIM=live_roles OIDC_AUDIENCE=
  # Guests join with the PIN and a nickname alone.
  export ALLOW_ANONYMOUS_PARTICIPANTS=true
  set -a; source "$TMPDIR/live-oidc.env"; set +a
  # Port 3000 is often taken on this machine (§6 finding 9).
  export PORT=3100 VITE_API_URL=http://localhost:3100
fi
