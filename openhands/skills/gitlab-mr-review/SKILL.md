---
name: gitlab-mr-review
description: Post a code review on a GitLab merge request with comments anchored to the exact diff lines, and one-click `suggestion` blocks. Use whenever reviewing a GitLab merge request. This is the GitLab counterpart of github-pr-review.
triggers:
- gitlab-mr-review
- merge request review
- review this merge request
- revue de merge request
---

# GitLab merge request review

Post review comments **anchored to the line of the diff they talk about**, using the
GitLab discussions API. `GITLAB_TOKEN` is available in your environment.

## The one rule that matters

**An unanchored comment is a failed comment.**

A comment posted at merge-request level does not appear in the *Changes* tab. The reader
has to find the line by hand, from a file name and a line number you wrote in prose — and
prose line numbers are wrong often enough to matter. Anchor first. Fall back only when the
API refuses.

This is not a preference. If you end a review with zero anchored comments, the review has
failed, however good its content.

## Step 1 — get the SHAs

Every anchored comment needs the same three SHAs. Read them once, reuse them.

```bash
curl -sS --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$CI_API_V4_URL/projects/$PROJECT/merge_requests/$IID" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["diff_refs"]; print(d["base_sha"], d["start_sha"], d["head_sha"])'
```

`$PROJECT` is the URL-encoded path (`group%2Frepo`) or the numeric id.

If `diff_refs` is null, read the most recent version instead — **the first element is the
newest**:

```bash
curl -sS --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$CI_API_V4_URL/projects/$PROJECT/merge_requests/$IID/versions" \
  | python3 -c 'import json,sys; v=json.load(sys.stdin)[0]; print(v["base_commit_sha"], v["start_commit_sha"], v["head_commit_sha"])'
```

## Step 2 — find the line number

Read the diff and count. The hunk header gives you both cursors:

```
@@ -old_start,old_count +new_start,new_count @@
```

Walk the hunk body from there:

| Line starts with | It is | `old_line` | `new_line` |
|---|---|---|---|
| `+` | **added** | — | advances |
| `-` | **deleted** | advances | — |
| ` ` (space) | **context**, unchanged | advances | advances |

Then verify before you post — an off-by-one puts your comment on the wrong statement:

```bash
sed -n '42p' path/to/file.js
```

## Step 3 — post one discussion per remark

```bash
curl -sS --request POST --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  --url "$CI_API_V4_URL/projects/$PROJECT/merge_requests/$IID/discussions" \
  --form "body=$(cat /tmp/remark.md)" \
  --form "position[position_type]=text" \
  --form "position[base_sha]=$BASE" \
  --form "position[start_sha]=$START" \
  --form "position[head_sha]=$HEAD" \
  --form "position[old_path]=src/todoStore.js" \
  --form "position[new_path]=src/todoStore.js" \
  --form "position[new_line]=42"
```

Use `--form` with a file (`$(cat …)`) for the body rather than inlining it: bodies contain
backticks, quotes and newlines, and shell quoting will corrupt them silently.

### The position rules — get these exactly right

These four rules are where anchored comments fail with a `400`:

1. **`old_path` AND `new_path` are both required**, always — even when the file was not
   renamed. Send the same value twice in that case.
2. **Added line** (`+`) → send `new_line` **only**. Sending `old_line` too is rejected.
3. **Deleted line** (`-`) → send `old_line` **only**.
4. **Context line** (unchanged, starts with a space) → send **both** `old_line` and
   `new_line`. This is the rule that is most often missed: an unchanged line has a position
   in both versions, and GitLab wants both.

`position[position_type]` is `text` for a line comment.

### Fallback, in this order — and only after the level above failed

1. **The line.** What you should be doing.
2. **The file** — same call, `position[position_type]=file`, no line numbers. The comment
   still lands in the *Changes* tab, on the file.
3. **A merge-request comment**, last resort only:
   `POST /projects/:id/merge_requests/:iid/notes`. If you get here, you **must** name the
   file and the line in the text, and you must have verified that line number by reading the
   file — a wrong line number in prose is worse than no line number at all.

Do not start at level 3 because it is easier. Do not batch everything into one general
comment "for readability": one remark is one discussion, so it can be resolved on its own.

## Step 4 — `suggestion` blocks

For any remark whose fix is a few lines, attach a suggestion. The reader applies it in one
click.

~~~markdown
The comparison is case-sensitive, so searching `PAIN` never finds `Acheter du pain`.

```suggestion
  const needle = String(q ?? "").toLowerCase();
```
~~~

### How a suggestion actually behaves

The block **replaces** the anchored line. What gets replaced:

- anchor alone → that single line;
- `suggestion:-N+M` → `N` lines above and `M` lines below the anchor, inclusive.

The body may contain any number of lines — it does not have to match the replaced range.

| Intent | Anchor | Body must contain |
|---|---|---|
| Change line N | line N | the new content of line N |
| Change lines N-1..N+1 | line N, ` ```suggestion:-1+1 ` | the new content of the **whole** block |
| Add a line after N | line N | line N verbatim, then the new line |
| Add a line before N | line N | the new line, then line N verbatim |
| Delete line N | line N | an empty block |

### Verify before posting — this is not optional

For each suggestion:

1. `sed -n '<range>p' <file>` — read the lines that will actually be replaced.
2. Apply your suggestion mentally: drop those lines, splice yours in.
3. Confirm the result is **exactly** what your prose promises — no line duplicated because
   you pasted a neighbour as context, none dropped because your range was wider than your
   body, no off-by-one.

If you are not certain, **drop the suggestion block and keep the prose**. A correct comment
is always worth more than a one-click fix that corrupts the file.

Do not suggest when the fix is a design decision, and never let a suggestion rewrite more
than the remark describes.

## What not to post

- No "looks good", no "acceptable trade-off", no nit a linter already catches. A comment
  that needs no action creates a thread someone has to resolve for nothing.
- **Never claim a piece of code is correct if you have not read it.** Saying "this custom
  format works" about a function you did not open is the single most expensive mistake in a
  review: it converts an unnoticed flaw into an endorsed one.

## Before you finish

Count your anchored comments. If the number is zero and the merge request had real remarks,
something went wrong in step 1 or step 3 — re-read the error the API returned and fix it,
rather than falling back to a general comment and calling it done.
