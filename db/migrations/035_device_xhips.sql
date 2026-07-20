-- Device xhips (Mark, 2026-07-20): a xell can attach a MOBILE DEVICE as another xhip — a role
-- alongside db/server/webapp — so a zee can build, install and drive real apps on it. Android
-- first, two shapes under ONE role:
--   emulator (per-xell)  : an Android emulator in a container (budtmo/docker-android), docker-run
--                          by the queenzee like the isolated per-xell db. adb on 5555, a noVNC web
--                          viewer on 6080. Torn down with the xell (owner_xell_id) — no new reaper
--                          code: the reaper already stop/rm's every owner_xell_id container.
--   physical (shared)    : a real phone reachable over network adb, pinned to a machine, modeled as
--                          a shared device row a xell LINKS ('uses') — like a shared dev db.
-- The health monitor, decommission, and reaper are all role-agnostic, so a 'device' row rides all
-- of them for free. The zee reaches it over TCP (adb connect host:port) exactly as it reaches its
-- app tier — the cxell egress firewall is default-allow, so no rule change.
ALTER TYPE container_role ADD VALUE IF NOT EXISTS 'device';

-- An Android emulator needs hardware acceleration (/dev/kvm) → a Linux host with nested-virt. This
-- is the same shape as can_build (023): a capability of the HOST, not of any one xell. Provisioning
-- REFUSES an emulator on a machine that lacks it — by name, with the fix — instead of standing up a
-- container that crash-loops with "KVM not available". A physical device also hangs off a can_device
-- machine (that host is where the phone is tethered / its adb server runs).
ALTER TABLE machine ADD COLUMN IF NOT EXISTS can_device boolean NOT NULL DEFAULT false;
