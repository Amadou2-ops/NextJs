#!/usr/bin/env bash
# Test de bout en bout de la chaîne des journaux, sans Docker :
#   fichiers json-file simulés ─▶ Alloy (alloy.alloy) ─▶ Loki (loki.yml) ─▶ règles (loki-rules/)
#
#   deploy/monitoring/tests/journaux.sh <binaire loki> <binaire alloy>
#
# Vérifie : étiquettes service / level / container, filtrage des conteneurs
# hors pile, lignes non JSON conservées, chargement et évaluation des règles
# (une erreur fatale de l'API déclenche JournalErreurFatale).
set -euo pipefail

LOKI_BIN=$(realpath "$1")
ALLOY_BIN=$(realpath "$2")
HERE=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
LOKI_PORT=31100
PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "ÉCHEC : $*" >&2
  echo "--- loki ---" >&2; tail -n 30 "$WORK/loki.log" >&2 || true
  echo "--- alloy ---" >&2; tail -n 30 "$WORK/alloy.log" >&2 || true
  exit 1
}

# Configurations de production, chemins et ports seuls remplacés.
mkdir -p "$WORK/loki" "$WORK/alloy" "$WORK/containers/aaa" "$WORK/containers/bbb" "$WORK/containers/ccc"
sed -e "s#directory: /etc/loki/rules#directory: $HERE/loki-rules#" \
    -e "s#: /loki#: $WORK/loki#g" \
    -e "s#http_listen_port: 3100#http_listen_port: $LOKI_PORT#" \
    -e "s#grpc_listen_port: 9095#grpc_listen_port: 39095#" \
    -e "s#evaluation_interval: 1m#evaluation_interval: 5s#" \
    "$HERE/loki.yml" > "$WORK/loki.yml"
sed -e "s#/var/lib/docker/containers#$WORK/containers#" \
    -e "s#http://loki:3100#http://127.0.0.1:$LOKI_PORT#" \
    -e 's#sync_period  = "10s"#sync_period  = "1s"#' \
    "$HERE/alloy.alloy" > "$WORK/alloy.alloy"

env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy "$LOKI_BIN" -config.file="$WORK/loki.yml" > "$WORK/loki.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$LOKI_PORT/ready" > /dev/null && break
  sleep 1
done
curl -sf "http://127.0.0.1:$LOKI_PORT/ready" > /dev/null || fail "Loki ne démarre pas"

# Fichiers présents avant Alloy (lecture depuis la fin : rien de rejoué).
: > "$WORK/containers/aaa/aaa-json.log"
: > "$WORK/containers/bbb/bbb-json.log"
: > "$WORK/containers/ccc/ccc-json.log"
env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy "$ALLOY_BIN" run --storage.path="$WORK/alloy" --server.http.listen-addr=127.0.0.1:32345 "$WORK/alloy.alloy" > "$WORK/alloy.log" 2>&1 &
PIDS+=($!)
sleep 5

now() { date -u +%Y-%m-%dT%H:%M:%S.%NZ; }
attrs() { printf '{"com.docker.compose.project":"%s","com.docker.compose.service":"%s","tag":"%s"}' "$1" "$2" "$3"; }
{
  printf '{"log":"{\\"level\\":\\"error\\",\\"service\\":\\"transfertplus-api\\",\\"msg\\":\\"erreur de test\\"}\\n","stream":"stdout","time":"%s","attrs":%s}\n' "$(now)" "$(attrs transfertplus api transfertplus-api-1)"
  printf '{"log":"{\\"level\\":\\"fatal\\",\\"service\\":\\"transfertplus-api\\",\\"msg\\":\\"arrêt de test\\"}\\n","stream":"stdout","time":"%s","attrs":%s}\n' "$(now)" "$(attrs transfertplus api transfertplus-api-1)"
} >> "$WORK/containers/aaa/aaa-json.log"
printf '{"log":"secret d un autre projet\\n","stream":"stdout","time":"%s","attrs":%s}\n' "$(now)" "$(attrs autre-projet api autre-api-1)" >> "$WORK/containers/bbb/bbb-json.log"
printf '{"log":"ligne texte de caddy\\n","stream":"stderr","time":"%s","attrs":%s}\n' "$(now)" "$(attrs transfertplus caddy transfertplus-caddy-1)" >> "$WORK/containers/ccc/ccc-json.log"

query() {
  curl -sfG "http://127.0.0.1:$LOKI_PORT/loki/api/v1/query_range" \
    --data-urlencode "query=$1" --data-urlencode "since=10m" --data-urlencode "limit=100"
}

found=""
for _ in $(seq 1 30); do
  found=$(query '{service="api", level="fatal"}' || true)
  grep -q "arrêt de test" <<< "$found" && break
  sleep 1
done
grep -q "arrêt de test" <<< "$found" || fail "ligne fatale de l'API absente de Loki"
grep -q '"container":"transfertplus-api-1"' <<< "$found" || fail "étiquette container absente"
grep -q '"environment":"production"' <<< "$found" || fail "étiquette environment absente"

query '{service="api", level="error"}' | grep -q "erreur de test" || fail "ligne d'erreur de l'API absente"
caddy=$(query '{service="caddy"}')
grep -q "ligne texte de caddy" <<< "$caddy" || fail "ligne texte (non JSON) perdue"
grep -q '"level"' <<< "$caddy" && fail "niveau inventé pour une ligne non JSON"
query '{environment="production"}' | grep -q "autre projet" && fail "conteneur hors pile collecté"
query '{service=~".+"}' | grep -q '"filename"' && fail "étiquette filename conservée (cardinalité)"

# Règles chargées et évaluées : l'erreur fatale déclenche l'alerte.
state=""
for _ in $(seq 1 30); do
  state=$(curl -sf "http://127.0.0.1:$LOKI_PORT/prometheus/api/v1/rules" || true)
  grep -q '"name":"JournalErreurFatale","query":[^}]*"state":"firing"' <<< "$state" && break
  sleep 1
done
for rule in JournauxErreursEnRafale JournalErreurFatale TacheEnEchecJournalisee; do
  grep -q "\"name\":\"$rule\"" <<< "$state" || fail "règle $rule non chargée : $state"
done
grep -q '"health":"err' <<< "$state" && fail "règle en erreur d'évaluation : $state"
curl -sf "http://127.0.0.1:$LOKI_PORT/prometheus/api/v1/alerts" | grep -q '"alertname":"JournalErreurFatale"' || fail "JournalErreurFatale non déclenchée"

echo "Chaîne des journaux : OK"
