import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Sonde l'existence d'un processus sans lui envoyer de signal réel
 * (signal 0, voir `man 2 kill` / doc Node de process.kill) — le seul moyen
 * portable de détecter "ce PID est-il vivant ?" sans dépendance
 * supplémentaire.
 *
 * ESRCH : aucun processus avec ce PID → mort.
 * EPERM : un processus existe mais appartient à un autre utilisateur → on
 * ne peut pas en être certain sans lire /proc (indisponible sur toutes les
 * plateformes), mais côté sécurité mieux vaut supposer vivant que déclarer
 * périmé, à tort, un verrou qui ne l'est pas.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type LockResult =
  | { acquired: true }
  | { acquired: false; heldByPid: number };

/**
 * Verrou d'instance unique par fichier (§3.9) : sans lui, deux daemons
 * lancés sur le même PAT (un à la main, un dans un tmux oublié) traitent
 * chacun leur exemplaire d'un même to-do — leurs stores sont des fichiers
 * distincts (voir store.ts) et GitLab n'offre aucune atomicité entre deux
 * clients qui liraient/écriraient les mêmes to-dos en parallèle.
 *
 * Le fichier ne contient qu'un PID en texte brut. Un verrou existant dont le
 * PID ne correspond à aucun processus vivant (voir isProcessAlive) est
 * considéré périmé et repris silencieusement — sans quoi un crash précédent
 * exigerait un nettoyage manuel avant tout redémarrage.
 *
 * Limite assumée, documentée plutôt que dissimulée : il y a une fenêtre de
 * course inévitable entre la lecture du fichier et son écriture (pas de
 * verrou atomique cross-plateforme sans dépendance supplémentaire — un
 * `open(..., "wx")` échouerait de la même façon sur un verrou périmé qu'il
 * faudrait de toute façon détecter et reprendre "à la main"). Deux instances
 * démarrées à la même milliseconde exacte pourraient toutes deux croire
 * avoir acquis le verrou. Ce n'est pas le scénario visé par §3.9 (un tmux
 * oublié découvert des heures ou des jours plus tard, pas une course de
 * démarrage) : un verrou fragile mais qui documente sa fragilité vaut mieux
 * qu'un faux sentiment de garantie absolue.
 */
export class InstanceLock {
  private readonly path: string;
  private readonly pid: number;
  private held = false;

  constructor(path: string, pid: number = process.pid) {
    this.path = path;
    this.pid = pid;
  }

  acquire(): LockResult {
    if (existsSync(this.path)) {
      const raw = readFileSync(this.path, "utf8").trim();
      const holderPid = Number(raw);
      const staleOrIllegible =
        !Number.isFinite(holderPid) || holderPid <= 0 || !isProcessAlive(holderPid);

      if (!staleOrIllegible) {
        return { acquired: false, heldByPid: holderPid };
      }
      // PID illisible ou mort : verrou périmé, on le reprend sans exiger de
      // nettoyage manuel.
    }

    writeFileSync(this.path, String(this.pid), "utf8");
    this.held = true;
    return { acquired: true };
  }

  /**
   * Ne supprime le fichier que s'il nous appartient encore : évite d'effacer
   * le verrou d'une instance qui l'aurait entre-temps repris parce qu'elle
   * nous a crus morts (scénario extrême, mais gratuit à couvrir).
   */
  release(): void {
    if (!this.held) return;
    try {
      if (existsSync(this.path)) {
        const raw = readFileSync(this.path, "utf8").trim();
        if (Number(raw) === this.pid) unlinkSync(this.path);
      }
    } catch {
      // Best-effort : un verrou orphelin sera de toute façon détecté comme
      // périmé au prochain démarrage (voir acquire()).
    } finally {
      this.held = false;
    }
  }
}
