import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createBoundedOutput } from "../../src/agent/bounded-output.ts";

describe("createBoundedOutput (§4.8 : capture bornée en mémoire)", () => {
  test("une sortie sous la limite n'est pas touchée", () => {
    const out = createBoundedOutput(1_000);
    out.append("hello ");
    out.append("world");
    assert.equal(out.value(), "hello world");
    assert.equal(out.wasTruncated(), false);
  });

  test("une sortie qui dépasse la limite ne garde que la fin", () => {
    const out = createBoundedOutput(10);
    out.append("0123456789ABCDEF"); // 16 caractères, au-dessus de la limite
    assert.equal(out.value(), "6789ABCDEF");
    assert.equal(out.wasTruncated(), true);
  });

  test("§4.8 — le scénario qui motive le correctif : plusieurs Mo accumulés en petits " +
    "chunks ne font pas grossir la mémoire indéfiniment, et la fin exacte est conservée", () => {
    const maxBytes = 1_000;
    const out = createBoundedOutput(maxBytes);

    // 5 Mo au total, en chunks numérotés (donc distincts les uns des
    // autres) : reproduit une suite de tests bavarde ou une boucle qui
    // spamme stdout jusqu'au timeout. On garde une référence complète pour
    // vérifier que c'est bien un vrai suffixe qui survit, pas un artefact.
    const totalChunks = 50_000;
    let expectedFull = "";
    for (let i = 0; i < totalChunks; i++) {
      const chunk = `chunk-${i}\n`;
      expectedFull += chunk;
      out.append(chunk);
    }

    const value = out.value();
    assert.ok(
      value.length <= maxBytes,
      `la sortie accumulée (${value.length} caractères) doit rester bornée à ${maxBytes}`,
    );
    assert.equal(out.wasTruncated(), true);
    // La fin exacte de ce qui a été écrit doit être préservée (on tronque
    // le début, jamais la fin — voir la justification dans bounded-output.ts).
    assert.equal(value, expectedFull.slice(-value.length));
    assert.ok(value.endsWith(`chunk-${totalChunks - 1}\n`));
  });

  test("append() accepte aussi des Buffer (cas réel : chunks reçus de child_process.stdout)", () => {
    const out = createBoundedOutput(5);
    out.append(Buffer.from("abcdef", "utf8"));
    assert.equal(out.value(), "bcdef");
  });

  test("value() peut être appelée plusieurs fois sans re-tronquer de façon incohérente", () => {
    const out = createBoundedOutput(5);
    out.append("abcdef");
    const first = out.value();
    const second = out.value();
    assert.equal(first, second);
  });
});
