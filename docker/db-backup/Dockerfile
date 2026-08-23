# Keep this pinned to the same version as the `postgres` service in docker-compose.yml: pg_dump
# refuses to dump from a server newer than itself, so letting the two drift breaks backups.
FROM postgres:18.6-alpine

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
