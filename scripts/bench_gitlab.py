#!/usr/bin/env python3
"""Préparation et relevé d'une merge request de mesure.

Deux sous-commandes, appelées par scripts/bench.sh :

  prepare <branche>   remet la MR à zéro et poste la demande de revue
  collect  <branche>  compte ce que le bot a réellement publié

UN SEUL JETON SUFFIT. Le daemon rejette normalement les notes écrites par le
bot lui-même (`note.author.id === bot.id`, src/daemon/request.ts) : garde-fou
anti-boucle. scripts/bench.sh lance le daemon avec BENCH_ACCEPT_BOT_NOTES=1,
qui le lève — et que buildConfig refuse sans CDS_MAX_TASKS, donc la boucle
reste bornée. La demande peut donc être postée avec GITLAB_TOKEN.

BENCH_GITLAB_TOKEN reste accepté si vous préférez un compte humain distinct
(plus proche du réel : les remarques ne sont pas déclenchées par leur propre
auteur). Il doit alors être mainteneur pour effacer les notes du bot.

CE QUE `prepare` EFFACE, ET POURQUOI. Toutes les notes non système de la MR :
les demandes des runs précédents, et surtout les remarques du modèle
précédent. Sans ça, le modèle suivant lit la revue de son prédécesseur et ne
mesure plus rien — c'est le biais qui a imposé une MR par modèle jusqu'ici, et
que ce nettoyage remplace. Les réactions emoji du bot partent aussi : elles
survivraient à la suppression des notes et fausseraient la lecture.
"""

import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def now_iso():
    """Même forme que les horodatages écrits par le daemon (Date#toISOString) :
    UTC, millisecondes, suffixe Z. Le journal est relu par du code TypeScript,
    pas seulement par des yeux humains."""
    stamp = datetime.datetime.now(datetime.timezone.utc)
    return stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")

def load_dotenv(path=".env"):
    """Charge .env, comme le fait le daemon.

    Sans ça, ce script ne voyait AUCUNE variable : le daemon lit .env lui-même
    (loadDotEnv, src/config.ts) mais ce helper tourne dans un autre process,
    et scripts/bench.sh ne lui passe que ce qu'il a dans son environnement —
    c'est-à-dire rien quand on lance `npm run bench` depuis un shell propre.

    Mêmes règles que loadDotEnv, au caractère près, pour qu'une valeur ne soit
    jamais lue différemment des deux côtés : commentaires et lignes vides
    ignorés, découpe au PREMIER `=`, guillemets simples ou doubles retirés, et
    surtout une variable DÉJÀ dans l'environnement n'est jamais écrasée — c'est
    ce qui permet à `BENCH_PROJECT=x npm run bench` de primer sur le fichier.

    CDS_SKIP_DOTENV=1 la désactive, comme pour le daemon.
    """
    if os.environ.get("CDS_SKIP_DOTENV") == "1":
        return
    file = Path(path)
    if not file.exists():
        return
    for raw in file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


load_dotenv()

GITLAB_URL = os.environ.get("GITLAB_URL", "https://gitlab.com").rstrip("/")
BOT = os.environ.get("BOT_USERNAME", "")
BOT_TOKEN = os.environ.get("GITLAB_TOKEN", "")
# Le jeton du bot suffit : le daemon est lancé avec BENCH_ACCEPT_BOT_NOTES=1,
# qui lève son garde-fou anti-boucle le temps du banc (voir bench.sh).
# BENCH_GITLAB_TOKEN reste accepté pour qui préfère un compte humain distinct —
# c'est alors LUI qui doit être mainteneur pour effacer les notes du bot.
HUMAN_TOKEN = os.environ.get("BENCH_GITLAB_TOKEN") or BOT_TOKEN
STATE_FILE = os.environ.get("STATE_FILE", "./state/processed.jsonl")
# L'instance qui exécute réellement le travail. Même source que le daemon
# (config.ts) : sans elle, le banc efface des merge requests pour rien.
OPENHANDS_URL = os.environ.get("OPENHANDS_URL", "").rstrip("/")
OPENHANDS_API_KEY = os.environ.get("OPENHANDS_API_KEY", "")
REQUEST_TEXT = os.environ.get(
    "BENCH_REQUEST", "@{bot} Review ca s'il te plait."
)


def api(path, token, method="GET", form=None):
    url = f"{GITLAB_URL}/api/v4{path}"
    data = urllib.parse.urlencode(form).encode() if form else None
    request = urllib.request.Request(
        url, data=data, method=method, headers={"PRIVATE-TOKEN": token}
    )
    with urllib.request.urlopen(request) as response:
        body = response.read().decode()
        return json.loads(body) if body.strip() else None


def project_path():
    """Le dépôt visé. Lu dans projects.json quand il n'y en a qu'un — sinon
    il faut le dire, on ne devine pas sur quel dépôt on va effacer des notes."""
    explicit = os.environ.get("BENCH_PROJECT")
    if explicit:
        return explicit
    file = Path(os.environ.get("PROJECTS_FILE", "./projects.json"))
    projects = list(json.loads(file.read_text()).get("projects", {}))
    if len(projects) != 1:
        sys.exit(
            f"{len(projects)} dépôts dans {file} : précisez BENCH_PROJECT "
            "(le script efface des commentaires, il ne devine pas lequel)"
        )
    return projects[0]


def find_merge_request(project, branch):
    encoded = urllib.parse.quote(project, safe="")
    query = urllib.parse.urlencode(
        {"source_branch": branch, "state": "opened", "per_page": 100}
    )
    found = api(f"/projects/{encoded}/merge_requests?{query}", HUMAN_TOKEN or BOT_TOKEN)
    if not found:
        sys.exit(f"aucune merge request ouverte sur la branche {branch}")
    if len(found) > 1:
        sys.exit(
            f"{len(found)} merge requests ouvertes sur {branch} : "
            "ambiguïté, fermez-en une"
        )
    return found[0]["iid"]


def wipe(project, iid):
    """Efface toutes les notes non système, et les réactions du bot."""
    encoded = urllib.parse.quote(project, safe="")
    removed = 0

    discussions = api(
        f"/projects/{encoded}/merge_requests/{iid}/discussions?per_page=100",
        HUMAN_TOKEN,
    )
    for discussion in discussions or []:
        for note in discussion.get("notes", []):
            if note.get("system"):
                continue
            try:
                api(
                    f"/projects/{encoded}/merge_requests/{iid}/notes/{note['id']}",
                    HUMAN_TOKEN,
                    method="DELETE",
                )
                removed += 1
            except urllib.error.HTTPError as error:
                # 403 : la note appartient à quelqu'un d'autre et le jeton
                # n'est pas mainteneur. On le dit — une MR partiellement
                # nettoyée fausse la mesure en silence.
                print(
                    f"    ⚠ note {note['id']} non supprimée ({error.code}) — "
                    "le compte de BENCH_GITLAB_TOKEN doit être mainteneur",
                    file=sys.stderr,
                )

    # Les réactions survivent à la suppression des notes qui les portaient
    # quand elles sont posées sur la MR elle-même (voir daemon/index.ts).
    for award in api(
        f"/projects/{encoded}/merge_requests/{iid}/award_emoji?per_page=100", BOT_TOKEN
    ) or []:
        if award["user"]["username"] == BOT:
            try:
                api(
                    f"/projects/{encoded}/merge_requests/{iid}/award_emoji/{award['id']}",
                    BOT_TOKEN,
                    method="DELETE",
                )
            except urllib.error.HTTPError:
                pass
    return removed


def forget_conversation(project, iid):
    """Oublie la conversation OpenHands de cette MR.

    Sans ça, la relance REPREND la conversation du modèle précédent — qui
    garde son modèle ET son historique. On mesurerait l'ancien, avec en prime
    la revue précédente dans son contexte. Même clé que
    openhands/conversations.ts."""
    registry = Path(STATE_FILE).parent / "conversations.json"
    if not registry.exists():
        return False
    try:
        entries = json.loads(registry.read_text())
    except ValueError:
        return False
    if entries.pop(f"{project.lower()}!{iid}", None) is None:
        return False
    registry.write_text(json.dumps(entries, indent=2))
    return True


def forget_requests(project, iid):
    """Retire du journal d'idempotence les demandes de cette MR.

    Le daemon refuse de retraiter une demande déjà `done` : sans ce ménage,
    la nouvelle demande serait bien créée mais ignorée si elle réutilisait une
    clé vue. Les clés portent l'identifiant de note, qui change à chaque
    nouvelle demande — c'est donc une ceinture, pas une bretelle, mais le
    fichier grossit sinon indéfiniment au fil des runs."""
    path = Path(STATE_FILE)
    if not path.exists():
        return
    kept = [
        line
        for line in path.read_text().splitlines()
        if line.strip() and f'"{project.lower()}!{iid}"' not in line.lower()
    ]
    path.write_text("\n".join(kept) + ("\n" if kept else ""))


def purge_todos(project):
    """Marque « done » les to-dos EN ATTENTE du bot sur ce dépôt.

    LE BANC NE CIBLE PAS SA PROPRE DEMANDE. Il poste une mention, puis lance
    un daemon borné à une tâche — et ce daemon sert le PREMIER to-do venu, pas
    celui que le banc vient de créer. Tant qu'aucun reliquat ne traîne, les
    deux coïncident et personne ne voit le problème.

    Observé le 4 août 2026 : une campagne interrompue avait laissé des to-dos
    en attente. Le tirage suivant, étiqueté gpt-oss-120b / branche
    bench/gpt-oss-120b / MR !9, a relu la MR !13 — pendant que sa propre
    demande restait en file, jamais servie (CDS_MAX_TASKS=1 arrête après la
    première). `collect` lisait ensuite !9, n'y trouvait rien, et écrivait
    « 0 remarque » pour un modèle qui avait travaillé ailleurs. Une mesure
    fausse qui se lit comme une mesure.

    Appelée AVANT de poster la demande, sinon elle effacerait celle-ci.

    Bornée au dépôt visé : les to-dos d'un autre dépôt n'appartiennent pas au
    banc, et le daemon ne les servirait de toute façon pas s'il n'est pas
    configuré pour. Même champ que le daemon (`todo.project.path_with_namespace`,
    voir src/types.ts) — pas de devinette sur la forme de la réponse.

    DEUX GESTES, ET LES DEUX SONT NÉCESSAIRES.

    Marquer le to-do « done » côté GitLab ne suffit PAS : `collectTodos()`
    (src/daemon/todos.ts) ramasse les `pending` ET les `done` récents, dans une
    fenêtre de rattrapage de `lookbackMs`. Un to-do qu'on vient de résoudre
    tombe pile dedans — il serait repêché aussitôt.

    Ce qui fait vraiment sauter une demande, c'est son statut dans le journal
    d'idempotence : `canProcess()` (src/daemon/store.ts) ne laisse passer que
    `undefined`, `claimed` et `acked`. On y écrit donc `done`, statut terminal
    qu'aucune écriture ultérieure ne peut faire régresser.

    L'inverse ne suffit pas non plus : sans le geste GitLab, la liste des
    to-dos en attente ne désenfle jamais et chaque tirage repaie leur lecture."""
    purged = 0
    lines = []
    for todo in api("/todos?state=pending&per_page=100", BOT_TOKEN) or []:
        if (todo.get("project") or {}).get("path_with_namespace") != project:
            continue
        match = re.search(r"#note_(\d+)", todo.get("target_url", ""))
        if match:
            lines.append(
                json.dumps(
                    {
                        "key": f"note:{match.group(1)}",
                        "todoId": todo["id"],
                        "status": "done",
                        "at": now_iso(),
                        "reason": "reliquat écarté par le banc avant un tirage",
                    }
                )
            )
        try:
            api(f"/todos/{todo['id']}/mark_as_done", BOT_TOKEN, method="POST")
        except urllib.error.HTTPError:
            # 304 quand il est déjà done, 404 s'il a disparu : sans
            # conséquence, le but est qu'il ne soit plus en attente.
            pass
        purged += 1

    if lines:
        path = Path(STATE_FILE)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as handle:
            handle.write("\n".join(lines) + "\n")
    return purged


def skills_of(conversation_url):
    """Les compétences maison que l'agent a RÉELLEMENT reçues.

    Le seul moyen de savoir si le montage `microagents` atteint le bac à
    sable, plutôt que de le supposer. Sans cette colonne, un run où les
    compétences ne se chargent pas est indiscernable d'un run où elles se
    chargent et ne servent à rien — deux conclusions opposées."""
    base = os.environ.get("OPENHANDS_URL", "http://127.0.0.1:3000").rstrip("/")
    ident = conversation_url.rstrip("/").rsplit("/", 1)[-1]
    if not ident:
        return ""
    request = urllib.request.Request(f"{base}/api/v1/app-conversations/{ident}/skills")
    key = os.environ.get("OPENHANDS_API_KEY")
    if key:
        request.add_header("X-Session-API-Key", key)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            names = {s.get("name") for s in json.load(response).get("skills", [])}
    except Exception:
        return "?"
    ours = {"gitlab-mr-review", "gitlab-conversations", "revue-methode"}
    return "+".join(sorted(ours & names)) or "aucune"


def openhands_get(path, timeout=15):
    """GET sur l'instance OpenHands. Rend (code, corps). Ne lève pas sur 4xx/5xx."""
    request = urllib.request.Request(f"{OPENHANDS_URL}{path}")
    if OPENHANDS_API_KEY:
        request.add_header("X-Session-API-Key", OPENHANDS_API_KEY)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode(errors="replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode(errors="replace")


def check_openhands():
    """L'instance répond, et c'est BIEN OpenHands qui répond.

    Les deux moitiés comptent, et la seconde a été apprise à la dure : le
    4 août 2026, un autre projet local écoutait sur le port 3000 pendant que
    `cds-openhands` était mort (Exited 137). Le banc a effacé trois merge
    requests et lancé trois daemons avant que quiconque s'en aperçoive — les
    404 venaient d'un backend Express, pas d'OpenHands.

    D'où le contrôle en deux temps :

      1. `/health` doit rendre `OK`. Un serveur étranger qui renvoie 404 ou
         autre chose tombe ici.
      2. une VRAIE route de l'API doit rendre du JSON. C'est ce qui distingue
         l'API d'OpenHands d'une application web quelconque qui servirait sa
         page d'accueil sur n'importe quel chemin — y compris OpenHands
         lui-même, dont le frontend répond en HTML, avec un 200, sur les
         chemins d'API qui n'existent pas.

    `app-conversations/search` est relevée dans le journal d'accès de
    l'instance (`GET /api/v1/app-conversations/search?limit=10 → 200 OK`),
    pas devinée. Elle est en lecture seule."""
    if not OPENHANDS_URL:
        sys.exit("OPENHANDS_URL absent : le banc ne saurait pas à qui parler")

    try:
        status, body = openhands_get("/health")
    except Exception as error:
        sys.exit(
            f"OpenHands injoignable sur {OPENHANDS_URL} : {error}\n"
            "  démarrez l'instance : "
            "docker compose -f docker/openhands/docker-compose.yml up -d"
        )
    if status != 200 or body.strip().strip('"') != "OK":
        sys.exit(
            f"{OPENHANDS_URL}/health a répondu {status} « {body.strip()[:80]} », "
            'attendu 200 "OK".\n'
            "  Ce n'est pas OpenHands qui écoute sur ce port. Vérifiez :\n"
            "    lsof -nP -iTCP:$(printf '%s' \"$OPENHANDS_URL\" | sed 's|.*:||') -sTCP:LISTEN"
        )

    status, body = openhands_get("/api/v1/app-conversations/search?limit=1")
    try:
        json.loads(body)
    except ValueError:
        sys.exit(
            f"{OPENHANDS_URL} répond à /health mais son API rend du non-JSON "
            f"({status}, « {body.strip()[:60]} »).\n"
            "  Un autre service occupe le port, ou l'instance n'a pas fini de démarrer."
        )
    print(f"  OpenHands : {OPENHANDS_URL} répond")


def check(branches):
    """Contrôle préalable : l'instance OpenHands est là, le jeton répond, et
    chaque branche a UNE merge request ouverte.

    Existe parce que l'inverse coûte cher : sans lui, un .env non chargé
    produisait douze échecs identiques, douze lignes de CSV inutiles, et aucun
    message avant la fin. Un banc qui va effacer des commentaires doit dire ce
    qui cloche AVANT d'en effacer un seul."""
    check_openhands()

    if not HUMAN_TOKEN:
        sys.exit(
            "aucun jeton. GITLAB_TOKEN doit être dans .env ou dans l'environnement\n"
            "  (CDS_SKIP_DOTENV=1 empêche la lecture de .env)."
        )
    try:
        user = api("/user", HUMAN_TOKEN)
    except Exception as error:
        sys.exit(f"jeton refusé par {GITLAB_URL} : {error}")

    project = project_path()
    print(f"  jeton : @{user['username']}   dépôt : {project}")

    problems = 0
    for branch in branches:
        encoded = urllib.parse.quote(project, safe="")
        query = urllib.parse.urlencode(
            {"source_branch": branch, "state": "opened", "per_page": 100}
        )
        try:
            found = api(f"/projects/{encoded}/merge_requests?{query}", HUMAN_TOKEN)
        except Exception as error:
            print(f"  ✗ {branch} : {error}", file=sys.stderr)
            problems += 1
            continue
        if len(found or []) != 1:
            print(
                f"  ✗ {branch} : {len(found or [])} merge request(s) ouverte(s), il en faut une",
                file=sys.stderr,
            )
            problems += 1
    if problems:
        sys.exit(f"{problems} branche(s) inexploitable(s) — rien n'a été touché")
    print(f"  {len(branches)} branche(s) prêtes")


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "check":
        check(sys.argv[2:])
        return
    if len(sys.argv) not in (3, 4) or sys.argv[1] not in ("prepare", "collect", "skills"):
        sys.exit(
            "usage: bench_gitlab.py prepare|collect <branche> | skills <url> "
            "| check <branche>..."
        )
    if sys.argv[1] == "skills":
        print(skills_of(sys.argv[2]))
        return
    command, branch = sys.argv[1], sys.argv[2]
    project = project_path()

    if command == "prepare":
        if not HUMAN_TOKEN:
            sys.exit("aucun jeton : renseignez GITLAB_TOKEN (ou BENCH_GITLAB_TOKEN)")
        iid = find_merge_request(project, branch)
        removed = wipe(project, iid)
        forgotten = forget_conversation(project, iid)
        forget_requests(project, iid)
        # AVANT de poster : le daemon sert le premier to-do venu, pas le nôtre.
        purged = purge_todos(project)

        encoded = urllib.parse.quote(project, safe="")
        api(
            f"/projects/{encoded}/merge_requests/{iid}/notes",
            HUMAN_TOKEN,
            method="POST",
            form={"body": REQUEST_TEXT.format(bot=BOT)},
        )
        print(
            f"    !{iid} — {removed} note(s) effacée(s)"
            + (", conversation oubliée" if forgotten else "")
            + (f", {purged} to-do(s) en reliquat écarté(s)" if purged else "")
            + ", demande postée"
        )
        return

    # collect : ce que le bot a RÉELLEMENT publié.
    iid = find_merge_request(project, branch)
    encoded = urllib.parse.quote(project, safe="")
    counts = {"ligne": 0, "fichier": 0, "generale": 0, "suggestions": 0}
    for discussion in (
        api(
            f"/projects/{encoded}/merge_requests/{iid}/discussions?per_page=100",
            BOT_TOKEN,
        )
        or []
    ):
        notes = [
            n
            for n in discussion.get("notes", [])
            if not n.get("system") and n["author"]["username"] == BOT
        ]
        if not notes:
            continue
        kind = (notes[0].get("position") or {}).get("position_type")
        counts["ligne" if kind == "text" else "fichier" if kind == "file" else "generale"] += 1
        counts["suggestions"] += sum(n["body"].count("```suggestion") for n in notes)
    print(json.dumps({"iid": iid, **counts}))


if __name__ == "__main__":
    main()
