#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
HELPER="$ROOT/scripts/choose-openasar-action.sh"

[ "$(OPENASAR_ACTION=install "$HELPER" </dev/null)" = "install" ]
[ "$(OPENASAR_ACTION=keep "$HELPER" </dev/null)" = "keep" ]
[ "$(OPENASAR_ACTION=remove "$HELPER" </dev/null)" = "remove" ]
[ "$(env -u OPENASAR_ACTION "$HELPER" </dev/null)" = "install" ]

if OPENASAR_ACTION=invalid "$HELPER" </dev/null >/dev/null 2>&1; then
    echo 'expected invalid OPENASAR_ACTION rejection' >&2
    exit 1
fi

printf '%s\n' 'choose-openasar-action focused checks passed'
