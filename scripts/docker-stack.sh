#!/usr/bin/env bash
# Build and start the Docker stack in two separate steps.
#
#   pnpm docker:build   # build fresh images from the current code, delete the old ones
#   pnpm docker:up      # (re)create the containers from those images and start them
#   pnpm docker:update  # pull newer third-party images, rebuild ours, recreate what changed
#   pnpm docker:restart # restart the running containers in place
#   pnpm docker:logs    # pick a container from a list and follow its logs
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

# Image IDs of the downloaded (not built) images, one "ref id" per line.
pulled_image_ids() {
  compose config --images | sort -u | while read -r ref; do
    [[ $ref == "${project}-"* ]] && continue # built locally, handled by prune
    echo "$ref $(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)"
  done
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
  update)
    before=$(pulled_image_ids)
    echo "Pulling newer versions of the downloaded images..."
    compose pull --ignore-buildable "$@"
    echo "Rebuilding this project's images..."
    compose build --pull "$@"
    # Recreates only the containers whose image or config changed.
    compose up -d "$@"
    # A pulled image's old version is untagged but has no Compose label, so
    # the prune below misses it: delete those by ID once nothing uses them.
    while read -r ref old_id; do
      [[ -n $old_id ]] || continue
      new_id=$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)
      if [[ $new_id != "$old_id" ]]; then
        echo "Updated $ref"
        docker image rm "$old_id" >/dev/null 2>&1 \
          || echo "  old $ref image is still in use; left in place"
      fi
    done <<<"$before"
    remove_old_images
    ;;
  restart)
    # Restarts the existing containers (all, or the services named) without
    # removing or recreating them. Code changes need docker:build + docker:up.
    compose restart "$@"
    ;;
  logs)
    # `pnpm docker:logs bot-main` skips the menu.
    service=${1:-}
    if [[ -z $service ]]; then
      mapfile -t services < <(compose ps --services --status running)
      if [[ ${#services[@]} -eq 0 ]]; then
        echo "No containers are running. Start them with 'pnpm docker:up'." >&2
        exit 1
      fi
      echo "Which container do you want the logs for?"
      PS3="Enter a number: "
      select choice in "${services[@]}" "all"; do
        [[ -n ${choice:-} ]] && break
        echo "Pick a number from the list."
      done
      [[ -n ${choice:-} ]] || exit 1 # no answer (Ctrl+D)
      [[ $choice == all ]] && service="" || service=$choice
    else
      shift
    fi
    # --tail rather than --since: --since has returned nothing on this stack.
    compose logs -f --tail=200 ${service:+"$service"} "$@"
    ;;
  *)
    echo "Usage: $0 build|up|update|restart|logs [docker compose args...]" >&2
    exit 2
    ;;
esac
