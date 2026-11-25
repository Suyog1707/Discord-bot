#!/usr/bin/env bash
# Build and start the Docker stack in two separate steps.
#
#   pnpm docker:build   # build fresh images from the current code, delete the old ones
#   pnpm docker:up      # (re)create the containers from those images and start them
#   pnpm docker:update  # pull newer third-party images, rebuild ours, recreate what changed
#
# Each command reports what changed, or "Already up to date" when nothing did:
# unchanged code is served from the build cache and gives the same image, and
# a container is only recreated when its image or settings changed.
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

# "image-ref image-id fingerprint" for every image the stack uses (built and
# downloaded). The fingerprint hashes the layers and settings: a fully cached
# rebuild produces identical content but a new image ID (BuildKit adds a fresh
# build record each time), so the ID alone would report a change that is not one.
image_ids() {
  compose config --images | sort -u | while read -r ref; do
    local id fingerprint
    id=$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || echo none)
    fingerprint=$(docker image inspect \
      --format '{{json .RootFS.Layers}}{{json .Config}}' "$ref" 2>/dev/null \
      | sha256sum | cut -c1-16)
    echo "$ref $id $fingerprint"
  done
}

# "service container-id" for every container of the stack.
container_ids() {
  compose ps -a --format '{{.Service}} {{.ID}}' 2>/dev/null | sort
}

# Prints the refs whose content differs between two image_ids() snapshots.
changed_images() {
  join -o 0,1.3,2.3 <(sort <<<"$1") <(sort <<<"$2") | awk '$2 != $3 { print $1 }'
}

# Prints the services whose container is new or was replaced.
recreated_containers() {
  join -a 2 -e none -o 0,1.2,2.2 <(sort <<<"$1") <(sort <<<"$2") \
    | awk '$2 != $3 { print $1 }'
}

# Summary after a build/up/update. $1 = changed images, $2 = recreated services.
report() {
  if [[ -z $1 && -z $2 ]]; then
    echo "Already up to date: nothing rebuilt, no containers recreated."
    return
  fi
  [[ -n $1 ]] && { echo "New images:"; sed 's/^/  /' <<<"$1"; }
  [[ -n $2 ]] && { echo "Recreated containers:"; sed 's/^/  /' <<<"$2"; }
  return 0
}

command=${1:-}
shift || true

case "$command" in
  build)
    # --pull also refreshes the base images (node, etc.) the Dockerfiles use.
    # Unchanged code is served from the build cache and keeps the same image.
    images_before=$(image_ids)
    compose build --pull "$@"
    changed=$(changed_images "$images_before" "$(image_ids)")
    if [[ -z $changed ]]; then
      echo "Already up to date: the code has not changed since the last build."
    else
      report "$changed" ""
      remove_old_images
      echo "Run 'pnpm docker:up' to start containers from the new images."
    fi
    ;;
  up)
    # Builds only images that do not exist yet; otherwise uses the ones from
    # `docker:build` and recreates only containers whose image or config changed.
    containers_before=$(container_ids)
    compose up -d "$@"
    report "" "$(recreated_containers "$containers_before" "$(container_ids)")"
    remove_old_images
    ;;
  update)
    images_before=$(image_ids)
    containers_before=$(container_ids)
    echo "Pulling newer versions of the downloaded images..."
    compose pull --ignore-buildable "$@"
    echo "Rebuilding this project's images..."
    compose build --pull "$@"
    # Recreates only the containers whose image or config changed.
    compose up -d "$@"
    changed=$(changed_images "$images_before" "$(image_ids)")
    report "$changed" "$(recreated_containers "$containers_before" "$(container_ids)")"
    # A downloaded image's old version is untagged but has no Compose label,
    # so the prune below misses it: delete those by ID once nothing uses them.
    while read -r ref old_id _; do
      [[ $old_id != none && $ref != "${project}-"* ]] || continue
      grep -qxF "$ref" <<<"$changed" || continue
      docker image rm "$old_id" >/dev/null 2>&1 \
        || echo "Old $ref image is still in use; left in place."
    done <<<"$images_before"
    [[ -z $changed ]] || remove_old_images
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
