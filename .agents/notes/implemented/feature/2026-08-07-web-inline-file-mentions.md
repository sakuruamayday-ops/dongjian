# Agent Note: inline-code file mentions open the file they name

Status: implemented

English | [中文](2026-08-07-web-inline-file-mentions.zh.md)

> Scope: guiding final responses to name primary output files as inline code, linking those tokens to structured turn outputs, and allowing a narrow office/PDF/HTML filename fallback through the Host opener. Not in scope: recognizing paths in plain prose, bypassing Host workspace/path policy, or mentions in streaming or mid-turn messages.

## Problem

The produced-files row lists a turn's output, but the closing message usually also *names* the file in prose — as inline code, like `` `deepseek-homepage.html` `` — and that mention was inert text. The reader's eye lands on the sentence first; the affordance sat one row below it. The model was not told that this exact inline-code spelling activates the Web file opener, so producing the useful reference depended on habit.

## Decision

**Structured outputs remain authoritative, with one controlled document fallback.** The [produced-files decision](2026-07-31-web-workspace-file-links.md) rejected making the visible deliverable row depend on model prose; that still holds. `producedFileMentions` first resolves an inline-code token by exact produced path, or by being exactly the basename of exactly one produced path. When older or imperfect model output omitted the structured publish event, one whole inline-code token ending in DOC/DOCX, XLS/XLSX, PPT/PPTX, PDF, HTML/HTM, or RTF may still ask the Host to open that workspace-relative path. This fallback never fabricates a deliverable row or a success state: the existing Host path boundary resolves or refuses it, and ChatView surfaces a controlled error with retry. URLs, whitespace-padded tokens, control characters, Markdown/source names, and arbitrary path-shaped prose remain inert.

**The renderer owns no vocabulary, and the provider is the deliverables plugin.** `MarkdownText` takes an optional `MarkdownFileMentions` resolver and consults it for inline-code tokens — after URL promotion, which wins, and never inside an anchor, where a button cannot nest. What names a file is decided behind the optional `chatFileMentions` service ui-conversation reaches via `ctx.get`: ui-deliverables provides it beside its turn-tail chain entry, so one cordis.yml line composes the row and the prose links in or out together, and ui-primitives gains no session concepts. Mentions apply to settled renders only — the streaming cache must not bake in handlers that could go stale, and the vocabulary is not final until the turn closes. The consumer memoizes the resolver on the closing seq rather than the growing transcript, so a settled message's cached parse survives stream appends.

**The provider also owns the model guidance for its accepted syntax.** The ui-deliverables Node half registers a static `ui:deliverable-file-references` section that asks the model to mention primary files from successful creation or modification calls in its final response and to write those and any other changed-file references as Markdown inline code, using the exact file-tool path or a basename only when it is unique within the Turn. The guidance deliberately says nothing about unrelated local-path formats. The shipped Web patch is the only composition that loads ui-deliverables, so the guidance exists exactly where the renderer exists; removing the package removes both. The row remains the correctness path when the model omits a mention, and the matching vocabulary still rejects anything not recorded by a successful mutation.

## Alternatives considered

- **Path-shaped regex over all prose** — links `package.json` mentioned abstractly and examples that were never written. The adopted fallback is restricted to one inline-code document token and still delegates existence, workspace confinement, and opening to the Host.
- **Linking suffix matches (`out/index.html` mentioned as `index.html` in a subdirectory listing)** — deferred; exact path and unique basename cover the observed closing-message shapes, and a wider matcher can loosen later without breaking the seam.
- **Resolving in ui-primitives against a passed path list** — puts matching policy in the generic renderer, where other consumers would inherit it unasked. The resolver contract keeps policy with the owner.
- **Threading the vocabulary through the turn-tail chain** — the chain is a render dispatch below the message; mentions decorate markdown inside it, which only data reaching MarkdownText can do. The optional service is that data path, and its absence is the off state.
- **Registering the guidance in dsh-web-app** — makes the app bundle describe a feature-specific rendering syntax and allows the renderer and its prompt to drift or be composed independently. The feature package's existing Node half gives one cordis.yml row joint ownership.
- **Adding a post-turn model step to identify the output** — adds latency and another generation even though the final response already has the necessary file-tool history. One static prompt paragraph stays in the reusable prefix and asks the existing final generation to emit the accepted spelling.

## Consequences

The mention and the row are two affordances for one fact (full path as `title` on both); the mention itself wears the markdown sheet's anchor language — link-blue at rest, hover underline — because an at-rest underline collides with monospace descenders inside the code chip. The prompt section is constant for the package mount and therefore remains cacheable across Turns. The keyless shipped-Web composition snapshot pins the exact model-visible paragraph, while `apps/web/tests/produced-file-mentions.e2e.ts` pins the assembled rendering with a built write-turn seed. Files created indirectly or omitted from structured output can be opened only when the model names a controlled document filename in the settled closing message and the Host accepts it; a missing file produces the ordinary controlled retry dialog rather than a silent inert chip. Mentions in mid-turn narration stay inert even for files the turn later produces. The window-prepend edge remains safe because structured resolution is preferred and the fallback never bypasses Host policy.
