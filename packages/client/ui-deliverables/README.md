---
description: "Produced-files and clickable file references for the Web GUI: the deliverables row a finished turn ends with, and inline-code links in the closing prose; for users and maintainers of the deliverables experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-deliverables

English | [中文](README.zh.md)

## Summary

A relative and absolute file reference are merged only when resolution against the owning Session cwd proves they name the same path. Matching basenames or suffixes alone never remove a file card.

This package renders the deliverables row a finished turn ends with — files created or modified by supported mutation tools plus final artifacts verified by `gongchuang_publish_files` — and links matching inline-code references in the closing prose, so a mentioned file opens in the Host. The vocabulary comes from successful tools' structured arguments, never from the closing prose — a produced file is listed whether or not the model remembered to name it. The shipped Web patch is the only composition that loads this package; removing its cordis.yml entry removes the guidance, row, and prose links together.

A successful `gongchuang_artifact_probe` also contributes its structured `artifactPath`, including when it is the only delivery call. Both native and code-mode results are supported. Older code-mode recordings with missing coordinates use the persistence owner's bounded read-time normalization; this renderer does not infer publication from prose or neighboring events.

An initial history tail can omit `turn/start`. Complete publication receipts, Host quality notices and successful call/result pairs within that turn's loaded matches still produce cards and retained text immediately. A result without its call arguments remains unresolved. Loading older pages uses the normal replay without duplicating cards, mixing turns or discarding the latest quality classification.

File openability does not imply professional approval. Host-authored policy notices carry the existing delivery phase, inspected file mapping and diagnostics through ordinary Session metadata. A draft card opens the marked draft copy and does not list its unmarked original as another final delivery. Late notices and replay retain the phase; ordinary files have no invented approval badge. This projection does not restart a model turn, change the one-correction limit or rewrite original files.

When the Host terminates a text-only professional check with a retained candidate, the same turn tail shows an **Unverified draft**, its open diagnostics, and a copy action. It neither invents a file nor labels the content approved. Only the existing Host policy notice can supply this text; ordinary user metadata cannot. The browser registers `TurnDeliverables`, which composes this view with `ProducedFiles`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin alongside `ui-conversation`; a finished turn ends with produced-file cards between the closing message's body and its action footer. Each card opens its file through the Host opener, with relative paths resolved against the session cwd. A desktop composition can supply validated native application selection, reveal, and save-copy actions. A standalone browser does not fabricate unavailable desktop actions.

### The row

The list initially shows up to six file cards and expands on demand. Complete basenames wrap within the available width; each card also identifies the file type and any Host-authored quality state. The native action menu is separate from the primary open target. Both controls retain visible errors without restarting the model or discarding the delivery.

### Inline-code links

The closing prose carries the same vocabulary: an inline-code token resolves by exact path, or by being exactly the basename of exactly one produced path — a basename two paths share stays inert rather than guessing, so a mention can never open the wrong file. A resolved mention keeps its code chip and takes the markdown sheet's link language, with the full path as its title.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Node half registers the static `ui:deliverable-file-references` system-prompt section asking the model to mention primary files from successful creation or modification calls and to write those and any other changed-file references as Markdown inline code. The browser half registers `TurnDeliverables` into the chat view's `conversation.chat.turnTail` hole. `deliverablesDefinition` folds each Turn's successful first-party mutation calls into `DeliverablesTurnData` from the validated raw arguments of `write`, `edit`, and mutating `str_replace_editor` commands. A successful `gongchuang_publish_files` call contributes its structured `paths` as explicit final artifacts; this works for both a native result and a PTC sub-dispatch, whose durable event carries the enclosing turn and step. Once present, explicit publications replace intermediate mutation paths in the user-facing row. Reads, deletes, unsupported tools, malformed calls, failed results, and filenames found only in result or assistant prose contribute nothing. A new producer needs an explicit Client contribution before it joins the list. The package also provides the `chatFileMentions` service the chat view consults per closing message; composing the plugin out removes both surfaces and leaves the view's empty chain at zero cost.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the deliverables surface is not enough. They move from the row to the turn-tail hole and the decisions behind the vocabulary.

- [ui-conversation](../ui-conversation/README.md) — declares the `conversation.chat.turnTail` hole and renders the closing prose.
- [Workspace file links](../../../.agents/notes/implemented/feature/2026-07-31-web-workspace-file-links.md) — the decision behind the produced-files row and the Host open path.
- [Inline file mentions](../../../.agents/notes/implemented/feature/2026-08-07-web-inline-file-mentions.md) — the decision behind clickable mentions in the closing prose.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

### Clickable file-reference guidance

#### What the model sees

One fixed paragraph instructs the model to name primary files from successful creation or modification calls in its final response and to format those and any other changed-file references as exact-path or unique-basename Markdown inline code, such as `out/report.html`.

#### Token effect

One fixed prompt paragraph whenever this package is loaded; no tool schema, tool result, or per-Turn context is added.

#### KV Cache effect

The section is static at first-party order 9000 for the lifetime of the package mount, so it remains in the reusable prompt prefix and does not change across Turns.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current deliverables vocabulary. They are current package constraints, not a general file-linking comparison or a task backlog.

- **Mention matching is exact path or unique basename only** — a suffix mention stays inert; widening the matcher is deferred until a real closing-message shape needs it.
- **Files created indirectly by terminal commands remain outside the matching vocabulary until explicitly published** — naming such a file in inline code does not make it clickable; a successful `gongchuang_publish_files` call can declare the verified final artifact.
- **Native folder handoff targets the Host desktop** — a browser reached through a non-loopback authority omits the action, as does a deployment reporting no native opener; SSH forwarding that makes a remote Host look loopback-local must set the Session Controller's `nativeOpen: false`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The prompt section, slot, dictionary, event definition, and optional service registrations are effect-owned with disposal proven by their plugin specs; this package owns no mutable state.
