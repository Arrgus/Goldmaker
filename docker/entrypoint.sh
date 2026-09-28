#!/bin/sh
set -e
# A freshly mounted volume (especially a bind mount) may be owned by root.
chown -R www-data:www-data "$GOLDMAKER_DATA_DIR"
exec "$@"
