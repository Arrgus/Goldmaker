FROM php:8.3-apache

# .htaccess files carry the access rules and security headers, so they must be honoured.
RUN a2enmod headers \
    && mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"
COPY docker/apache.conf /etc/apache2/conf-enabled/zz-goldmaker.conf
COPY docker/php.ini "$PHP_INI_DIR/conf.d/goldmaker.ini"
COPY docker/entrypoint.sh /usr/local/bin/goldmaker-entrypoint
RUN chmod +x /usr/local/bin/goldmaker-entrypoint

# Data lives outside the web root; mount a persistent volume here.
ENV GOLDMAKER_DATA_DIR=/data
RUN mkdir /data && chown www-data:www-data /data
VOLUME /data

COPY --chown=www-data:www-data index.html app.js style.css api.php armory.php .htaccess /var/www/html/

ENTRYPOINT ["goldmaker-entrypoint"]
CMD ["apache2-foreground"]
