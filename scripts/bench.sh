#!/usr/bin/env bash
#
# Banc de mesure multi-modèles, de bout en bout.
#
# Pour chaque ligne « modèle + branche » :
#   1. retrouve la merge request ouverte sur cette branche ;
#   2. efface toutes ses notes — dont la revue du modèle précédent ;
#   3. oublie sa conversation OpenHands (sinon on remesure l'ancien modèle) ;
#   4. poste la demande de revue en mentionnant le bot ;
#   5. aligne l'instance sur le modèle, lance le daemon, attend UNE tâche ;
#   6. relève ce qui a réellement été publié, passe au suivant.
#
#   scripts/bench.sh -f bench-models.txt
#   scripts/bench.sh -n -f bench-models.txt      # à blanc : liste et sort
#
# ---------------------------------------------------------------------------
# LE JETON — UN SEUL SUFFIT
# ---------------------------------------------------------------------------
#
# GITLAB_TOKEN        suffit. Le daemon est lancé ici avec
#                     BENCH_ACCEPT_BOT_NOTES=1, qui lève son garde-fou
#                     anti-boucle — et que buildConfig refuse sans
#                     CDS_MAX_TASKS, donc la boucle reste bornée.
# BENCH_GITLAB_TOKEN  facultatif : un compte humain distinct, plus proche du
#                     réel (les remarques ne sont pas déclenchées par leur
#                     propre auteur). Doit être mainteneur pour effacer les
#                     notes du bot.
#
# ---------------------------------------------------------------------------
# FORMAT DU FICHIER
# ---------------------------------------------------------------------------
#
#   openrouter/z-ai/glm-5.2          bench/glm-5-2
#   openrouter/moonshotai/kimi-k3    bench/kimi-k3
#
# Deux colonnes séparées par des espaces, « # » commente. Une ligne sans
# branche reste acceptée : le banc ne prépare alors rien et consomme le
# premier to-do qui se présente (l'ancien mode, manuel).

set -u

BENCH_DIR="${BENCH_DIR:-bench}"
# Garde-fou de temps par modèle. Sans lui, un modèle qui ne rend jamais la main
# bloquerait le banc. Généreux : OPENHANDS_TIMEOUT_MINUTES borne déjà le
# travail, il reste la marge du démarrage du bac à sable.
MAX_WAIT_SECONDS="${BENCH_MAX_WAIT_SECONDS:-1800}"
HELPER="scripts/bench_gitlab.py"

DRY_RUN=0
# Nombre de tirages par ligne. TROIS par défaut, et ce n'est pas de la
# prudence rituelle : mesuré sur ce projet, qwen3.6 a rendu 3, 4 puis 4
# défauts sur trois tirages STRICTEMENT identiques. Un ecart d'un ou deux
# défauts entre deux runs uniques ne prouve rien du tout.
RUNS="${BENCH_RUNS:-3}"
while [ $# -gt 0 ]; do
  case "${1:-}" in
    -n|--dry-run) DRY_RUN=1; shift ;;
    --runs) RUNS="${2:-3}"; shift 2 ;;
    *) break ;;
  esac
done

[ "${1:-}" = "-f" ] && [ -n "${2:-}" ] || { echo "usage: $0 [-n] -f <fichier>" >&2; exit 2; }

models=(); branches_all=()
while IFS= read -r raw || [ -n "$raw" ]; do
  raw="${raw%%#*}"
  model=$(printf '%s' "$raw" | awk '{print $1}')
  branch=$(printf '%s' "$raw" | awk '{print $2}')
  [ -z "$model" ] && continue
  models+=("$model"); branches_all+=("$branch")
done < "$2"

if [ "${#models[@]}" -eq 0 ]; then
  echo "aucun modèle dans $2" >&2
  exit 2
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "${#models[@]} ligne(s) :"
  for i in "${!models[@]}"; do
    printf '  %2d. %-46s %s\n' "$((i + 1))" "${models[$i]}" \
      "${branches_all[$i]:-<aucune branche : mode manuel>}"
  done
  echo
  echo "Chaque ligne AVEC une branche effacera toutes les notes de sa merge request."
  exit 0
fi

# Contrôle préalable AVANT d'effacer quoi que ce soit : instance OpenHands
# debout, jeton valide, une merge request ouverte par branche. Sans lui, un
# .env non chargé donnait douze échecs identiques et un CSV vide — après coup.
#
# INCONDITIONNEL, y compris sans branche. C'est le mode manuel qui l'a montré :
# il n'efface rien, donc l'ancienne garde `[ -n "$branches" ]` le dispensait de
# tout contrôle — et il consommait quand même un to-do réel contre une instance
# absente. Un tirage brûlé reste un tirage brûlé, qu'il ait effacé ou non.
branches=""
for branch in "${branches_all[@]:-}"; do [ -n "$branch" ] && branches="$branches $branch"; done
echo "Contrôle préalable…"
# shellcheck disable=SC2086
if ! python3 "$HELPER" check $branches; then
  echo "Rien n'a été modifié." >&2
  exit 1
fi
echo

mkdir -p "$BENCH_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
CSV="$BENCH_DIR/$STAMP.csv"
echo "modele,quantification,deployable,branche,tirage,mr,issue,secondes,ligne,fichier,generale,suggestions,competences,conversation" > "$CSV"

echo "Banc de mesure — ${#models[@]} modèle(s) × $RUNS tirage(s), résultats dans $CSV"
echo

for i in "${!models[@]}"; do
 for run in $(seq 1 "$RUNS"); do
  model="${models[$i]}"; branch="${branches_all[$i]}"
  slug="$(printf '%s' "$model" | tr '/:' '--')"
  log="$BENCH_DIR/$STAMP-$slug-$run.log"

  echo "▶ $model  ${branch:+($branch)}  tirage $run/$RUNS"

  if [ -n "$branch" ] && ! python3 "$HELPER" prepare "$branch"; then
    echo "  ⚠ préparation impossible — ligne ignorée"
    printf '%s,,,%s,%s,,preparation-impossible,,,,,,,\n' "$model" "$branch" "$run" >> "$CSV"
    echo
    continue
  fi

  # BENCH_ACCEPT_BOT_NOTES : la demande est postée avec le jeton du bot, il
  # faut donc que le daemon accepte ses propres notes. Borné par
  # CDS_MAX_TASKS=1, sans quoi buildConfig refuse de démarrer.
  CDS_MAX_TASKS=1 BENCH_ACCEPT_BOT_NOTES=1 LOG_PRETTY=1 AGENT_MODEL="$model" \
    npx tsx src/daemon/index.ts > "$log" 2>&1 &
  daemon=$!

  ( sleep "$MAX_WAIT_SECONDS"
    kill -INT "$daemon" 2>/dev/null && sleep 40 && kill -INT "$daemon" 2>/dev/null
  ) & watchdog=$!

  wait "$daemon" 2>/dev/null
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null

  published="{}"
  [ -n "$branch" ] && published=$(python3 "$HELPER" collect "$branch" 2>/dev/null || echo '{}')

  python3 - "$model" "$branch" "$log" "$CSV" "$published" "$run" <<'PY'
import re, os, sys, csv, json, subprocess
model, branch, log_path, csv_path, published, run = sys.argv[1:7]
counts = json.loads(published or "{}")

pattern = re.compile(r"\[worker\] terminé (\S+) — (\S+) en (\d+) s(?: — (\S+))?")
row = None
with open(log_path, encoding="utf-8", errors="replace") as handle:
    for line in handle:
        found = pattern.search(line)
        if found:
            row = found.groups()

issue = row[1] if row else "aucune-tache"
seconds = row[2] if row else ""
url = (row[3] or "") if row else ""

# Les compétences réellement reçues par l'agent : sans cette colonne, un run
# où elles ne se chargent pas est indiscernable d'un run où elles se chargent
# et ne servent à rien.
skills = ""
if url:
    skills = subprocess.run(
        [sys.executable, "scripts/bench_gitlab.py", "skills", url],
        capture_output=True, text=True,
    ).stdout.strip()

# Quantification imposée à OpenRouter pour ce modèle, et si elle correspond à
# sa configuration de déploiement réelle. Lues dans la MÊME table que le daemon
# — les recopier ici les ferait diverger le jour où l'une des deux change.
#
# « libre » = modèle absent de la table : OpenRouter route seul, deux tirages
# peuvent tomber sur deux quantifications différentes. « ? » pour deployable
# n'est PAS « non » : personne ne s'est prononcé.
quant, deployable = "libre", "?"
try:
    table = json.load(open(os.environ.get("QUANTIZATIONS_FILE", "quantizations.json")))
    entry = table.get(model)
    if entry:
        quant = "+".join(entry["quantizations"])
        deployable = "oui" if entry["deployable"] else "non"
except (OSError, ValueError, KeyError, TypeError):
    pass

with open(csv_path, "a", newline="", encoding="utf-8") as handle:
    csv.writer(handle).writerow([
        model, quant, deployable, branch, run, counts.get("iid", ""), issue, seconds,
        counts.get("ligne", ""), counts.get("fichier", ""),
        counts.get("generale", ""), counts.get("suggestions", ""), skills, url,
    ])

if row:
    # Le compte des remarques distingue « a travaillé » de « a rendu la main
    # sans rien publier » — deux cas que le seul statut confondait
    # (gpt-oss : `timeout`, zéro remarque).
    ligne = counts.get("ligne", 0)
    total = ligne + counts.get("fichier", 0) + counts.get("generale", 0)
    print(
        f"  {issue} en {seconds} s — {total} remarque(s), dont {ligne} ancrée(s)"
        + f" — quantif. {quant}" + ("" if deployable == "oui" else f" (déployable : {deployable})")
        + (f" — compétences : {skills}" if skills else "")
    )
else:
    print(f"  ⚠ aucune tâche traitée — voir {log_path}")
PY
  echo
 done
done

echo "Terminé. Résultats : $CSV"
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
