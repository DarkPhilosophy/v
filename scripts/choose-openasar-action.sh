#!/usr/bin/env sh
set -eu

action=${OPENASAR_ACTION:-}
if [ -z "$action" ]; then
    if [ -t 0 ] && [ -r /dev/tty ]; then
        printf '%s\n' 'OpenAsar: [i]nstall/update, [k]eep current state, or [r]emove? [i]' >&2
        IFS= read -r action </dev/tty || action=install
        [ -n "$action" ] || action=install
    else
        action=install
    fi
fi

case "$action" in
    i|install) action=install ;;
    k|keep) action=keep ;;
    r|remove) action=remove ;;
    *)
        printf 'choose-openasar-action.sh: invalid OPENASAR_ACTION: %s\n' "$action" >&2
        exit 2
        ;;
esac

printf '%s\n' "$action"
