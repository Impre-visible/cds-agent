#!/usr/bin/env bash
#
# Banc de mesure multi-modèles.
#
# Enchaîne les modèles : pour chacun, aligne l'instance OpenHands dessus,
# lance le daemon, attend qu'UNE tâche se termine, l'arrête proprement, passe
# au suivant. Écrit une ligne de CSV par modèle et un journal complet par
# modèle.
#
#   scripts/bench.sh openrouter/qwen/qwen3.6-35b-a3b openrouter/openai/gpt-oss-120b
#   scripts/bench.sh -f bench-models.txt          # un modèle par ligne, # = commentaire
#
# CE QUE VOUS DEVEZ FAIRE AVANT DE LE LANCER, et qu'il ne peut pas faire à
# votre place : poster les mentions. Le daemon est piloté par les to-dos
# GitLab, et un to-do n'existe que si un HUMAIN AUTORISÉ mentionne le bot —
# une note postée avec le jeton du bot serait ignorée par ses propres filtres
# (voir daemon/request.ts). Postez donc « @<bot> review » sur autant de merge
# requests que de modèles à tester, AVANT de lancer ce script. Chaque
# exécution du daemon en consommera exactement une, dans l'ordre où GitLab
# les rend.
#
# Une merge request DIFFÉRENTE par modèle, et ce n'est pas un détail : sur la
# même MR, le deuxième modèle lirait les remarques du premier — le dépôt de
# test porte donc plusieurs copies de la même MR, une par modèle.
#
# Variables reprises telles quelles du .env : tout sauf AGENT_MODEL, que ce
# script impose modèle par modèle.

set -u

BENCH_DIR="${BENCH_DIR:-bench}"
# Garde-fou de temps par modèle. Sans lui, un modèle qui ne reçoit jamais de
# to-do (mention oubliée, quota GitLab, réseau coupé) bloquerait le banc pour
# toujours. Généreux : OPENHANDS_TIMEOUT_MINUTES borne déjà le travail lui-même
# (10 min par défaut), il reste de la marge pour le démarrage du bac à sable.
MAX_WAIT_SECONDS="${BENCH_MAX_WAIT_SECONDS:-1800}"

models=()
if [ "${1:-}" = "-f" ]; then
  [ -n "${2:-}" ] || { echo "usage: $0 -f <fichier>" >&2; exit 2; }
  while IFS= read -r line; do
    line="${line%%#*}"                      # commentaire en fin de ligne
    line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [ -n "$line" ] && models+=("$line")
  done < "$2"
else
  models=("$@")
fi

if [ "${#models[@]}" -eq 0 ]; then
  echo "usage: $0 <modele> [modele...]   |   $0 -f <fichier>" >&2
  exit 2
fi

mkdir -p "$BENCH_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
CSV="$BENCH_DIR/$STAMP.csv"
echo "modele,cle,merge_request,issue,secondes,conversation" > "$CSV"

echo "Banc de mesure — ${#models[@]} modèle(s), résultats dans $CSV"
echo "Rappel : une mention « @<bot> review » doit déjà attendre sur une MR distincte par modèle."
echo

for model in "${models[@]}"; do
  slug="$(printf '%s' "$model" | tr '/:' '--')"
  log="$BENCH_DIR/$STAMP-$slug.log"

  echo "▶ $model"

  # CDS_MAX_TASKS=1 : le daemon s'arrête tout seul, proprement, dès qu'une
  # tâche est terminée — c'est ce qui remplace le Ctrl-C au bon moment.
  # LOG_PRETTY=1 : le journal reste lisible par un humain qui relit après coup.
  CDS_MAX_TASKS=1 LOG_PRETTY=1 AGENT_MODEL="$model" \
    npx tsx src/daemon/index.ts > "$log" 2>&1 &
  daemon=$!

  # Chien de garde : si le daemon n'a pas rendu la main dans le délai, on lui
  # envoie un SIGINT (arrêt gracieux, la tâche en cours a encore sa chance),
  # puis un second s'il s'obstine.
  ( sleep "$MAX_WAIT_SECONDS"
    kill -INT "$daemon" 2>/dev/null && sleep 40 && kill -INT "$daemon" 2>/dev/null
  ) & watchdog=$!

  wait "$daemon" 2>/dev/null
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null

  # Extraction depuis le journal plutôt que depuis un code de retour : c'est
  # la ligne de fin de tâche qui porte l'issue, la durée et l'adresse de la
  # conversation, et elle a le même format en JSON comme en mode lisible.
  python3 - "$model" "$log" "$CSV" <<'PY'
import re, sys, csv
model, log_path, csv_path = sys.argv[1:4]
pattern = re.compile(
    r"\[worker\] terminé (\S+) — (\S+) en (\d+) s(?: — (\S+))?"
)
row = None
with open(log_path, encoding="utf-8", errors="replace") as handle:
    for line in handle:
        match = pattern.search(line)
        if match:
            row = match.groups()

mr = ""
if row:
    # La clé porte la MR dans les lignes de corrélation ; on la relit dans le
    # journal plutôt que de la reconstruire.
    with open(log_path, encoding="utf-8", errors="replace") as handle:
        found = re.search(r"\[" + re.escape(row[0]) + r" (\S+!\d+)\]", handle.read())
    mr = found.group(1) if found else ""

with open(csv_path, "a", newline="", encoding="utf-8") as handle:
    writer = csv.writer(handle)
    if row:
        writer.writerow([model, row[0], mr, row[1], row[2], row[3] or ""])
        print(f"  {row[1]} en {row[2]} s — {mr}")
    else:
        # Aucune tâche traitée : mention manquante, chien de garde, ou panne.
        # Une ligne quand même — un trou silencieux dans un CSV de mesure est
        # pire qu'un trou nommé.
        writer.writerow([model, "", "", "aucune-tache", "", ""])
        print(f"  ⚠ aucune tâche traitée — voir {log_path}")
PY
  echo
done

echo "Terminé. Résultats : $CSV"
# `column -s, -t` écrase les champs vides et décale les colonnes : sur un CSV
# de mesure où « pas de valeur » EST une information, c'est un affichage qui
# ment. On formate donc à la main.
python3 - "$CSV" <<'PY'
import csv, sys
rows = list(csv.reader(open(sys.argv[1], encoding="utf-8")))
if not rows: sys.exit()
widths = [max(len(r[i]) if i < len(r) else 0 for r in rows) for i in range(len(rows[0]))]
for index, row in enumerate(rows):
    cells = [(row[i] if i < len(row) else "").ljust(widths[i]) for i in range(len(widths))]
    print("  " + " | ".join(cells).rstrip())
    if index == 0:
        print("  " + "-+-".join("-" * w for w in widths))
PY
