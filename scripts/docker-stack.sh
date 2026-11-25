#!/usr/bin/env bash
# Build and start the Docker stack in two separate steps.
#
#   pnpm docker:build   # build fresh images from the current code, delete the old ones
#   pnpm docker:up      # (re)create the containers from those images and start them
#   pnpm docker:down    # stop and remove the containers
#
# Extra arguments are passed to docker compose, for example
# `pnpm docker:build --no-cache` or `pnpm docker:build bot-main`.
#
# Old images are only deleted when nothing uses them. While the old containers
# are still running after `docker:build`, their images stay; `docker:up`
# replaces those containers and then deletes the images they were using.
# Only images built by this Compose project are touched.
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
project=discord-music
export DOCKER_CONTEXT=${DOCKER_CONTEXT:-default}

compose() {
  docker compose --env-file "$repository_root/.env" \
    -f "$repository_root/docker/docker-compose.yml" "$@"
}

remove_old_images() {
  echo "Removing old ${project} images that nothing uses any more..."
  docker image prune --force \
    --filter "dangling=true" \
    --filter "label=com.docker.compose.project=${project}"
}

command=${1:-}
shift || true

case "$command" in
  build)
    # --pull also refreshes the base images (node, etc.) the Dockerfiles use.
    compose build --pull "$@"
    remove_old_images
    echo "Images built. Run 'pnpm docker:up' to start containers from them."
    ;;
  up)
    # Builds only images that do not exist yet; otherwise uses the ones from
    # `docker:build` and recreates any container whose image changed.
    compose up -d "$@"
    remove_old_images
    ;;
  *)
    echo "Usage: $0 build|up [docker compose args...]" >&2
    exit 2
    ;;
esac
