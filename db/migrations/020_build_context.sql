-- Build-location toggle: compile a per-xell image on a BEEFY docker context, then RUN it on the
-- xell's own (weak) context. The NAS that hosts the fleet was never built for heavy compute; the
-- prod box (and this dev PC) can compile far faster. This lets a zee/human move ONLY the compile.
--
-- container.build_ctx : which docker context COMPILES this container's image.
--                       NULL ⇒ build on docker_ctx (the run context) — today's behavior, exactly.
--                       A non-null value DIFFERENT from docker_ctx engages the registry handoff
--                       (build there → push → pull here → run), see scripts/build-container.sh.
ALTER TABLE container ADD COLUMN IF NOT EXISTS build_ctx text;

-- project.registry : the OCI registry (host[:port][/path]) used to hand a cross-context image
--                    from the build daemon to the run daemon. Required only for split builds; NULL
--                    ⇒ no split is possible for this project (the API refuses a foreign build_ctx
--                    with an actionable "configure a registry" error rather than failing at push).
--                    Put it on the LAN — a registry behind a slow link makes split builds SLOWER.
ALTER TABLE project ADD COLUMN IF NOT EXISTS registry text;
