#!/usr/bin/env bash
#
# Installe les compétences MAISON sur l'instance OpenHands.
#
#   docker/openhands/install-skills.sh
#
# ---------------------------------------------------------------------------
# CE QUE CE SCRIPT NE FAIT PAS, ET POURQUOI
# ---------------------------------------------------------------------------
#
# Il ne clone PAS le registre officiel (github.com/OpenHands/extensions). Ce
# n'est pas un oubli : les 55 compétences du registre sont DÉJÀ embarquées
# dans l'image `openhands` et livrées à chaque conversation. Vérifié sur
# l'instance :
#
#   curl -sS "$OPENHANDS_URL/api/v1/app-conversations/<id>/skills" \
#     | python3 -c 'import json,sys; [print(s["name"]) for s in json.load(sys.stdin)["skills"]]'
#
# On y trouve gitlab, code-review, security, qa-changes,
# evidence-based-citations, agent-memory, skill-creator,
# learn-from-code-review, github-pr-review… Les installer serait au mieux
# redondant, au pire une divergence de version silencieuse entre la copie
# clonée et celle de l'image.
#
# Il ne reste donc à installer que ce qui n'existe pas en amont : nos deux
# compétences GitLab, sous openhands/skills/.
#
# ---------------------------------------------------------------------------
# DEUX EMPLACEMENTS POSSIBLES — LISEZ CECI AVANT DE CHOISIR
# ---------------------------------------------------------------------------
#
# 1. DÉPÔT RELU (--repo <chemin>) : copie dans <dépôt>/.agents/skills/.
#    C'est l'emplacement DOCUMENTÉ en amont pour les « compétences de
#    projet », et le seul dont on ait vérifié qu'il atteint l'agent — les
#    compétences y sont résolues depuis l'espace de travail de la
#    conversation. Elles se versionnent avec le dépôt relu, ce qui les rend
#    visibles de ses mainteneurs. À privilégier.
#
# 2. INSTANCE (--instance) : copie dans le volume monté sur
#    /root/.openhands/microagents, l'emplacement que l'application server lit
#    comme « compétences utilisateur » (USER_SKILLS_DIR dans
#    openhands/app_server/user/skills_router.py). Avantage : vaut pour TOUS
#    les dépôts sans les toucher.
#    ⚠ NON VÉRIFIÉ de bout en bout : ce répertoire alimente à coup sûr la
#    liste rendue par l'API des compétences ; que l'agent du bac à sable les
#    reçoive effectivement dans son contexte n'a PAS été constaté. À valider
#    en lisant /api/v1/app-conversations/<id>/skills après une conversation.
#
# Rien n'empêche les deux : le projet l'emporte sur l'utilisateur à nom égal.

set -eu

cd "$(dirname "$0")/../.."
SOURCE="openhands/skills"
MODE=""
REPO=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) MODE="repo"; REPO="${2:-}"; shift 2 ;;
    --instance) MODE="instance"; shift ;;
    *) echo "usage: $0 --repo <chemin-du-depot> | --instance" >&2; exit 2 ;;
  esac
done

if [ -z "$MODE" ]; then
  echo "usage: $0 --repo <chemin-du-depot> | --instance" >&2
  echo >&2
  echo "  --repo <chemin>  copie dans <chemin>/.agents/skills/ (recommandé, vérifié)" >&2
  echo "  --instance       copie dans le volume de l'instance (global, non vérifié)" >&2
  exit 2
fi

skills=$(find "$SOURCE" -mindepth 1 -maxdepth 1 -type d 2>/dev/null || true)
if [ -z "$skills" ]; then
  echo "aucune compétence dans $SOURCE" >&2
  exit 1
fi

if [ "$MODE" = "repo" ]; then
  [ -n "$REPO" ] || { echo "--repo attend un chemin" >&2; exit 2; }
  [ -d "$REPO/.git" ] || { echo "$REPO n'est pas un dépôt git" >&2; exit 1; }

  target="$REPO/.agents/skills"
  mkdir -p "$target"
  for skill in $skills; do
    name=$(basename "$skill")
    rm -rf "${target:?}/$name"
    cp -R "$skill" "$target/$name"
    # Vérification systématique : une compétence sans SKILL.md est ignorée en
    # silence par OpenHands, ce qui est exactement le genre d'échec qu'on ne
    # remarque qu'en relisant une revue ratée trois jours plus tard.
    [ -f "$target/$name/SKILL.md" ] || { echo "✗ $name : SKILL.md manquant" >&2; exit 1; }
    echo "✓ $target/$name/SKILL.md"
  done
  echo
  echo "Commitez et poussez ces fichiers dans $REPO : l'agent les lit depuis la"
  echo "branche qu'il sort, pas depuis votre disque."
  exit 0
fi

# --instance
CONTAINER="${OPENHANDS_CONTAINER:-cds-openhands}"
docker inspect "$CONTAINER" >/dev/null 2>&1 || {
  echo "conteneur $CONTAINER introuvable — l'instance tourne-t-elle ?" >&2
  exit 1
}

TARGET="/root/.openhands/microagents"
docker exec "$CONTAINER" mkdir -p "$TARGET"
for skill in $skills; do
  name=$(basename "$skill")
  docker exec "$CONTAINER" rm -rf "$TARGET/$name"
  docker cp "$skill" "$CONTAINER:$TARGET/$name"
  docker exec "$CONTAINER" test -f "$TARGET/$name/SKILL.md" \
    || { echo "✗ $name : SKILL.md manquant après copie" >&2; exit 1; }
  echo "✓ $CONTAINER:$TARGET/$name/SKILL.md"
done

echo
echo "⚠ /root/.openhands N'EST PAS le volume persisté (celui-ci est monté sur"
echo "  /.openhands) : cette copie disparaîtra au prochain \`docker compose up\`"
echo "  qui recrée le conteneur. Pour la rendre durable, montez le répertoire"
echo "  dans docker/openhands/docker-compose.yml — voir docs/openhands.md."
echo
echo "Vérifiez que l'agent les reçoit vraiment, après une conversation :"
echo "  curl -sS \"\$OPENHANDS_URL/api/v1/app-conversations/<id>/skills\" \\"
echo "    | python3 -c 'import json,sys; [print(s[\"name\"]) for s in json.load(sys.stdin)[\"skills\"]]'"
