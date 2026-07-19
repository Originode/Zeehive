-- Ship-notification dismissal — same fix as landings got in 024. A shipped/failed ship_request
-- card lingers in the PRODUCTION panel (15-minute window), and several back-to-back deploys pile
-- them up with no way to clear them. Dismissal is a view-only fact about the RECEIPT's visibility,
-- never its status: a dismissed ship still shipped, it just stops showing. Server-side so a reload
-- or SSE refresh doesn't resurrect it.
ALTER TABLE ship_request
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz,
  ADD COLUMN IF NOT EXISTS dismissed_by text;
