---
name: gitlab-conversations
description: How to reply on a GitLab merge request without breaking the conversation — reply inside the thread you were asked in, never open a parallel note, never post meta-announcements. Use whenever answering a question or following up on a GitLab merge request or issue.
triggers:
- gitlab conversation
- reply in thread
- follow-up on merge request
- repondre dans le fil
---

# GitLab conversations — where to answer, and how

A merge request is a conversation between people. Everything you post lands in it and stays
there. These rules exist because each one has already been broken in production, with a
measurable cost.

## Reply where you were asked

GitLab has two different things that both look like "a comment":

| | What it is | How you reply |
|---|---|---|
| **Discussion** (thread) | A comment that can be replied to and *resolved* | `POST /projects/:id/merge_requests/:iid/discussions/:discussion_id/notes` |
| **Individual note** | A standalone comment, no thread | `POST /projects/:id/merge_requests/:iid/notes` |

**If someone asked you a question inside a thread, answer inside that thread.** A new
merge-request comment detaches the answer from the question: the reader sees a wall of text
with no idea which remark it explains, and the original thread stays unanswered and
unresolvable.

Find the thread that contains the note you are replying to:

```bash
curl -sS --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$CI_API_V4_URL/projects/$PROJECT/merge_requests/$IID/discussions?per_page=100" \
  | python3 -c '
import json,sys
target = int(sys.argv[1])
for d in json.load(sys.stdin):
    if any(n["id"] == target for n in d["notes"]):
        print(d["id"], "individual" if d["individual_note"] else "thread")
' "$NOTE_ID"
```

The notes API does **not** tell you which discussion a note belongs to — only the
discussions API does. That is the only way to find it.

`individual_note: true` means it is **not** a real thread: you cannot reply to it as one.
Answer with a normal merge-request note in that case.

## One remark, one discussion

Never bundle several unrelated remarks into one comment. Each remark must be resolvable on
its own — that is what the *Resolve* button is for, and what lets a team track what is left
to address. A single comment listing eight problems can only be resolved all at once, or
never.

Conversely, do not split one remark across several comments.

## Never announce what you are doing

Do not post:

- "I'm starting the review…"
- "I have published a detailed review here: <link>"
- "Done, see my comments above."

A message whose only content is the existence of another message doubles the noise and
teaches readers to skim past your comments. Publish the result. Nothing else.

If you have nothing to say — the code is fine, or there is genuinely no remark — post
nothing at all. Silence is a valid, and often correct, review outcome.

## Sign as the account that posts

Sign with the GitLab account name that owns the token you are using, never with your own
name as a model or product. Readers see a comment authored by `@some-bot` signed
"OpenHands (AI Agent)" and have no way to connect the two — the signed name is the one they
cannot look up, mention, or block.

## Do not resolve or close on someone's behalf

Do not resolve a thread you did not open, do not mark a merge request ready, do not close an
issue, unless you were explicitly asked to. Resolving a thread makes a human's remark
disappear from the default view.

## Never notify people who did not ask

Do not write `@name` in a body unless that person is the one you are answering. A review
that quotes a code comment containing `@someone` will notify them for nothing. When you have
to reproduce text that contains an `@`, put it in a code span or a fenced block.

The same goes for GitLab quick actions (`/close`, `/merge`, `/assign`…): a line starting
with `/` in a comment body **is executed** with the rights of the token you are using. When
reproducing content that may start with a slash, always fence it.

## Before you post — the checklist

1. Am I answering a question from a thread? Then post **in that thread**.
2. Is this one remark, in its own discussion?
3. Does this message carry information the reader cannot get otherwise? If not, do not
   post it.
4. Is it signed with the posting account's name?
5. Have I fenced anything that contains `@` or starts with `/`?
