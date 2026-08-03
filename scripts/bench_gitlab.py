#!/usr/bin/env python3
"""Préparation et relevé d'une merge request de mesure.

Deux sous-commandes, appelées par scripts/bench.sh :

  prepare <branche>   remet la MR à zéro et poste la demande de revue
  collect  <branche>  compte ce que le bot a réellement publié

POURQUOI DEUX JETONS. Le daemon rejette les notes écrites par le bot
lui-même (`note.author.id === bot.id`, voir src/daemon/request.ts) : un
garde-fou anti-boucle sans lequel le bot se répondrait à l'infini. Poster la
demande avec GITLAB_TOKEN ne créerait donc aucune tâche. Il faut le jeton d'un
compte HUMAIN, autorisé sur le dépôt dans projects.json — d'où
BENCH_GITLAB_TOKEN, distinct et jamais utilisé par le daemon.

CE QUE `prepare` EFFACE, ET POURQUOI. Toutes les notes non système de la MR :
les demandes des runs précédents, et surtout les remarques du modèle
précédent. Sans ça, le modèle suivant lit la revue de son prédécesseur et ne
mesure plus rien — c'est le biais qui a imposé une MR par modèle jusqu'ici, et
que ce nettoyage remplace. Les réactions emoji du bot partent aussi : elles
survivraient à la suppression des notes et fausseraient la lecture.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

GITLAB_URL = os.environ.get("GITLAB_URL", "https://gitlab.com").rstrip("/")
BOT = os.environ.get("BOT_USERNAME", "")
BOT_TOKEN = os.environ.get("GITLAB_TOKEN", "")
HUMAN_TOKEN = os.environ.get("BENCH_GITLAB_TOKEN", "")
STATE_FILE = os.environ.get("STATE_FILE", "./state/processed.jsonl")
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


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("prepare", "collect"):
        sys.exit("usage: bench_gitlab.py prepare|collect <branche>")
    command, branch = sys.argv[1], sys.argv[2]
    project = project_path()

    if command == "prepare":
        if not HUMAN_TOKEN:
            sys.exit(
                "BENCH_GITLAB_TOKEN manquant.\n"
                "  Le daemon ignore les notes écrites par le bot lui-même : la demande\n"
                "  de revue doit venir d'un compte humain, autorisé sur le dépôt dans\n"
                "  projects.json. Mettez-y SON jeton, pas celui du bot."
            )
        iid = find_merge_request(project, branch)
        removed = wipe(project, iid)
        forgotten = forget_conversation(project, iid)
        forget_requests(project, iid)

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
