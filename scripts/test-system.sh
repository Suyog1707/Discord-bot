#!/usr/bin/env bash
# Repeatable local checks. Never sources .env or starts Discord bots.
# --integration adds disposable PostgreSQL/Redis and browser checks.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mode="${1:-}"
if [[ -n "$mode" && "$mode" != --integration ]]; then
  echo 'Usage: bash scripts/test-system.sh [--integration]' >&2
  exit 2
fi
unset AUTH_TEST_DATABASE_URL HAND_OVER_TEST_REDIS_URL
pnpm --filter @discord-music/shared build
pnpm --filter @discord-music/database build
pnpm -r typecheck
pnpm -r lint
pnpm --filter @discord-music/shared exec vitest run --maxWorkers=2
pnpm --filter @discord-music/bot exec vitest run --maxWorkers=2
pnpm --filter @discord-music/web exec vitest run --maxWorkers=2
if [[ "$mode" != --integration ]]; then exit 0; fi

# Container ids are recorded only after creation succeeds. Cleanup therefore
# cannot remove an existing container or any production volume.
test_pg_id=''
test_redis_id=''
cleanup() {
  if [[ -n "$test_pg_id" ]]; then docker stop "$test_pg_id" >/dev/null || true; fi
  if [[ -n "$test_redis_id" ]]; then docker stop "$test_redis_id" >/dev/null || true; fi
}
trap cleanup EXIT
test_pg_id=$(docker run --rm -d -p 127.0.0.1::5432 \
  -e POSTGRES_USER=music_test -e POSTGRES_DB=music_test \
  -e POSTGRES_PASSWORD=isolated-test-password postgres:17-alpine)
test_redis_id=$(docker run --rm -d -p 127.0.0.1::6379 redis:7-alpine)
ready=false
for attempt in {1..60}; do
  if docker exec "$test_pg_id" pg_isready -U music_test -d music_test >/dev/null 2>&1 && \
     docker exec "$test_redis_id" redis-cli ping >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then echo 'Disposable test services failed to become ready.' >&2; exit 1; fi
test_pg_port=$(docker port "$test_pg_id" 5432/tcp)
test_redis_port=$(docker port "$test_redis_id" 6379/tcp)
test_db_url="postgresql://music_test:isolated-test-password@${test_pg_port}/music_test"
test_redis_url="redis://${test_redis_port}"
env DATABASE_URL="$test_db_url" DIRECT_URL="$test_db_url" pnpm --filter @discord-music/database run deploy
env AUTH_TEST_DATABASE_URL="$test_db_url" HAND_OVER_TEST_REDIS_URL="$test_redis_url" \
  pnpm --filter @discord-music/web exec vitest run \
  src/lib/auth/adapter.integration.test.ts src/lib/interactions/hand-over.test.ts --maxWorkers=2

# Install Chromium once with: pnpm --filter @discord-music/web exec playwright install chromium
# Inert test secrets below are not credentials for any running deployment.
env PLAYWRIGHT_FRESH_SERVER=true WEB_BACKEND_LOCAL=true NEXT_PUBLIC_APP_URL=http://localhost:3000 NEXTAUTH_URL=http://localhost:3000 \
  NEXTAUTH_SECRET=browser-test-secret-at-least-thirty-two-characters \
  DISCORD_CLIENT_ID=000000000000000001 DISCORD_CLIENT_SECRET=test-placeholder \
  BACKEND_PROXY_ENABLED=false DATABASE_URL="$test_db_url" REDIS_URL="$test_redis_url" \
  pnpm --filter @discord-music/web exec playwright test --project=chromium --workers=1
