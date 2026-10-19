#!/usr/bin/env bash
# SessionStart hook for Claude Code cloud sessions in the shared "Hobby apps" environment
# (no-op locally). Copy to <repo>/.claude/cloud-session-start.sh and register it in
# <repo>/.claude/settings.json. On a fresh cloud VM it:
#   - installs gcloud if the environment's setup script didn't already
#   - logs gcloud and Google client libraries in as claude-cloud-session (from GCP_SA_KEY_B64)
#   - restores this repo's gitignored secret files (.env, app.yaml) from Secret Manager
#   - installs npm dependencies wherever a package-lock.json has none yet
# Source: mini-apps/skills/mini-apps/scripts/ (claude-cloud-setup.sh fills Secret Manager).
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
P=mlsd-2026-483513

if ! command -v gcloud >/dev/null 2>&1; then
  curl -fsSL https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz \
    | tar -xz -C /opt && ln -sf /opt/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud
fi

if [ -z "${GCP_SA_KEY_B64:-}" ]; then
  echo "cloud-session-start: GCP_SA_KEY_B64 is not set, so no Google Cloud access or secret files."
else
  KEY=/root/.config/gcp-sa.json
  mkdir -p "$(dirname "$KEY")"
  (umask 077 && echo "$GCP_SA_KEY_B64" | base64 -d > "$KEY")
  # Outbound traffic goes through Anthropic's proxy; trust the system CA bundle like curl does.
  [ -f /etc/ssl/certs/ca-certificates.crt ] && gcloud config set core/custom_ca_certs_file /etc/ssl/certs/ca-certificates.crt -q 2>/dev/null
  gcloud auth activate-service-account --key-file "$KEY" -q 2>/dev/null
  gcloud config set project "$P" -q 2>/dev/null
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export GOOGLE_APPLICATION_CREDENTIALS=$KEY" >> "$CLAUDE_ENV_FILE"
    echo "export GOOGLE_CLOUD_PROJECT=$P" >> "$CLAUDE_ENV_FILE"
  fi

  repo=$(basename "$(git remote get-url origin)" .git | tr 'A-Z' 'a-z')
  restored=""
  for id in $(gcloud secrets list --filter "labels.repo=$repo AND labels.claude-cloud=file" --format 'value(name)' 2>/dev/null); do
    path=$(gcloud secrets describe "$id" --format 'value(annotations.path)')
    [ -n "$path" ] || continue
    mkdir -p "$(dirname "$path")"
    (umask 077 && gcloud secrets versions access latest --secret "$id" > "$path") && restored="$restored $path"
  done
  echo "cloud-session-start: gcloud logged in as claude-cloud-session; restored:${restored:- nothing}."
fi

for lock in $(git ls-files '*package-lock.json'); do
  d=$(dirname "$lock")
  [ -d "$d/node_modules" ] || (cd "$d" && npm install --no-audit --no-fund --loglevel=error >/dev/null) \
    || echo "cloud-session-start: npm install failed in $d"
done
echo "cloud-session-start: npm dependencies ready."
