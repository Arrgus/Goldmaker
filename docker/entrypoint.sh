#!/bin/sh
set -e
# A freshly mounted volume (especially a bind mount) may be owned by root.
chown -R www-data:www-data "$GOLDMAKER_DATA_DIR"
# Logs the WoW Token price every 5 minutes, also while no page is open (TOKEN_LOG_FILE in api.php).
# As www-data, so the files it creates in the data folder stay writable for Apache. Its errors go
# to the container log.
su -s /bin/sh -c 'while :; do /usr/local/bin/php /var/www/html/api.php log-token-price; sleep 300; done' www-data &
exec "$@"
