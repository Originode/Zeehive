# Modifying production data on the self-hosted project (ZEEHIVE)

When ZEEHIVE orchestrates **itself**, the project's production database **is** the managing
instance's own meta-DB (the postgres the live queenzee is connected to). That is not a
configuration mistake — it is the self-hosting shape.

## Why a writable prod bind is refused

A xell on `db-shared-prod` receives a full-write `DATABASE_URL` and runs its own nested
queenzee against it. Two reconcilers on one meta-DB reap each other's xells. That failure
class has destroyed live work before, so a writable bind is a **refusal**, not a warning:

- attach (`attachXellDb` / `attachProdStack`) refuses
- `zee prod` refuses the ask up front (no pending BIND card for a human)
- confirming a leftover ask refuses without flipping the request to `confirmed`

The manager path (`db-prod-readonly`) is the deliberate exemption: a minted SELECT-only
postgres role with `default_transaction_read_only=on`. It can read the live fleet estate;
it cannot reap anything.

## How an agent modifies prod data safely

**`zee seed`** — the ship gate's division of labour applied to data:

1. Write an **idempotent** `*.sql` under `server/sql/seeds/`
2. Commit and **`zee land`** (the file must be on main — the queenzee reads it from the xource)
3. **`zee seed --file server/sql/seeds/<name>.sql --reason "…"`**
4. A human reads the exact SQL in the console and approves
5. The **queenzee** runs it against production; the zee never holds the live DSN

Safeguards already on that path:

| safeguard | what it prevents |
|---|---|
| only `server/sql/seeds/*.sql` | "approve" never means "run any file in the repo on prod" |
| must be on main | anti-band-aid — what ran is always readable by sha |
| human reads SQL before run | no silent agent writes |
| queenzee runs, not the zee | nested cage never receives a write credential |
| `assertProdDbTarget` | refuses if the target is not the registry's prod db |
| refuses while prod lock held | no data write under a half-swapped deploy |
| not ledgered; prior runs shown | re-runs are a decision, not a surprise |

Existing examples in this repo: `server/sql/seeds/spawn_prep_psql_for_zeehive.sql`,
`server/sql/seeds/ai_model_spec_wire_ids.sql`.

## What to dispatch, depending on the job

| job | dispatch |
|---|---|
| change rows in production | ordinary **worker**; it uses `zee seed` (no prod bind) |
| **read** live production | **manager** (`db-prod-readonly`) |
| develop against prod-shaped data without writing live | worker on `db-isolated` (latest dump), `db-clone`, or `db-shared-dev` |
| change **schema** | migrations under `db/migrations/` (or `server/sql/migrations/` for deploy-time projects), then ship — never ad-hoc DDL on shared-dev |

## What is deliberately not provided

There is no "limited write role" for a worker against the meta-DB. A role that can
`UPDATE xell` or `DELETE FROM container` is still a nested reaper. The seed path is narrower
on purpose: the human sees the exact SQL, the queenzee runs it once, and the agent never
holds the credential.

Interactive prod surgery on the meta-DB is a **human** action (or a seed), not a bound agent.
