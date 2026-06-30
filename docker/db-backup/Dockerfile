FROM postgres:18-alpine

RUN apk add --no-cache \
    aws-cli \
    bash \
    coreutils \
    gnupg \
    gzip

COPY docker/db-backup/backup-postgres.sh /usr/local/bin/backup-postgres
RUN chmod 0755 /usr/local/bin/backup-postgres

ENTRYPOINT []
CMD ["backup-postgres"]
