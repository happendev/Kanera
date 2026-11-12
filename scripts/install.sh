#!/usr/bin/env bash
# Fresh-install helper; ongoing operations remain ordinary Docker Compose commands.
main() {
set -Eeuo pipefail
umask 077

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: bash install.sh [options]
  --mode localhost|production  Prompted when omitted
  --domain kanera.example.com  Required for production (prompted when omitted)
  --https caddy|existing       Production proxy, default: caddy
  --directory PATH            New installation directory, default: ./kanera
  --port NUMBER               Loopback web port, default: 4200
  --project-name NAME         Unused Compose project, default: kanera
  --version vX.Y.Z            Release to install, default: latest
  --help                      Show this help
Requires Bash, curl, OpenSSL, and a running Docker with Compose >= 2.23.
Production Caddy requires public DNS and inbound TCP ports 80 and 443.
Existing-proxy mode leaves HTTPS configuration to your proxy.
HELP
}
mode='' domain='' proxy=caddy directory=./kanera port=4200 project=kanera version=latest
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --mode|--domain|--https|--directory|--port|--project-name|--version)
      if (($# < 2)) || [[ -z "$2" ]]; then fail "Missing value for $1"; fi
      case "$1" in
        --mode) mode=$2 ;; --domain) domain=$2 ;; --https) proxy=$2 ;;
        --directory) directory=$2 ;; --port) port=$2 ;;
        --project-name) project=$2 ;; --version) version=$2 ;;
      esac
      shift 2 ;;
    *) fail "Unknown option: $1 (see --help)" ;;
  esac
done
prompt() {
  local answer
  [[ -r /dev/tty ]] || fail "No terminal; supply --mode and --domain explicitly."
  read -r -p "$1" answer </dev/tty || fail "No terminal input; supply options explicitly."
  printf '%s' "$answer"
}
[[ -n "$mode" ]] || mode=$(prompt 'Install mode [localhost/production] (localhost): ')
mode=${mode:-localhost}
[[ "$mode" == localhost || "$mode" == production ]] || fail 'Mode must be localhost or production.'
[[ "$proxy" == caddy || "$proxy" == existing ]] || fail 'HTTPS must be caddy or existing.'
if [[ ! "$port" =~ ^[1-9][0-9]{0,4}$ ]] || ((port > 65535)); then fail 'Port must be between 1 and 65535.'; fi
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'Project name must use lowercase letters, digits, underscores or hyphens.'
[[ "$version" == latest || "$version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail 'Version must be vX.Y.Z.'
if [[ "$mode" == production ]]; then
  [[ -n "$domain" ]] || domain=$(prompt 'Public domain (for example kanera.example.com): ')
  domain=$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]')
  # Accept a DNS hostname, never a URL or config fragment interpolated into Compose/Caddy.
  [[ ${#domain} -le 253 && "$domain" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || fail 'Supply a public DNS hostname without a scheme, path, or port.'
  case "$domain" in *.localhost|*.local|*.internal|*.home.arpa|*.ts.net) fail 'Supply a public DNS domain for production HTTPS.' ;; esac
  origin="https://$domain"; secure=true
else
  [[ -z "$domain" && "$proxy" == caddy ]] || fail '--domain and --https are production-only options.'
  domain=localhost; origin="http://localhost:$port"; secure=false
fi
[[ ! -e "$directory" && ! -L "$directory" ]] || fail "Directory already exists: $directory. Use Docker Compose there to resume or update; secrets will not be overwritten."
for command in curl openssl docker; do
  command -v "$command" >/dev/null || fail "Install $command first."
done
compose_version=$(docker compose version --short) || fail 'Install Docker Compose >= 2.23.'
[[ "$compose_version" =~ ^v?([0-9]+)\.([0-9]+) ]] || fail 'Cannot read Docker Compose version.'
((BASH_REMATCH[1] > 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] >= 23))) || fail 'Docker Compose >= 2.23 is required.'
docker info >/dev/null 2>&1 || fail 'Docker is not running or your user cannot access it.'
# A fresh directory must not silently attach fresh encryption keys to an existing database.
[[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]] || fail "Compose project $project already has containers."
[[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]] || fail "Compose project $project already has data volumes."

stage=$(mktemp -d)
installed=false
cleanup() {
  local status=$?
  rm -rf "$stage"
  if ((status != 0)) && [[ "$installed" == true ]]; then
    printf 'Setup did not finish. Files and secrets are preserved in %s.\nRun docker compose logs and docker compose up -d from that directory after fixing the error.\n' "$directory" >&2
  fi
}
trap cleanup EXIT
base=https://github.com/happendev/Kanera/releases
if [[ "$version" == latest ]]; then
  # Resolve Latest once so a release published during setup cannot mix asset versions.
  effective=$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --retry 3 --output /dev/null --write-out '%{url_effective}' "$base/latest")
  version=${effective##*/}
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Latest is not a Kanera application release; supply --version vX.Y.Z.'
fi
fetch() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --retry 3 --output "$2" "$base/download/$version/$1"
}
printf 'Downloading Kanera %s…\n' "$version"
fetch docker-compose.yml "$stage/docker-compose.yml"
if [[ "$mode" == production && "$proxy" == caddy ]]; then
  fetch docker-compose.https.yml "$stage/docker-compose.override.yml"
fi
{
  printf '# Generated by the Kanera installer. Keep these secrets stable and back up this file.\n'
  printf 'POSTGRES_BIND_PORT=0\nCOMPOSE_PROJECT_NAME=%s\nWEB_BIND_PORT=%s\n' "$project" "$port"
  for key in POSTGRES_PASSWORD JWT_SECRET MCP_INTERNAL_SECRET MFA_ENCRYPTION_KEY MEDIA_SIGNING_SECRET SECRETS_ENCRYPTION_KEY; do
    secret=$(openssl rand -hex 32)
    [[ "$secret" =~ ^[a-f0-9]{64}$ ]] || fail "Could not generate $key."
    printf '%s=%s\n' "$key" "$secret"
  done
  printf 'WEB_ORIGIN=%s\nCOOKIE_DOMAIN=%s\nCOOKIE_SECURE=%s\n' "$origin" "$domain" "$secure"
  printf 'KANERA_DEPLOYMENT_MODE=self_hosted\nKANERA_ENVIRONMENT=production\nANALYTICS_ENABLED=false\n'
  # nginx is always in front of the APIs, including in localhost mode.
  printf 'API_TRUST_PROXY=true\nPUBLIC_API_TRUST_PROXY=true\n'
  printf 'PUBLIC_API_OAUTH_ISSUER=%s/public-api\n' "$origin"
  printf 'MCP_SERVER_PUBLIC_URL=%s/mcp\nMCP_PUBLIC_URL=%s/mcp\n' "$origin" "$origin"
} > "$stage/.env"
# Inherited shell settings must not override freshly generated secrets or enable hosted profiles.
# Run Compose with a minimal environment; retain Docker connection/auth settings for remote engines.
compose() {
  env -i PATH="$PATH" HOME="$HOME" \
    ${DOCKER_HOST+"DOCKER_HOST=$DOCKER_HOST"} ${DOCKER_CONTEXT+"DOCKER_CONTEXT=$DOCKER_CONTEXT"} \
    ${DOCKER_CONFIG+"DOCKER_CONFIG=$DOCKER_CONFIG"} ${DOCKER_TLS_VERIFY+"DOCKER_TLS_VERIFY=$DOCKER_TLS_VERIFY"} \
    ${DOCKER_CERT_PATH+"DOCKER_CERT_PATH=$DOCKER_CERT_PATH"} \
    docker compose --project-directory "$1" --env-file "$1/.env" "${@:2}"
}
compose "$stage" config --quiet
mkdir -p -- "$(dirname -- "$directory")"
mkdir -m 700 -- "$directory"
directory=$(cd "$directory" && pwd)
mv "$stage/.env" "$stage/docker-compose.yml" "$directory/"
if [[ -f "$stage/docker-compose.override.yml" ]]; then mv "$stage/docker-compose.override.yml" "$directory/"; fi
installed=true
printf 'Starting Kanera. Images and first-run migrations can take several minutes…\n'
compose "$directory" pull
# Explicit long-lived targets avoid treating the successful one-shot deployment notifier as unhealthy.
services=(web api worker public-api mcp)
if [[ "$mode" == production && "$proxy" == caddy ]]; then services+=(caddy); fi
compose "$directory" up -d --wait --wait-timeout 300 "${services[@]}"
curl --fail --silent --show-error --max-time 15 "http://localhost:$port/api/health" >/dev/null
if [[ "$mode" == production && "$proxy" == caddy ]]; then
  printf 'Waiting for the public HTTPS endpoint and its certificate…\n'
  curl --fail --silent --show-error --retry 20 --retry-all-errors --retry-delay 3 --max-time 10 "$origin/api/health" >/dev/null
elif [[ "$mode" == production ]]; then
  printf 'Local services are healthy. Configure your HTTPS proxy for %s -> http://127.0.0.1:%s (including WebSockets).\n' "$origin" "$port"
fi
printf '\nKanera installed in %s\nOpen %s and create your account.\n' "$directory" "$origin"
printf 'SMTP is optional; configure it in organisation settings when needed.\nKeep .env and your database/uploads backed up. See DEPLOY.md for updates and integrations.\n'
}

# Parse the complete installer before executing it when streamed through curl.
main "$@"
