#!/usr/bin/env bash
# Run on the Mac. Prepares the shared "Hobby apps" Claude Code cloud environment (claude.ai/code):
#   1. a `claude-cloud-session` service account that can deploy App Engine, use Firestore,
#      Vertex AI and read Secret Manager in the hobby project;
#   2. each app's gitignored secret files (.env, app.yaml) copied into Secret Manager, labelled
#      with the repo name; cloud-session-start.sh pulls them back into a fresh checkout;
#   3. a new key, copied to the clipboard as the environment's single variable GCP_SA_KEY_B64.
#
#   bash claude-cloud-setup.sh            # everything (rotates the key)
#   bash claude-cloud-setup.sh --secrets  # only re-sync the secret files (after editing a .env)
#
# Secret values are never printed. Re-run after adding an app to APPS.
set -euo pipefail

P=mlsd-2026-483513
NAME=claude-cloud-session
SA="$NAME@$P.iam.gserviceaccount.com"
HOBBY="$HOME/Documents/projects/hobby"

# repo name (as on GitHub) | local checkout | gitignored files to carry over, relative to the checkout
APPS=(
  "shuffle|$HOBBY/shuffle|.env app.yaml"
  "meals|$HOBBY/meals|.env app.yaml"
  "newsfeed|$HOBBY/newsfeed|thoughtstream/.env thoughtstream/app.yaml"
)

sync_secrets() {
  for app in "${APPS[@]}"; do
    IFS='|' read -r repo dir files <<< "$app"
    for f in $files; do
      [ -f "$dir/$f" ] || { echo "skip $repo/$f (missing)"; continue; }
      id="cloudfile-$repo-$(printf '%s' "$f" | tr -c 'a-zA-Z0-9' '-')"
      if ! gcloud secrets describe "$id" --project "$P" >/dev/null 2>&1; then
        gcloud secrets create "$id" --project "$P" --replication-policy automatic \
          --labels "repo=$repo,claude-cloud=file" --set-annotations "path=$f" --format=none
      elif cmp -s "$dir/$f" <(gcloud secrets versions access latest --secret "$id" --project "$P" 2>/dev/null); then
        echo "same $repo/$f"; continue
      fi
      gcloud secrets versions add "$id" --project "$P" --data-file "$dir/$f" --format=none
      echo "sync $repo/$f"
    done
  done
}

if [ "${1:-}" = "--secrets" ]; then sync_secrets; exit 0; fi

gcloud services enable secretmanager.googleapis.com --project "$P"

if ! gcloud iam service-accounts describe "$SA" --project "$P" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$NAME" --project "$P" \
    --display-name "Claude Code cloud sessions (hobby apps: deploy, Firestore, Vertex, secrets)"
fi

# Project-wide roles: this account can deploy any App Engine service and read the whole
# Firestore database. Accepted: the project only holds hobby apps.
for R in appengine.deployer appengine.serviceAdmin appengine.appViewer cloudbuild.builds.editor \
         storage.objectAdmin datastore.user aiplatform.user secretmanager.secretAccessor \
         serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$P" --member "serviceAccount:$SA" \
    --role "roles/$R" --condition=None --format=none >/dev/null 2>&1
done
# Deploying runs the apps as the App Engine default service account.
gcloud iam service-accounts add-iam-policy-binding "$P@appspot.gserviceaccount.com" --project "$P" \
  --member "serviceAccount:$SA" --role roles/iam.serviceAccountUser --format=none >/dev/null 2>&1

sync_secrets

# Rotate: drop old user-managed keys, mint a new one into a temp file, base64 it, delete the file.
for K in $(gcloud iam service-accounts keys list --iam-account "$SA" --managed-by user --format 'value(name)'); do
  gcloud iam service-accounts keys delete "$K" --iam-account "$SA" --quiet
done
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
gcloud iam service-accounts keys create "$TMP" --iam-account "$SA" >/dev/null 2>&1
echo "GCP_SA_KEY_B64=$(base64 < "$TMP" | tr -d '\n')" | pbcopy

echo "Done. GCP_SA_KEY_B64 is on the clipboard: paste it as the Hobby apps environment's only variable."
