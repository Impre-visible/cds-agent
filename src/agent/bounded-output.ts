/**
 * Accumulateur de sortie borné en mémoire (§4.8). `sandbox.ts` et
 * `runner.ts` capturaient jusqu'ici la sortie d'un process avec un simple
 * `output += chunk`, sans aucune limite : une suite de tests bavarde, une
 * boucle infinie qui spamme stdout avant que le timeout ne tue le process,
 * ou un `console.log` dans une boucle, et la chaîne grossit sans borne
 * jusqu'à l'OOM du daemon lui-même (pas du conteneur — c'est ce process-ci
 * qui tient la chaîne en mémoire).
 *
 * On tronque le DÉBUT et on garde la FIN, pour deux raisons qui tiennent
 * toutes les deux en aval :
 * - l'affichage (`output.slice(-1200)` dans implement.ts) ne montre de
 *   toute façon que les derniers caractères ;
 * - `extractJson` (review.ts) cherche `{"remarks"` dans stdout : c'est la
 *   réponse finale du modèle, qui arrive après tout le bruit des appels
 *   d'outils qui la précèdent dans le flux — donc en fin de sortie, pas au
 *   début. Perdre le début plutôt que la fin est ce qui préserve cet usage.
 *
 * Risque à surveiller si `extractJson` échoue plus souvent après ce
 * correctif : un modèle qui ré-émettrait le JSON avant une longue sortie
 * annexe (peu probable vu le prompt de review.ts, qui demande une réponse
 * "sans autre texte", mais pas garanti pour un petit modèle) verrait ce
 * JSON tronqué si la sortie totale dépasse la limite. La limite ci-dessous
 * (plusieurs Mo) est délibérément généreuse pour que ce cas reste
 * hypothétique en pratique.
 */

/** Conservé après troncature ; 4 Mo couvre largement une sortie normale
 * (logs de tests, sortie de l'agent) tout en bornant strictement la
 * mémoire face à un cas dégénéré. */
export const DEFAULT_MAX_CAPTURED_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface BoundedOutput {
  append(chunk: string | Buffer): void;
  /** Sortie accumulée, tronquée en tête si elle dépasse la limite. */
  value(): string;
  /** Vrai si au moins une troncature a eu lieu (utile pour signaler la perte à l'appelant, ou en tests). */
  wasTruncated(): boolean;
}

/**
 * Fonction (pas classe) pour rester dans l'idiome du reste du fichier — et
 * surtout parce que le type-stripping natif de Node refuse les parameter
 * properties, qu'une classe ici aurait rendues tentantes.
 *
 * On ne re-tronque pas à chaque chunk reçu (un slice() sur une chaîne déjà
 * grande a un coût), mais seulement une fois le double de la limite atteint
 * — la mémoire reste bornée à 2×maxBytes dans le pire cas entre deux
 * troncatures, ce qui est largement suffisant pour éviter l'OOM visé ici
 * tout en amortissant le coût du slice() sur plusieurs appends.
 */
export function createBoundedOutput(
  maxBytes = DEFAULT_MAX_CAPTURED_OUTPUT_BYTES,
): BoundedOutput {
  let text = "";
  let truncated = false;

  const truncateIfNeeded = () => {
    if (text.length > maxBytes) {
      text = text.slice(-maxBytes);
      truncated = true;
    }
  };

  return {
    append(chunk) {
      text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (text.length > maxBytes * 2) truncateIfNeeded();
    },
    value() {
      truncateIfNeeded();
      return text;
    },
    wasTruncated() {
      return truncated;
    },
  };
}
