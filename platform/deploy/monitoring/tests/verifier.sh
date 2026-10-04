#!/usr/bin/env bash
# Vérification complète de la configuration de surveillance (CI et poste local) :
#
#   deploy/monitoring/tests/verifier.sh <répertoire des binaires>
#
# Le répertoire contient promtool, amtool, loki et alloy (versions des images
# de compose.production.yaml). Contrôles :
#   1. syntaxe de prometheus.yml, alerts.yml, alertmanager.yml, loki.yml, alloy.alloy ;
#   2. tests unitaires des règles d'alerte (alerts.test.yml) ;
#   3. requêtes PromQL du tableau Grafana ;
#   4. chaîne des journaux de bout en bout (tests/journaux.sh).
set -euo pipefail

BIN=$(realpath "$1")
HERE=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$HERE"

echo "== Prometheus"
"$BIN/promtool" check config prometheus.yml
"$BIN/promtool" test rules alerts.test.yml

echo "== Alertmanager"
"$BIN/amtool" check-config alertmanager.yml

echo "== Loki"
"$BIN/loki" -config.file=loki.yml -verify-config

echo "== Alloy"
"$BIN/alloy" validate alloy.alloy
# Mise en forme canonique : un écart signale une édition à reformater (alloy fmt -w).
"$BIN/alloy" fmt alloy.alloy | diff -u alloy.alloy -

echo "== Tableau Grafana"
python3 - "$WORK/tableau.rules.yml" <<'EOF'
import json, sys
dashboard = json.load(open("grafana/dashboards/exploitation.json"))
rules = []
for panel in dashboard["panels"]:
    for target in panel.get("targets", []):
        if target["datasource"]["uid"] not in ("prometheus", "loki"):
            sys.exit(f"source inconnue dans « {panel['title']} »")
        if target["datasource"]["uid"] == "prometheus":
            rules.append({"record": f"tableau:requete_{len(rules)}", "expr": target["expr"]})
json.dump({"groups": [{"name": "tableau", "rules": rules}]}, open(sys.argv[1], "w"))
print(f"{len(rules)} requêtes PromQL")
EOF
"$BIN/promtool" check rules "$WORK/tableau.rules.yml"

echo "== Chaîne des journaux"
tests/journaux.sh "$BIN/loki" "$BIN/alloy"
