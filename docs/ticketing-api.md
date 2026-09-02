# The external ticketing API — `/api/ext/v1`

**Status: built.** Migration `190_external_ticketing_api_keys_and_attachments.sql`,
`server/src/lib/project-api-keys.js`, `server/src/lib/ticket-attachments.js`,
`server/src/lib/ticket-intake.js`, routes in `server/src/api/routes.js`, console panel in
`web/src/ProjectSetup.jsx`, test `test/ticket-api-external.test.mjs`.

This is the door a **deployed project** files tickets through. It is the outside of the work
tracker documented in [work-tracker.md](work-tracker.md) — the nouns and the statuses are that
document's, and nothing here is a second tracker.

```
omnibiz, running on somebody else's server
        │  POST /api/ext/v1/tickets      Authorization: Bearer zhk_…
        ▼
   an ORDINARY `ticket` row on the omnibiz project's board in ZEEHIVE
        │  a human or a manager zee breaks it down
        ▼
   work items ──assigned──▶ a zee in a xell         ← the integration WATCHES this happen
```

## 0. Reachability — where this API actually lives

The server behind `/api/ext/v1` is **the ZEEHIVE queenzee**. A "deployed project" is a system
running on **another host** — it has no xell, no console, no token; it holds a key and files
tickets over HTTP. For that to work, the other host must be able to reach the queenzee over the
network. That is a fact about the deployment, not a constant, and this section is the honest
version of it.

**The address an integrator should use is the API's own `base_url` answer, not a guessed
constant.** Resolve it with the keyless probe (below) before you wire anything:

```sh
curl -s http://<the server you already know>/api/ext/v1/limits
# → { "ok": true, "base_url": "http://10.1.0.15:4700", "attachments": { … } }
```

`GET /api/ext/v1/limits` needs **no key**, and `GET /api/ext/v1/whoami` (with a key) carries the
same `base_url`. Both are generated from the server's single operator-settable value, so an
integrator reading `base_url` off the API can never drift from the deployment.

**How the address is set.** The server reads it from one place:

| where | what |
|---|---|
| env `EXT_API_BASE` | the operator's explicit answer — a LAN `http://host:port`, a tunnel URL, or a reverse-proxy origin. **This is the one knob.** |
| env `DEV_HOST_IP` | fallback when `EXT_API_BASE` is unset: the queenzee host's LAN address on the API port (`http://<DEV_HOST_IP>:4700`) |
| neither set | `base_url` is `null` — **no externally-reachable address is configured**. The API says so plainly; it does not invent one. |

**What "deployed project" means for reachability, today.** ZEEHIVE has **LAN ingress only**: the
queenzee publishes its API port on its host and answers on that host's LAN address. There is no
public URL unless the operator puts a tunnel or reverse proxy in front and sets `EXT_API_BASE` to
it. So today a deployed project can file tickets if it can reach the queenzee's LAN address; it
cannot from the public internet, and no amount of `host.docker.internal` cleverness changes that —
that name means "the docker host *I* am running on", which for a deployed project is **its own
host**, where no queenzee listens. That is the exact mistake that broke the omnibiz bridge (§6).

**The `base_url` you see is the address you should hand the integration.** Do not substitute
`host.docker.internal` for it, and do not copy a constant out of this document — read it off
`/api/ext/v1/limits` or `/api/ext/v1/whoami`.

## Why it exists

Everything a deployed project knows about its own faults — the exception its users hit, the log its
helpdesk collected, the screenshot somebody pasted into a chat — used to have to be **retyped by a
human** into the console before a zee could work on it. The board was therefore always a summary of
what somebody had gotten around to copying.

With a key, the deployed system files the ticket itself, with its evidence attached, and then reads
the same ticket back to see what the fleet did about it.

## 1. Getting a key

Keys are **per project** and minted by a human in the console (Project setup → *Ticketing API
keys*), or over the console API (`<base_url>` is the address from §0):

```sh
curl -sX POST http://<base_url>/api/projects/<project-id>/api-keys \
     -H 'Content-Type: application/json' \
     -d '{"label":"omnibiz helpdesk","scopes":["tickets:read","tickets:write"]}'
```

The answer carries `key` — **the one and only time the plaintext exists outside the caller's
hands.** Only its sha256 hash is stored (the same shape as a cxell's identity token,
`lib/xell-token.js`), so a lost key is re-minted, never recovered. Every later read shows
`key_hint` (`zhk_ab12…7f9c`).

| | |
|---|---|
| **scopes** | `tickets:read` (list/get/download) · `tickets:write` (file/update/comment/attach) |
| **revoke** | `POST /api/projects/:id/api-keys/:keyId/revoke` — takes effect on the next call |
| **delete** | only a key that has filed **nothing**. One that filed tickets is revoked instead, so the board can still say where those tickets came from |
| **last used** | stamped on every accepted call, so a dead integration is visible in the console |

## 2. The three rules

1. **The project comes from the KEY, never from the body.** The caller cannot name a project, so it
   cannot reach another one — the same construction the cxell verbs use. A body that *does* carry
   `project` is refused with a 400 rather than ignored: a caller that thinks it chose a project
   will one day be surprised.
2. **A repeat POST is the same ticket.** Send your own id as `external_ref`. It is unique per
   project, so the retry you never saw the answer to returns the FIRST ticket with `deduped: true`
   (HTTP **200**, where a fresh file is **201**). Without an `external_ref` there is no
   idempotency, and the answer says so.
3. **The reporter owns the intake, the fleet owns the work.** You may edit what you reported
   (`title`, `body`, `kind`, `priority`, `labels`, `reporter`, `external_url`) and may set
   `cancelled` (withdraw) or `queued` (reopen). You may **not** set `working`, `review`, `shipping`
   or `done`, and may not set an assignee: those are assertions about what zees are doing, and a
   helpdesk saying "working" because somebody clicked it in *its* UI is a lie the board then
   renders. Everything else you want to say goes in a **comment**.

## 3. The endpoints

Every one takes `Authorization: Bearer zhk_…` (or `X-Zeehive-Api-Key`). `:ref` is a ticket id, its
code (`TKT-52-2518`), its ref (`#52`) or its bare number — numbers are per project and are resolved
inside the key's project.

| | |
|---|---|
| `GET /api/ext/v1/whoami` | which project this key files into, its scopes, the vocabulary, the limits — and `base_url` (§0) |
| `GET /api/ext/v1/limits` | the attachment limits and `base_url`, **without a key** (a build script can resolve the address and check a file size before it holds a credential) |
| `POST /api/ext/v1/tickets` | file one — `attachments[]` rides along; answer carries `notified` (which managers woke, or why none did) |
| `GET /api/ext/v1/tickets` | list yours — `?status=` `?kind=` `?q=` `?external_ref=` |
| `GET /api/ext/v1/tickets/:ref` | **monitor** one: status, comments, attachments, and what the fleet is doing |
| `PATCH /api/ext/v1/tickets/:ref` | update what you reported (rule 3) |
| `POST /api/ext/v1/tickets/:ref/comments` | comment — `attachments[]` rides along and is stamped with the comment |
| `POST /api/ext/v1/tickets/:ref/attachments` | attach more evidence |
| `GET /api/ext/v1/tickets/:ref/attachments` | list the evidence |
| `GET /api/ext/v1/tickets/:ref/attachments/:attachmentId` | download one — the raw bytes |

**Read your vocabulary from `whoami`, not from this table.** `ticket_kinds`, `settable_statuses`,
`editable_fields` and the attachment limits are generated from the same constants the server
validates against; a client that hardcodes them from prose will drift, and this document will not
tell it.

### File a ticket with its evidence

`<base_url>` is the address this API answers at — resolve it with the keyless `GET
/api/ext/v1/limits` (§0), never hardcode it:

```sh
BASE_URL=$(curl -s http://<the server you already know>/api/ext/v1/limits | jq -r .base_url)

curl -sX POST "$BASE_URL/api/ext/v1/tickets" \
  -H "Authorization: Bearer $ZEEHIVE_TICKET_KEY" -H 'Content-Type: application/json' -d '{
    "title": "Checkout 504s on payment",
    "body":  "Every third order fails at the gateway.",
    "kind":  "bug",
    "priority": 1,
    "external_ref": "OMNI-4471",
    "external_url": "https://omnibiz.example/desk/4471",
    "reporter": "desk@omnibiz",
    "labels": ["checkout"],
    "attachments": [
      { "filename": "screenshot.png",     "content_base64": "iVBORw0KGgo…" },
      { "filename": "order-service.log",  "text": "2026-08-11T05:00:00Z ERROR …" },
      { "filename": "gateway.xml",        "content_type": "text/xml", "text": "<report>…</report>" }
    ]
  }'
```

```json
{ "code": "TKT-41-9c2b", "ref": "#41", "status": "queued", "priority": 1,
  "attachments": [ { "id": "…", "filename": "screenshot.png", "kind": "image", "sha256": "…",
                     "download_url": "/api/ext/v1/tickets/…/attachments/…" } ],
  "work": { "items": [], "count": 0, "open": 0 }, "deduped": false,
  "notified": { "managers": ["omnibiz-mgr"], "reason": null } }
```

`notified` is create-only (POST, including a deduped 200). It is the observability contract: the
caller must be able to tell whether anybody woke.

| | |
|---|---|
| `notified.managers` | slugs of the project's deployed managers that were actually reached (inbox always; typed into a live cxell when one exists) |
| `notified.reason` | `null` when `managers` is non-empty; otherwise why none were — `"no live manager in this project"` on a fresh create, or `"deduped: already filed"` on a repeat (which never re-notifies) |

A `201` with `"managers": []` and `"reason": "no live manager in this project"` is a ticket that
exists and nobody knows about — treat it as a problem in the integrator, not as health.

### Monitor it

```sh
curl -s "$BASE_URL/api/ext/v1/tickets/TKT-41-9c2b" -H "Authorization: Bearer $KEY"
```

```json
{ "code": "TKT-41-9c2b", "status": "working", "status_label": "working",
  "settable_statuses": ["queued", "cancelled"],
  "comments": [ { "author": "zee", "body": "Reproduced on staging.", "created_at": "…" } ],
  "work": { "count": 2, "open": 1,
            "items": [ { "title": "Add a retry with backoff", "status": "working", "progress": 40 } ] } }
```

`work` is the whole monitoring story: **titles, statuses and progress**. The external shape
deliberately carries no xell ids, no api_key_id and no internal counts — an integrator is told what
its ticket IS and what is happening to it, not who is doing it.

## 4. Attachments

Images and text logs, stored as `bytea` in the meta-DB — the thing this fleet backs up and every
container can reach. Two shapes, and a caller uses whichever suits it:

- `"text": "…"` — a log, no base64 round trip in your code;
- `"content_base64": "…"` — an image, or anything binary. Invalid base64 is **refused** rather than
  silently truncated into a corrupt file.

| | |
|---|---|
| accepted types | `image/png` `image/jpeg` `image/gif` `image/webp` `image/svg+xml` · `text/plain` `text/markdown` `text/csv` `text/xml` `application/xml` `application/json` `application/x-ndjson` `application/yaml` `text/yaml` · `application/pdf` |
| class (`kind`) | `image` · `log` · `data` · `file` — derived from the content type, for a UI to render by |
| limits | **10 MB** an attachment, **50 MB** and **50** files a ticket |
| integrity | every row carries a `sha256`; the download answers with `X-Attachment-Sha256` |
| serving | always `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` — content somebody else uploaded is never rendered inline in the console's origin |

The content type is taken from `content_type`, or inferred from the filename's extension. Anything
outside the list is refused **by name**, with the accepted list in the message; bigger evidence
belongs behind a URL in the ticket body.

**A rejected attachment never costs you the ticket.** A batch is not a transaction: what could be
stored is stored, and the answer names what was not and why (`attachments_rejected`). A single
attachment posted on its own raises its own error instead (400 for bad input, 409 for a limit), so
one file's failure is never flattened into a batch verdict.

## 5. What a ticket looks like from the inside

The row is an ordinary `ticket` (migration 058) with four provenance columns added by 190:

| column | |
|---|---|
| `source` | `api:<key label>` — or null for a ticket a human filed in the console |
| `external_ref` | the caller's own id. Unique per project; this is the idempotency key |
| `external_url` | a link back into the system that filed it, for the human reading the board |
| `api_key_id` | which key filed it (`ON DELETE SET NULL`; keys are revoked, not deleted) |

So the console's tickets window, `zee work`, breakdown, assignment and the board all treat an
externally-filed ticket exactly like any other — because it is one.

## 6. Integrating a helpdesk (the omnibiz shape)

The intended loop, for a project that has a helpdesk already:

1. store the key as a secret in the deployed project (never in its repo);
2. on a new helpdesk case, `POST /api/ext/v1/tickets` with the case id as `external_ref` and the
   case URL as `external_url`, attaching whatever the customer sent — the project's deployed
   manager zees are notified on intake (inbox / live session), so the fleet learns it exists;
3. on every later reply, `POST …/comments` (attachments ride along);
4. poll `GET /api/ext/v1/tickets/:ref` — or the whole list — and mirror `status`, `status_label`
   and `work.items[].progress` back into the helpdesk;
5. when the customer withdraws the case, `PATCH` it to `cancelled`.

A project with **no** helpdesk gets the same value from a thin client: a form, a crash handler, or
a CI job that files a ticket when a smoke test fails.

### What the omnibiz bridge must change (TKT-184)

The omnibiz helpdesk→ZEEHIVE bridge was built on the wrong address and sat **silently broken for
two weeks**: no ticket it filed ever reached a board, and nothing said so. The concrete corrections
on the omnibiz side:

- **`ZEEHIVE_TICKETS_BASE_URL` must default to the resolved `base_url` from §0, not
  `http://host.docker.internal:4700`.** That string means "the docker host I am running on" — for
  the deployed omnibiz service that is **omnibiz's own host**, where no ZEEHIVE queenzee listens.
  Read the real address with the keyless probe and point the client at it:
  ```sh
  BASE_URL=$(curl -s -m 10 http://<queenzee host>:4700/api/ext/v1/limits | jq -r .base_url)
  export ZEEHIVE_TICKETS_BASE_URL="$BASE_URL"
  ```
- **Drop the `extra_hosts: host.docker.internal:host-gateway` wiring from
  `docker-compose.prodsrc.yml`.** It exists to make `host.docker.internal` resolve to the deployed
  host — the wrong address, made reachable. With the base URL set to the real queenzee address the
  alias is both useless and a standing invitation to re-break the default.
- The ZEEHIVE-side address is **LAN-only today** (see §0): omnibiz prod (host `10.2.0.16`) must be
  able to route to the queenzee host (`10.1.0.15`, port `4700`) over the LAN, or a human must stand
  up a tunnel/reverse proxy and set `EXT_API_BASE` on the server to the public URL. Whether to build
  that ingress is a deployment decision, not an integration one.

## 7. What this deliberately does NOT do

- **It does not assign, break down, or cast work.** Those are fleet verbs, and rule 3 is the same
  argument. Filing through this door DOES notify the project's deployed manager zees (the same
  `ticketManagers` + `notifyManagerOfTicket` path the console's Notify button and
  `zee ticket --notify` use): the message lands in each manager's inbox, and is typed into a live
  cxell session when one exists. A notification is not an order — nothing is assigned and no work
  is cast. A deduped retry does not re-notify.
- **It has no rate limiting of its own.** The key is the only gate today. If a key is abused,
  revoke it — and put a rate limit in front of the queenzee, where the rest of the ingress lives.
- **It is not a webhook OUT.** An integration polls; nothing calls back into the deployed project.
  That is the obvious next piece of work and is not built.

## 8. Proving it

`test/ticket-api-external.test.mjs` drives the whole surface over real HTTP against the real
express router: minting and revoking keys, every refusal at the door, filing with evidence
(and the manager-inbox notify that filing triggers), idempotency (including that a deduped
retry does not re-notify), a byte-identical attachment round trip, monitoring by id/code/number,
the update rules, cross-project isolation, and the console's view of the same rows.

```sh
DATABASE_URL=… node test/ticket-api-external.test.mjs
```

It **writes**, so in a cxell point it at `zee db-sandbox --migrate`'s DSN, never at a database whose
rows matter.
