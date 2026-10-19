#!/usr/bin/env bash
# SessionStart hook for Claude Code cloud sessions in the shared "Hobby apps" environment
# (no-op locally). Copy to <repo>/.claude/cloud-session-start.sh and register it in
# <repo>/.claude/settings.json. On a fresh cloud VM it:
#   - installs gcloud if the environment's setup script didn't already
#   - logs gcloud and Google client libraries in as claude-cloud-session (from GCP_SA_KEY_B64)
#   - restores this repo's gitignored secret files (.env, app.yaml) from Secret Manager
#   - installs npm dependencies (npm ci, so lockfiles stay untouched) wherever node_modules is missing
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
  # The cloud VM sets an access token that overrides any gcloud login; drop it so the service account is used.
  unset CLOUDSDK_AUTH_ACCESS_TOKEN
  KEY=/root/.config/gcp-sa.json
  mkdir -p "$(dirname "$KEY")"
  (umask 077 && echo "$GCP_SA_KEY_B64" | base64 -d > "$KEY")
  # Outbound traffic goes through Anthropic's proxy; trust the system CA bundle like curl does.
  [ -f /etc/ssl/certs/ca-certificates.crt ] && gcloud config set core/custom_ca_certs_file /etc/ssl/certs/ca-certificates.crt -q 2>/dev/null
  gcloud auth activate-service-account --key-file "$KEY" -q 2>/dev/null || echo "cloud-session-start: gcloud login with GCP_SA_KEY_B64 failed"
  gcloud config set project "$P" -q 2>/dev/null
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "unset CLOUDSDK_AUTH_ACCESS_TOKEN" >> "$CLAUDE_ENV_FILE"
    echo "export GOOGLE_APPLICATION_CREDENTIALS=$KEY" >> "$CLAUDE_ENV_FILE"
    echo "export GOOGLE_CLOUD_PROJECT=$P" >> "$CLAUDE_ENV_FILE"
  fi

  repo=$(basename "$(git remote get-url origin)" .git | tr 'A-Z' 'a-z')
  restored=""
  paths=$(gcloud secrets versions access latest --secret "cloudfiles-$repo" 2>&1) \
    || { echo "cloud-session-start: cannot read secret cloudfiles-$repo: $(echo "$paths" | tail -1)"; paths=""; }
  for path in $paths; do
    id="cloudfile-$repo-$(printf '%s' "$path" | tr -c 'a-zA-Z0-9' '-')"
    mkdir -p "$(dirname "$path")"
    (umask 077 && gcloud secrets versions access latest --secret "$id" > "$path") && restored="$restored $path"
  done
  echo "cloud-session-start: gcloud account $(gcloud config get account 2>/dev/null); restored:${restored:- nothing}."
fi

for lock in $(git ls-files '*package-lock.json'); do
  d=$(dirname "$lock")
  [ -d "$d/node_modules" ] || (cd "$d" && npm ci --no-audit --no-fund --loglevel=error >/dev/null) \
    || echo "cloud-session-start: npm install failed in $d"
done
echo "cloud-session-start: npm dependencies ready."
