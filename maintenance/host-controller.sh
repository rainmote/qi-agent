#!/bin/sh
# Trusted controller only. The Docker socket never enters candidate containers.
set -eu
if [ "$#" -lt 4 ]; then
  echo 'Usage: host-controller.sh ABS_ROOT EXACT_SOURCE IMAGE_ID SMOKE [ARGS...]' >&2
  exit 2
fi
root=$1 source=$2 image=$3 smoke=$4
shift 4
case "$root" in /*) ;; *) exit 2 ;; esac
case "$root" in /|*,*|*'
'*) exit 2 ;; esac
[ "$(realpath "$root")" = "$root" ]
printf '%s\n' "$source" | LC_ALL=C grep -Eq '^[a-f0-9]{40}$'
printf '%s\n' "$image" | LC_ALL=C grep -Eq '^sha256:[a-f0-9]{64}$'
case "$smoke" in broker-smoke|worker-smoke|container-smoke|qi-smoke) ;; *) exit 2 ;; esac
repo=$root/repo
[ "$(git -c safe.directory="$repo" -C "$repo" rev-parse HEAD)" = "$source" ]
[ -z "$(git -c safe.directory="$repo" -C "$repo" status --porcelain)" ]
[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" = linux/arm64 ]
owner_uid=$(stat -c %u "$root")
owner_gid=$(stat -c %g "$root")
[ "$owner_uid" -ne 0 ]
socket_gid=$(stat -c %g /var/run/docker.sock)
docker_cli=$(command -v docker)
# The identical absolute mount is required: sibling containers are created by
# the host daemon, which resolves bind sources in the host filesystem.
exec docker run --rm --init --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --label qi.maintenance.host-controller=true \
  --user "$owner_uid:$owner_gid" --group-add "$socket_gid" \
  --network none --cpus=0.5 --memory=384m --memory-swap=384m --pids-limit=128 \
  --tmpfs /tmp:rw,exec,mode=1777,size=128m \
  --mount "type=bind,src=$root,dst=$root" \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount "type=bind,src=$docker_cli,dst=/usr/bin/docker,readonly" \
  --workdir "$repo" --env HOME=/tmp/qi-home \
  --env "QI_MAINTENANCE_IMAGE=$image" \
  --env 'QI_MAINTENANCE_RESOURCES={"cpus":2,"memory_mb":2048,"work_mb":6144,"tmp_mb":256,"pids":1024}' \
  --env "QI_MAINTENANCE_OUTPUT=$root/evidence/container" \
  --entrypoint node "$image" "maintenance/$smoke.mjs" "$@"
