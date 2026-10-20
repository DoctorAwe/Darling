#!/bin/sh
set -eu
source_file=/root/darling-voice-beta-4bed480f.js
target=/opt/darling/apps/server/dist/index.js
expected=4bed480fa75db6bc99dd35b6c5de40faab5a11f720c08b5faded9f9ac802613b
printf '%s  %s\n' "$expected" "$source_file" | sha256sum -c -
/opt/darling-node-v24.22.0/bin/node --check "$source_file"
backup=$(mktemp /root/darling-before-voice-beta-XXXXXX.js)
cp -p "$target" "$backup"
rollback() {
  install -m 644 "$backup" "$target"
  systemctl restart darling
  printf 'Update failed; restored %s\n' "$backup"
}
trap rollback HUP INT TERM
install -m 644 "$source_file" /opt/darling/apps/server/dist/index.js.next
mv /opt/darling/apps/server/dist/index.js.next "$target"
if ! systemctl restart darling; then rollback; exit 1; fi
ready=false
for attempt in 1 2 3 4 5; do
  if curl -fsS http://127.0.0.1:8787/health; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then rollback; exit 1; fi
systemctl is-active darling darling-turn
sha256sum "$target"
printf '\nBackup: %s\n' "$backup"
trap - HUP INT TERM
