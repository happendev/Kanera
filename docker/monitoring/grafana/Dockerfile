FROM grafana/grafana:13.3.0
# Dokploy replaces its checkout on deployment. Directory bind mounts on an unchanged container
# keep the deleted directories, so package provisioning with the image instead.
# The non-root entrypoint renders the desired replica counts into the alert query on startup.
COPY --chown=grafana:root docker/monitoring/grafana/provisioning /etc/grafana/provisioning
# Keep bundled dashboards outside /var/lib/grafana, which is covered by the persistent data volume.
COPY docker/monitoring/grafana/dashboards /etc/grafana/dashboards
