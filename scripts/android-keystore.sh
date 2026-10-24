#!/usr/bin/env bash
# Creates the Android release signing key, once, and shows how to give it to CI.
#
#   scripts/android-keystore.sh                          # create the key in ~/.road-trip-mix
#   scripts/android-keystore.sh --set-github-secrets flintstrike-nz/road-trip-mix
#       creates the key if needed, then stores it as the repository's GitHub secrets
#       (needs the GitHub CLI signed in). Safe to re-run: an existing key is reused, never replaced.
#   scripts/android-keystore.sh --dir /safe/place
#
# Why a fixed key matters: Android only installs an update over an existing app if both APKs
# are signed with the same key, and Spotify's App Remote identifies the app by that key's
# SHA-1 fingerprint. A new key per build would break both. BACK THIS FILE UP somewhere safe
# (a password manager): if it's lost, everyone has to uninstall and reinstall.
set -euo pipefail

DIR="$HOME/.road-trip-mix"
REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --set-github-secrets) REPO="$2"; shift 2 ;;
    -h|--help) sed -n 2,16p "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

command -v keytool >/dev/null || { echo "keytool not found: install a JDK (17 or newer)." >&2; exit 1; }

KEYSTORE="$DIR/road-trip-mix-release.jks"
ENVFILE="$DIR/rtm-signing.env"
ALIAS="roadtripmix"

b64() { base64 <"$KEYSTORE" | tr -d '\n'; }

push_secrets() {
  command -v gh >/dev/null || { echo "gh (GitHub CLI) not found: install it and sign in with 'gh auth login', or set the secrets by hand." >&2; exit 1; }
  # shellcheck disable=SC1090
  . "$ENVFILE"
  b64 | gh secret set ANDROID_KEYSTORE_BASE64 -R "$REPO"
  printf %s "$RTM_KEYSTORE_PASSWORD" | gh secret set ANDROID_KEYSTORE_PASSWORD -R "$REPO"
  printf %s "$RTM_KEY_ALIAS" | gh secret set ANDROID_KEY_ALIAS -R "$REPO"
  printf %s "$RTM_KEY_PASSWORD" | gh secret set ANDROID_KEY_PASSWORD -R "$REPO"
  echo "Stored 4 secrets on $REPO. The next merge to main publishes a release signed with this key."
}

if [ -e "$KEYSTORE" ]; then
  if [ -n "$REPO" ] && [ -f "$ENVFILE" ]; then
    echo "Using the existing key at $KEYSTORE"
    push_secrets
    exit 0
  fi
  echo "Refusing to overwrite $KEYSTORE" >&2
  echo "Replacing the signing key would stop every installed copy from updating." >&2
  echo "To store the existing key as GitHub secrets, add: --set-github-secrets OWNER/REPO" >&2
  exit 1
fi

umask 077
mkdir -p "$DIR"

# PKCS12 keystores use one password for the store and the key.
# (head closes the pipe early, so tr gets SIGPIPE; `|| true` stops pipefail treating that as an error.)
PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 28 || true)"
[ "${#PASSWORD}" -eq 28 ] || { echo "Couldn't generate a password." >&2; exit 1; }

keytool -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 \
  -alias "$ALIAS" -keyalg RSA -keysize 4096 -validity 36500 \
  -storepass "$PASSWORD" -keypass "$PASSWORD" \
  -dname "CN=Road Trip Mix, O=Road Trip Mix" >/dev/null

cat >"$ENVFILE" <<ENV
# Source this to sign local builds:  set -a; . $ENVFILE; set +a
RTM_KEYSTORE_PATH=$KEYSTORE
RTM_KEYSTORE_PASSWORD=$PASSWORD
RTM_KEY_ALIAS=$ALIAS
RTM_KEY_PASSWORD=$PASSWORD
ENV

echo
echo "Created $KEYSTORE"
echo "Passwords saved to $ENVFILE (readable only by you). Back both files up somewhere safe."
echo
echo "Certificate fingerprints. Register the SHA-1 with your Spotify app (Android settings):"
keytool -list -v -keystore "$KEYSTORE" -storepass "$PASSWORD" -alias "$ALIAS" | grep -E "SHA1:|SHA256:" | sed 's/^[[:space:]]*/  /'
echo

if [ -n "$REPO" ]; then
  push_secrets
else
  echo "Next: store it as GitHub secrets so CI can sign releases:"
  echo "  $0 --set-github-secrets OWNER/REPO"
  echo "or add these repository secrets by hand (Settings > Secrets and variables > Actions):"
  echo "  ANDROID_KEYSTORE_BASE64    base64 < $KEYSTORE | tr -d '\\n'"
  echo "  ANDROID_KEYSTORE_PASSWORD  RTM_KEYSTORE_PASSWORD from $ENVFILE"
  echo "  ANDROID_KEY_ALIAS          $ALIAS"
  echo "  ANDROID_KEY_PASSWORD       RTM_KEY_PASSWORD from $ENVFILE"
fi
