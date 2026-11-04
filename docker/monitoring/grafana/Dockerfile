FROM grafana/grafana:13.2.3
# Dokploy replaces its checkout on deployment. Directory bind mounts on an unchanged container
# keep the deleted directories, so package provisioning with the image instead.
COPY docker/monitoring/grafana/provisioning /etc/grafana/provisioning
# Keep bundled dashboards outside /var/lib/grafana, which is covered by the persistent data volume.
COPY docker/monitoring/grafana/dashboards /etc/grafana/dashboards
