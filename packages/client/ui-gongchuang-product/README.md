---
description: "Private browser product shell for the Gongchuang Enterprise Assistant desktop client."
kind: "package-reference"
---

# @gongchuang/client-ui

English | [中文](README.zh.md)

## Summary

Opening an archived conversation through a deep link or automation result first restores its archived workspace. Desktop deep links wait for both lists and show navigation failures in the sidebar. Automation settlement reads the owning turn's delivery classification: waiting-user, paused, draft and failed results remain actionable non-success results instead of becoming completed tasks; no automatic retry is added.

Imported Office, PDF and WPS attachment context identifies the installed document reader and its relative-path string parameter. Successful text extraction is reused and only the reported missing pages need OCR. This guidance does not start enterprise onboarding or report generation; text and Markdown attachments keep their ordinary prompt path.

Private browser product shell for 共创企业助手. It composes the branded sidebar and page overlay through the Web Client slot system, while account, provider, connector, marketplace, automation, workspace, and conversation state remain in their owning Host or client-runtime services.

## Table of Contents

- [Product behavior](#product-behavior)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Product behavior

The account login form provides a Forgot password link when the Host has supplied the account portal origin. It opens `/password/reset` in a separate browser context without sending form input or submitting a login. The user enters the registered username and company name on the website, sets a new password, and returns to sign in. An unloaded portal origin exposes no loopback recovery link.

Model and account dialogs offer a direct retry when the operating-system credential store is temporarily unreadable. Model errors stay visible even when the provider adapter has not activated, and an unknown credential state does not hide retry behind a saved-key flag. The account dialog distinguishes unavailable account access from a confirmed logout; retries do not submit new login or API-key input.

Model recovery and runtime failure notices follow live appends in the selected Session's Client event feed. Model responses and request headers identify the affected provider, independently of the global selection. Switching Sessions releases the old subscription; history replacement and pagination do not replay credential probes or old model failures.

The shell offers DeepSeek, OpenCode, and custom-provider selection; enterprise workspaces; separate installed and marketplace skill views; ModelScope, Tencent SkillHub, and custom-repository search with pagination; MCP setup; local automation; device-local graph-memory controls; a local profile avatar; and native desktop update controls. A community skill opens a vendor setup page after installation only when the Host supplies a reviewed official configuration URL, and its installed-skill detail keeps an `Open official configuration` action for later reconfiguration. A platform marker without such a URL is shown as manual configuration and never redirects to the marketplace detail page. Search has no standalone page and professional tasks use the Host's loaded search tools when needed. Renderer actions call typed Remote APIs and never receive passwords, provider keys, connector secrets, downloaded ZIP bytes, imported-document source paths or bytes, or stored memory content.

The conversation composer exposes a native desktop file picker and file-drop surface. Any user-selected regular file can be copied into a private import directory for the current conversation; directories and symbolic links are rejected. PNG, JPEG, WebP, and GIF drops use the upstream image-attachment path. Mixed drops split images and documents, reusing the resident composer's image-intake callback, limits and lock rather than copying images as text-only documents. Document import returns only the file name, controlled relative path and size, never the source path or bytes.

Imported files live in per-conversation attachment state: the textarea receives no generated prose or duplicate success notice, and only a real submitted task gains the controlled references. Browser persistence preserves pending references across reloads. The desktop additionally stores unsent text, document references, and numbered annotations in its private user-data directory, so a changed loopback port or application update does not change their storage identity. Native hydration never overwrites edits made while its read is pending; malformed persisted references are discarded before prompt preparation. A failed send retains the cards. A successful send consumes only its prepared snapshot, preserving later imports and re-added references; settling after deletion cannot recreate the deleted draft. Clicking a card asks the desktop Host to open the controlled imported copy, while its close control removes only that reference from the current pending message. Neither action exposes an arbitrary path or deletes or moves a file. Legacy generated draft blocks migrate into the same state. The native picker remembers the last valid source directory. Actual reading remains format-dependent: supported Office and text documents use the signed document operations, and a scanned PDF still requires configured OCR.

Pasted image drafts use the same private native record and restore into the ordinary image-send registry. Encoding is cached until image ids change; pending writes drain their captured values during disposal, and a deleted conversation rejects late encodings. The existing 4 MiB aggregate draft-file limit covers image bytes too. Oversize or failed saves retain the in-memory draft and show a composer error; they do not silently claim restart preservation. File references never include document bodies, and no credentials enter this store.

Desktop image-transfer consent stores only explicitly approved provider IDs in a separate private user-data file, independent of the renderer's loopback port. An approval must commit before an image send proceeds. Read or write failures retain the draft with a retryable error; cancellation or a provider change during persistence cannot release the pending images. The browser-only client retains origin-local consent. See the [native consent decision](../../../.agents/notes/proposed/bug-fix/2026-09-04-native-image-consent.md).

The persisted browser store contains only the current page, selected provider family, account-dialog revision, and a cropped and compressed device-local avatar. Provider selection resolves an available model from the current Host directory; missing credentials or routes remain visible errors and never silently select another provider family. The model menu searches locally, collapses providers, and performs no provider validation when opened or when a model is selected. On desktop startup the Host model-connections service performs its one settled provider refresh. A later provider refresh follows an explicit `Refresh models` action. A retained `GC-MODEL-KEYCHAIN` error also permits one recheck for the responding provider after the first real model response of a turn; only a successful Host probe clears that error, and it never changes the selected route. After refresh settles, the selector forces a new read of the global model catalog. Connection, settings, credential, adapter, and Session-change notifications update availability and mirror the current Session's durable provider into the shell, but never call `session.selectModel`; only an explicit provider selection, configuration, or connection recheck may commit a model route. The product declares the nested Session Remote before binding that projection, so the first Session cannot race Remote namespace activation. This lets a resumed Session replace its transient Host default with the replayed durable selection without the product writing that transition back as a new default. One provider failure remains on that provider's status while healthy provider groups stay selectable. A rejected Host call, failed reread, or refresh with no configured usable provider clears the selectable rows and leaves a retryable error rather than presenting the whole catalog as fresh. The account client likewise awaits its settled Host refresh instead of retaining a transient `checking` state. A saved username, password, and token can therefore be restored from Keychain or Credential Manager without exposing them to the renderer. The login form defaults to saving credentials and automatic login, while still allowing the user to opt out. A connected sidebar account card shows only the local avatar and current username; required upgrades keep their blocking detail outside the connected state. On macOS, a signed application download displays percentage and remaining time, preserves a validator-bound prefix across restarts, and offers an explicit Continue update action without removing saved account material. On Windows, the title-bar close request opens a compact renderer dialog with a plain vertical radio list for minimizing to the tray or quitting through the normal runtime shutdown path. Remembering the choice persists it; Settings exposes a compact selector that can restore `Ask every time`.

Recent conversations preserve Host order. Holding the primary pointer for 180 milliseconds arms an enterprise-space or conversation row without changing the ordinary arrow cursor; dragging then uses a compact single-line preview, dims the source position, and marks the exact insertion edge or destination space without preordering the list. The context menu opens both Copy and Move to Enterprise Space submenus on pointer hover; Right Arrow remains the keyboard path, and moving to another primary action closes the submenu.

Copy deep link emits the product-owned `gongchuang://threads/<session-id>` URL. The packaged desktop application validates and receives the protocol, restores an archived local conversation before opening it, and refuses deleted or unknown local conversations. The URL is a same-device navigation reference, not a public share link.

Archived settings show only archived enterprise spaces and conversations, with Restore and Delete actions for each item; deleted items and their restore controls are not shown there. Desktop deletion sends only an opaque workspace or session id to the Electron Host. The Host resolves authoritative registry and persistence paths, flushes and disposes any Session lifecycle it owns, waits for persistence retirement, and then moves the enterprise directory or conversation artifact to the operating-system Trash. A conversation tombstone is durable before its artifact moves and is restored if Trash fails, while partial workspace moves keep the registry item available for retry. Successful deletion clears the deleted conversation's pending attachment draft; it never deletes an imported enterprise file merely because its composer card was closed.

Credential-backed MCP cards open connector-specific setup guides. QCC prefers a Login and authorize action that opens the official page in the system browser and completes the connection after the browser callback, while keeping a manual API-key fallback. Tianyancha and PaddleOCR use their respective official-token flows. A connector becomes ready only after the Host validates the credential and discovers at least one tool; clicking a completion action cannot manufacture a ready state. Failures remain selectable in both the page and guide and expose a Copy error action. The PaddleOCR guide discloses before authorization that the private Gongchuang Enterprise Assistant browser product shell uses Baidu AI Studio's official remote API, requires an explicit data-transfer acknowledgement, and distinguishes connection verification from later user-initiated file uploads.

QCC and Tianyancha browser approval do not hold the global settings queue. Cancel, Escape, dialog close and leaving the page cancel the exact Host transaction through registration, callback, token exchange and credential verification. Late results cannot replace credentials or close a newer dialog. Existing credentials are restored independently; incomplete restoration is reported as an error. A failed cancellation acknowledgement remains retryable, and Tianyancha's short pending poll permits explicit completion retry. Other connectors remain usable, and older snapshots cannot replace a newer Host revision.

On first desktop entry, the user chooses Hangzhou, Shaoxing, Jinhua, Ningbo, or `All` and confirms `Documents/洞见企业空间` as the enterprise root or selects another existing directory. The Host persists both choices outside the installation directory. Creating an enterprise takes only its name and prepares an immediate child of the active root; importing connects an existing concrete directory in place without copying or moving its files. Settings can switch the root used for later enterprises without moving already connected workspaces. City- and county-level content follows the current city; Zhejiang provincial and national projects and notices are shared across all four cities, while list queries retain the current-city boundary. An explicit geography in a task takes precedence. The city control in the branded area reopens the selector at any time and remounts only the knowledge connector. The closed selector draft tracks the settled Host snapshot, and saving includes that snapshot as the expected prior value so startup placeholders cannot overwrite a restored choice.

The active transcript uses the upstream `ui-chat` Turn Navigator. Gongchuang does not register a second turn rail; restored and prepended history, streaming performance, keyboard access, previews, and viewport tracking remain owned by the shared Chat implementation.

Selected transcript text is stored as per-conversation numbered annotations, separate from the editable draft. A count disclosure exposes the quotation, optional comment, and individual removal. Removal renumbers pending annotations and their source markers consecutively from one; deleting all restarts the next annotation at one. Restored drafts use the same sequence. Sent history and user-authored prose are not rewritten. Drafts survive browser reload and failed submission. Successful admission consumes only the prepared snapshot, preserving later additions and edits; deleting a conversation clears both annotation and document drafts. Documents and annotations render through `conversation.input.payload` inside the composer card, with full-width rows and wrapping attachments. File cards call the existing system-application opener and do not create a conversation. [Decision](../../../.agents/notes/implemented/feature/2026-09-03-gongchuang-numbered-annotations.md).

## Dev Note

This private product package contributes the branded client slots; security-sensitive account, connector, update, workspace, and file operations remain in the signed desktop Host services named above.

## Runtime Invariant

No runtime invariant companion is published because the signed Host composition pins this package, while Cordis owns the persisted view store and slot lifecycle.

## Model Experience

### Provider configuration

#### What the model sees

The configuration UI does not put provider credentials, connection errors, or saved-key status in model messages. Explicit model selection changes the Host route used for the next request. Failed key-replacement probes preserve the Host's known saved-credential presence and the stored-key recovery action. A failed snapshot reread or rejected configure/refresh transport remains a visible error, not an indefinite loading state or a declaration that the saved key has disappeared.

#### Token effect

Configuration and connection probes add no conversation tokens.

#### KV Cache effect

Configuration adds no prompt prefix. A selected provider and model use that route's cache behavior.

### Numbered annotations

#### What the model sees

An ordinary durable user message carries the numbered quotations, their source row identifiers, comments, and current user prose. A short instruction distinguishes historical quotations from new requests. The separate durable display text projects file cards, the annotation count, and the original body; no new Session event or RPC method is introduced. Annotation-only submission is supported. Quoted text is not trusted evidence or authorization.

#### Token effect

Selections and comments add input tokens only when submitted. Opening a disclosure, editing a comment, removing a pending item, and opening a file make no model request.

#### KV Cache effect

Annotations append with the next user message. Existing transcript content and earlier request prefixes remain unchanged.

### Local graph-memory controls

#### What the model sees

The settings page changes whether the Host extracts and recalls local memory and whether tool results may participate in extraction. It never sends a chat message or memory content to the renderer; the model-visible recall and tools are owned by `@gongchuang/graph-memory`.

#### Token effect

Opening the settings page, reading aggregate counts, changing a toggle, or clearing local memory adds zero direct tokens. Later requests reflect the Host setting through the memory package.

#### KV Cache effect

The controls do not rewrite a conversation. A preference change or clear operation can change later memory-context suffixes while preserving earlier messages.

### Task-driven evidence search

#### What the model sees

The shell exposes no standalone search submission and does not append a separate search message. Professional skills and the signed Host decide whether the current business task calls 共创联网检索 MCP, `web_search`, or `web_fetch`, then apply their own source and evidence requirements.

#### Token effect

The sidebar and MCP status display add no tokens. Search adds model-input and tool-result tokens only when the current business conversation actually invokes a search tool.

#### KV Cache effect

Search results stay in the enterprise conversation that requested them and preserve its earlier reusable prefix; the shell does not create a second search-only conversation.

### Local automation dispatch

#### What the model sees

After the Host issues a due or manual claim, the shell sends one ordinary user message containing the local task name, scheduled time, signed-policy reminder, and stored task prompt; failed or unclaimed runs send no model request. Prompt admission is not a success receipt: the client watches the created ordinary Session until a finalized assistant turn or terminal error arrives, then records `已完成` or `失败` together with the durable result-session id. When creating or editing a task, a user may fill reviewable schedule fields from Chinese phrases such as `每天上午 9 点`, `每周一上午 9 点`, or `每隔 90 分钟`, or manually select the first run, a preset cadence, or a custom interval from five minutes through 365 days. Natural-language recognition only fills the form and never bypasses the final Save and enable action.

#### Token effect

Each dispatched run adds one wrapper plus the stored prompt. Polling and task-list rendering add zero tokens.

#### KV Cache effect

The automation message appends to the task's enterprise workspace session. Earlier history stays prefix-stable; changing the task affects only future appended messages.

## Known Limitations and Deferred Work

- Browser rendering is not a security boundary; the signed desktop Host must authenticate RPC, pin this package, and enforce provider, tool, third-party, and delivery policy.
- The shell depends on Host services for native file pickers, credential storage, external authorization pages, installation, and task execution; missing services fail visibly instead of falling back to browser-only simulations.
- Import accepts regular files but never scans directories or follows symbolic links. Copying a file into the workspace does not imply that its format can be parsed by an installed tool.
- Queued file and annotation messages display a compact file-name/count/prose summary. They retain removal and steering but do not offer a plain-text editor that would discard the attached context.
- The memory page shows aggregate personal and enterprise counts and can clear all local graphs; individual graph-node editing remains outside the private Gongchuang Enterprise Assistant browser product shell.
