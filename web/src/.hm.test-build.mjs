import React, { useEffect, useState, useCallback } from "react";
import { getHarnesses, getHarnessFull, createHarness, updateHarness, deleteHarness, getModelSpecs } from "./api.js";
import { emptyWarning } from "./harnessHealth.js";
import ZeeAvatar from "./ZeeAvatar.jsx";
import { PROVIDER_ART } from "./providerArt.js";
import {
  GEAR_ART,
  GEAR_KEYS,
  gearKeyFor,
  ACCESSORY_ART,
  ACCESSORY_CATEGORIES,
  MAX_ACCESSORIES,
  accessoriesByCategory,
  accessoriesFor
} from "./harnessGear.js";
const blank = () => ({
  label: "",
  glyph: "",
  gear: "",
  accessories: [],
  custom_accessories: [],
  summary: "",
  personality: "",
  avatar_svg: "",
  parent: null,
  zee_type: "worker",
  scope: "global",
  project_id: null,
  project_name: null,
  skills: [],
  memory: [],
  model_policy: {},
  router_policy: {},
  enabled: true,
  upload_conversations_on_done: false,
  enable_reflection: true,
  inherited: { skills: [], memory: [], chain: [] }
});
const chars = (t) => `${String(t || "").length.toLocaleString()} chars`;
const fileSafe = (s) => String(s || "note").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "note";
const skillFile = (name) => fileSafe(name || "skill");
const memFile = (path) => `${fileSafe(String(path || "memory").split("/").pop()).replace(/\.md$/, "")}.md`;
function briefingChars(form) {
  if (!form) return 0;
  const len = (t) => String(t || "").length;
  const sum = (arr, pick) => (arr || []).reduce((n, x) => n + len(pick(x)), 0);
  return len(form.personality) + sum(form.skills, (s) => `${s.name}${s.when}${s.body}`) + sum(form.memory, (m) => m.text) + sum(form.inherited?.skills, (s) => `${s.name}${s.when}${s.body}`) + sum(form.inherited?.memory, (m) => m.text);
}
function InheritedEntry({ icon, name, note, text }) {
  const [open, setOpen] = useState(false);
  return /* @__PURE__ */ React.createElement("div", { className: "hm-inh" }, /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: "hm-inh-head",
      onClick: () => setOpen(!open),
      "aria-expanded": open,
      title: open ? "collapse" : "read it"
    },
    /* @__PURE__ */ React.createElement("span", { className: "hm-inh-caret" }, open ? "\u25BE" : "\u25B8"),
    " ",
    icon,
    " ",
    /* @__PURE__ */ React.createElement("b", null, name),
    note ? /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, " \u2014 ", note) : null,
    /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, " (", chars(text), ")")
  ), open && /* @__PURE__ */ React.createElement("textarea", { className: "disp-input hm-ta hm-mono", rows: 20, value: text || "", readOnly: true, spellCheck: false }));
}
function AvatarField({ svg, onChange }) {
  const [err, setErr] = useState(null);
  const looksSvg = /^<svg[\s>]/i.test(String(svg || "").trim());
  const take = (text) => {
    const t = String(text || "").trim();
    if (t && !/^<svg[\s>]/i.test(t)) {
      setErr("that is not an SVG document (it must start with <svg \u2026>)");
      return;
    }
    setErr(null);
    onChange(t);
  };
  return /* @__PURE__ */ React.createElement("div", { className: "disp-field", "data-testid": "harness-avatar-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Badge art ", /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, "SVG, stored in the meta-DB \u2014 no repo needed", svg ? `, ${chars(svg)}` : "")), /* @__PURE__ */ React.createElement("div", { className: "hm-avatar-row" }, /* @__PURE__ */ React.createElement("div", { className: "hm-avatar-prev", "aria-label": "badge preview" }, looksSvg ? /* @__PURE__ */ React.createElement("img", { alt: "", src: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, width: 48, height: 48 }) : /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, "none")), /* @__PURE__ */ React.createElement("div", { className: "hm-avatar-acts" }, /* @__PURE__ */ React.createElement("input", { type: "file", accept: ".svg,image/svg+xml", onChange: async (e) => {
    const f = e.target.files?.[0];
    if (f) take(await f.text());
    e.target.value = "";
  } }), svg ? /* @__PURE__ */ React.createElement("button", { type: "button", className: "hm-del", onClick: () => take(""), title: "Remove the badge art" }, "\u{1F5D1} clear") : null)), /* @__PURE__ */ React.createElement(
    "textarea",
    {
      className: "disp-input hm-ta hm-mono",
      rows: 4,
      value: svg,
      spellCheck: false,
      placeholder: "<svg xmlns=\u2026>  \u2014 paste the badge here, or load a file above",
      onChange: (e) => onChange(e.target.value),
      onBlur: (e) => take(e.target.value)
    }
  ), err && /* @__PURE__ */ React.createElement("div", { className: "disp-hint hm-avatar-err" }, err));
}
function WornPreview({
  label,
  glyph,
  gear,
  accessories = [],
  custom_accessories = [],
  onGear,
  onAccessories,
  onCustomAccessories,
  keys = ["claude", "openai", "kimi"]
}) {
  const harness = {
    label: label || "this harness",
    glyph,
    gear,
    accessories,
    custom_accessories
  };
  const derived = gearKeyFor({ label, glyph });
  const worn = accessoriesFor(harness);
  const selected = new Set((accessories || []).map((k) => String(k).toLowerCase()));
  const atCap = selected.size >= MAX_ACCESSORIES;
  const toggle = (key) => {
    if (!onAccessories) return;
    const k = String(key).toLowerCase();
    if (selected.has(k)) {
      onAccessories((accessories || []).filter((x) => String(x).toLowerCase() !== k));
      return;
    }
    if (atCap) return;
    onAccessories([...accessories || [], k].slice(0, MAX_ACCESSORIES));
  };
  const clearAccessories = () => {
    if (onAccessories) onAccessories([]);
  };
  const addCustom = ({ label: lab, category, svg }) => {
    if (!onCustomAccessories || !onAccessories) return;
    if (atCap) return;
    const key = `custom-${String(lab || "acc").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)}-${Math.random().toString(36).slice(2, 6)}`;
    const next = [...custom_accessories || [], { key, label: lab || key, category, svg }];
    onCustomAccessories(next);
    onAccessories([...accessories || [], key].slice(0, MAX_ACCESSORIES));
  };
  const catLabel = { border: "Borders", hat: "Hats", equipment: "Equipment" };
  const catHint = {
    border: "frame the provider coin (behind it)",
    hat: "sit on top of the provider",
    equipment: "tools & face gear \u2014 same language as the old single costume"
  };
  return /* @__PURE__ */ React.createElement("div", { className: "disp-field", "data-testid": "harness-worn-preview" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Worn ", /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, "how a zee wearing it is drawn: the AI provider is the coin, this harness wears up to ", MAX_ACCESSORIES, " accessories around it")), /* @__PURE__ */ React.createElement("div", { className: "zav-worn" }, keys.filter((k) => PROVIDER_ART[k]).map((k) => /* @__PURE__ */ React.createElement("span", { key: k, className: "hm-worn-one" }, /* @__PURE__ */ React.createElement(ZeeAvatar, { provider: k, harness, size: 62 }), /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, PROVIDER_ART[k].label)))), /* @__PURE__ */ React.createElement("div", { className: "hm-acc-summary", "data-testid": "harness-accessories-summary" }, worn.length ? /* @__PURE__ */ React.createElement(React.Fragment, null, "Wearing: ", worn.map((a) => a.label).join(" \xB7 "), /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, " (", worn.length, "/", MAX_ACCESSORIES, ")")) : /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, "no accessories yet \u2014 falls back to the name-derived costume"), (accessories || []).length > 0 && /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: "hm-del",
      "data-testid": "accessories-clear",
      onClick: clearAccessories,
      title: "Clear accessories \u2014 fall back to name-derived gear"
    },
    "clear"
  )), onAccessories && ACCESSORY_CATEGORIES.map((cat) => {
    const builtIn = accessoriesByCategory(cat).filter((k) => ACCESSORY_ART[k]);
    const customs = (custom_accessories || []).filter((c) => c.category === cat);
    return /* @__PURE__ */ React.createElement("div", { key: cat, className: "hm-acc-cat", "data-testid": `accessory-cat-${cat}` }, /* @__PURE__ */ React.createElement("div", { className: "hm-acc-cat-head" }, /* @__PURE__ */ React.createElement("b", null, catLabel[cat]), /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, " \u2014 ", catHint[cat])), /* @__PURE__ */ React.createElement("div", { className: "disp-models hm-gear-pick", role: "group", "aria-label": catLabel[cat] }, builtIn.map((k) => {
      const on = selected.has(k);
      const disabled = !on && atCap;
      return /* @__PURE__ */ React.createElement(
        "button",
        {
          type: "button",
          key: k,
          className: `disp-seg ${on ? "on" : ""}`,
          "data-testid": `acc-${k}`,
          disabled,
          title: on ? `Remove ${ACCESSORY_ART[k].label}` : disabled ? `Already wearing ${MAX_ACCESSORIES}` : `Wear ${ACCESSORY_ART[k].label}`,
          onClick: () => toggle(k)
        },
        ACCESSORY_ART[k].label
      );
    }), customs.map((c) => {
      const on = selected.has(c.key);
      const disabled = !on && atCap;
      return /* @__PURE__ */ React.createElement(
        "button",
        {
          type: "button",
          key: c.key,
          className: `disp-seg ${on ? "on" : ""}`,
          "data-testid": `acc-${c.key}`,
          disabled,
          title: c.label,
          onClick: () => toggle(c.key)
        },
        c.label,
        " ",
        /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, "custom")
      );
    })));
  }), onCustomAccessories && /* @__PURE__ */ React.createElement(CustomAccessoryAdd, { atCap, onAdd: addCustom }), onGear && (accessories || []).length === 0 && /* @__PURE__ */ React.createElement("div", { className: "disp-models hm-gear-pick", role: "group", "aria-label": "Legacy single costume" }, /* @__PURE__ */ React.createElement("span", { className: "disp-hint hm-acc-legacy" }, "Single costume (when no accessories picked):"), /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: `disp-seg ${gear ? "" : "on"}`,
      "data-testid": "gear-derive",
      title: `Choose the costume from the harness's name \u2014 this one reads as "${GEAR_ART[derived].label}"`,
      onClick: () => onGear("")
    },
    "from the name \xB7 ",
    GEAR_ART[derived].label
  ), GEAR_KEYS.map((k) => /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      key: k,
      className: `disp-seg ${gear === k ? "on" : ""}`,
      "data-testid": `gear-${k}`,
      title: `Always wear the ${GEAR_ART[k].label}`,
      onClick: () => onGear(k)
    },
    GEAR_ART[k].label
  ))));
}
function CustomAccessoryAdd({ atCap, onAdd }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState("hat");
  const [svg, setSvg] = useState("");
  const [err, setErr] = useState(null);
  const submit = () => {
    const t = String(svg || "").trim();
    if (!t || !/^<svg[\s>]/i.test(t)) {
      setErr("paste an SVG document (it must start with <svg \u2026>)");
      return;
    }
    if (!label.trim()) {
      setErr("give it a short name");
      return;
    }
    setErr(null);
    onAdd({ label: label.trim(), category, svg: t });
    setLabel("");
    setSvg("");
    setOpen(false);
  };
  if (atCap) {
    return /* @__PURE__ */ React.createElement("div", { className: "disp-hint", "data-testid": "custom-acc-capped" }, "Already wearing ", MAX_ACCESSORIES, " \u2014 remove one to add a custom SVG.");
  }
  return /* @__PURE__ */ React.createElement("div", { className: "hm-custom-acc", "data-testid": "custom-accessory-add" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: "hm-add", onClick: () => setOpen(!open), "aria-expanded": open }, open ? "\u25BE" : "\u25B8", " Add custom SVG accessory"), open && /* @__PURE__ */ React.createElement("div", { className: "hm-custom-acc-body" }, /* @__PURE__ */ React.createElement("div", { className: "hm-row2" }, /* @__PURE__ */ React.createElement(
    "input",
    {
      className: "disp-input",
      value: label,
      onChange: (e) => setLabel(e.target.value),
      placeholder: "name (e.g. monocle)",
      maxLength: 40
    }
  ), /* @__PURE__ */ React.createElement(
    "select",
    {
      className: "disp-input",
      value: category,
      onChange: (e) => setCategory(e.target.value),
      "aria-label": "Accessory category"
    },
    ACCESSORY_CATEGORIES.map((c) => /* @__PURE__ */ React.createElement("option", { key: c, value: c }, c))
  )), /* @__PURE__ */ React.createElement(
    "textarea",
    {
      className: "disp-input hm-ta hm-mono",
      rows: 3,
      value: svg,
      spellCheck: false,
      placeholder: "<svg xmlns=\u2026> \u2014 the accessory art",
      onChange: (e) => setSvg(e.target.value)
    }
  ), err && /* @__PURE__ */ React.createElement("div", { className: "disp-hint hm-avatar-err" }, err), /* @__PURE__ */ React.createElement("button", { type: "button", className: "hm-add", "data-testid": "custom-acc-save", onClick: submit }, "\uFF0B Add to this harness")));
}
function HmFold({ title, hint, testid, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return /* @__PURE__ */ React.createElement("div", { className: `hm-fold ${open ? "open" : "closed"}`, "data-testid": testid || void 0 }, /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: "hm-fold-head",
      onClick: () => setOpen(!open),
      "aria-expanded": open
    },
    /* @__PURE__ */ React.createElement("span", { className: "hm-inh-caret" }, open ? "\u25BE" : "\u25B8"),
    /* @__PURE__ */ React.createElement("span", { className: "hm-fold-title" }, title),
    hint ? /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, " \u2014 ", hint) : null
  ), open && /* @__PURE__ */ React.createElement("div", { className: "hm-fold-body" }, children));
}
function SkillEditor({ skill, onChange, onRemove }) {
  const [open, setOpen] = useState(!skill.name);
  return /* @__PURE__ */ React.createElement("div", { className: "hm-sub hm-skill", "data-testid": "harness-skill" }, /* @__PURE__ */ React.createElement("div", { className: "hm-row2" }, /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: "hm-skill-toggle",
      onClick: () => setOpen(!open),
      "aria-expanded": open,
      title: open ? "collapse skill" : "expand skill"
    },
    /* @__PURE__ */ React.createElement("span", { className: "hm-inh-caret" }, open ? "\u25BE" : "\u25B8")
  ), /* @__PURE__ */ React.createElement(
    "input",
    {
      className: "disp-input",
      value: skill.name,
      onChange: (e) => onChange("name", e.target.value),
      placeholder: "skill name"
    }
  ), /* @__PURE__ */ React.createElement("button", { className: "hm-del", onClick: onRemove, title: "Remove skill" }, "\u{1F5D1}")), open && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
    "input",
    {
      className: "disp-input",
      value: skill.when,
      onChange: (e) => onChange("when", e.target.value),
      placeholder: "when to use it"
    }
  ), /* @__PURE__ */ React.createElement(
    "textarea",
    {
      className: "disp-input hm-ta hm-mono",
      rows: 10,
      value: skill.body,
      onChange: (e) => onChange("body", e.target.value),
      spellCheck: false,
      placeholder: "the instructions \u2014 a procedure the wearer follows"
    }
  ), /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, chars(skill.body), " \xB7 lands in the xell as ", /* @__PURE__ */ React.createElement("code", null, ".claude/skills/", skillFile(skill.name), "/SKILL.md"))));
}
function treeRows(list) {
  const byParent = {};
  for (const h of list) (byParent[h.parent || ""] = byParent[h.parent || ""] || []).push(h);
  const rows = [];
  const walk = (pk, depth) => {
    for (const h of byParent[pk] || []) {
      rows.push({ h, depth });
      walk(h.key, depth + 1);
    }
  };
  walk("", 0);
  const seen = new Set(rows.map((r) => r.h.key));
  for (const h of list) if (!seen.has(h.key)) rows.push({ h, depth: 0 });
  return rows;
}
function parentOptions(list, { key = null, zee_type = "worker", project_id = null } = {}) {
  return (list || []).filter((h) => h.key !== key && (h.zee_type || "worker") === (zee_type || "worker") && (!h.project_id || h.project_id === project_id));
}
function HarnessRow({ h, depth = 0, on = false, onOpen }) {
  const warn = emptyWarning(h);
  return /* @__PURE__ */ React.createElement(
    "button",
    {
      className: `hm-item ${on ? "on" : ""} ${warn ? "hm-hollow" : ""}`,
      "data-testid": `harness-item-${h.key}`,
      onClick: onOpen,
      style: { marginLeft: depth * 14 },
      title: warn ? warn.why : depth ? `inherits ${h.parent}` : ""
    },
    depth > 0 && /* @__PURE__ */ React.createElement("span", { className: "hm-branch" }, "\u21B3"),
    /* @__PURE__ */ React.createElement("span", { className: "hm-glyph" }, h.glyph || (h.label || "?")[0]),
    /* @__PURE__ */ React.createElement("span", { className: "hm-name" }, h.label),
    h.scope === "project" && /* @__PURE__ */ React.createElement(
      "span",
      {
        className: "hm-scope",
        "data-testid": `harness-scope-${h.key}`,
        title: `Project-scoped: visible only to ${h.project_name || "its project"}. Created by that project's manager zee (or a human), and deleted with the project.`
      },
      "\u2302 ",
      h.project_name || "project"
    ),
    warn ? /* @__PURE__ */ React.createElement("span", { className: "hm-warn", "data-testid": `harness-empty-${h.key}` }, warn.chip) : /* @__PURE__ */ React.createElement("span", { className: "hm-meta" }, h.zee_type === "manager" ? "\u2B22 mgr \xB7 " : "", h.skill_count, "\u2605")
  );
}
function HarnessEmptyBanner({ h }) {
  const warn = emptyWarning(h);
  if (!warn) return null;
  return /* @__PURE__ */ React.createElement("div", { className: "hm-empty", "data-testid": "harness-empty-banner" }, /* @__PURE__ */ React.createElement("b", null, "\u26A0 this harness carries nothing"), /* @__PURE__ */ React.createElement("span", null, warn.why), /* @__PURE__ */ React.createElement("span", null, "Its text lives in the meta-DB, so fill it in right here \u2014 personality, skills and memory are saved to the harness row and injected into every xell that wears it."));
}
const POLICY_FIELDS = [
  ["min_context", "Min context", "tokens", "the smallest context window a model must have"],
  ["max_context", "Max context", "tokens", "the largest context window allowed"],
  ["min_params", "Min parameters", "billions", "the smallest parameter count (B) a model must have"],
  ["max_params", "Max parameters", "billions", "the largest parameter count (B) allowed"],
  // (139) how many LIVE xells may WEAR this harness per project — enforced at assign time, on
  // every path that hands out a persona (dispatch, swap, the console chip). The router ships
  // with 1: "the router" is singular by policy, not by code.
  ["limit", "Wearer limit", "live xells/project", "max LIVE xells that may wear this harness per project (blank = unlimited; min-wins down the chain)"]
];
function meaningfulPolicy(src) {
  const out = {};
  for (const k of ["allow_providers", "allow_models"]) if ((src?.[k] || []).length) out[k] = [...src[k]];
  for (const k of ["min_context", "max_context", "min_params", "max_params", "limit"]) if (src?.[k] != null) out[k] = src[k];
  if (src?.default_model) out.default_model = src.default_model;
  if (src?.priorities && Object.keys(src.priorities).length) out.priorities = { ...src.priorities };
  return out;
}
function ModelPolicyEditor({ policy = {}, effective = null, inherited = null, hasParent = false, specs = [], onChange }) {
  const [open, setOpen] = useState(false);
  const p = policy && typeof policy === "object" ? policy : {};
  const inh = inherited && typeof inherited === "object" ? inherited : {};
  const customizing = !hasParent || Object.keys(p).length > 0;
  const providers = [...new Set(specs.map((s) => s.provider))].sort();
  const set = (k, v) => onChange({ ...p, [k]: v });
  const setNum = (k, v) => {
    const n = String(v || "").trim();
    if (n === "") {
      const next = { ...p };
      delete next[k];
      onChange(next);
    } else set(k, Number(n));
  };
  const setArr = (k, v) => onChange({ ...p, [k]: Array.isArray(v) ? v.filter(Boolean) : [] });
  const toggleIn = (arr, x) => setArr("allow_models", (arr || []).includes(x) ? (arr || []).filter((a) => a !== x) : [...arr || [], x]);
  const priorities = p.priorities && typeof p.priorities === "object" && !Array.isArray(p.priorities) ? p.priorities : {};
  const activeProviders = p.allow_providers && p.allow_providers.length ? p.allow_providers : providers;
  const grouped = activeProviders.map((pr) => ({ provider: pr, models: specs.filter((s) => s.provider === pr) })).filter((g) => g.models.length);
  const fmtList = (v) => v && v.length ? v.join(", ") : "all";
  const fmtScalar = (v, unit) => v != null ? `${v} ${unit}` : "unset";
  const fmtPrio = (src) => Object.keys(src?.priorities || {}).length ? JSON.stringify(src.priorities) : "default 1";
  const fmtDef = (src) => src?.default_model || "(provider default)";
  return /* @__PURE__ */ React.createElement("div", { className: "disp-field", "data-testid": "harness-model-policy" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Model policy ", /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, "restricts what a wearer may run on \u2014 enforced at dispatch (migration 110)")), /* @__PURE__ */ React.createElement("button", { type: "button", className: "hm-add", onClick: () => setOpen(!open) }, open ? "\u25BE hide model policy" : "\u25B8 edit model policy"), effective && /* @__PURE__ */ React.createElement("div", { className: "disp-hint", "data-testid": "effective-model-policy" }, /* @__PURE__ */ React.createElement("b", null, "Effective (what a wearer runs on):"), " allow_providers=", JSON.stringify(effective.allow_providers || []), " \xB7 ", "allow_models=", JSON.stringify(effective.allow_models || []), effective.min_context != null ? ` \xB7 min_ctx=${effective.min_context}` : "", effective.max_context != null ? ` \xB7 max_ctx=${effective.max_context}` : "", effective.min_params != null ? ` \xB7 min_params=${effective.min_params}` : "", effective.max_params != null ? ` \xB7 max_params=${effective.max_params}` : "", effective.limit != null ? ` \xB7 wearer limit=${effective.limit}/project` : "", effective.default_model ? ` \xB7 default=${effective.default_model}` : "", Object.keys(effective.priorities || {}).length ? ` \xB7 priorities=${JSON.stringify(effective.priorities)}` : ""), open && /* @__PURE__ */ React.createElement("div", { className: "hm-policy" }, hasParent && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "hm-pf-mode", role: "group", "aria-label": "Model policy mode" }, /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: `disp-seg ${!customizing ? "on" : ""}`,
      onClick: () => onChange({}),
      disabled: !customizing,
      title: customizing ? "Back to inherit \u2014 this harness forgets its own policy and follows its parent again." : "Currently inheriting"
    },
    "\u25CD Inherit all"
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: `disp-seg ${customizing ? "on" : ""}`,
      onClick: () => onChange(meaningfulPolicy(inh)),
      disabled: customizing,
      title: customizing ? "Already customizing" : "Copy the parent policy into this harness, then edit it."
    },
    "\u270E Customize"
  )), !customizing && /* @__PURE__ */ React.createElement("div", { className: "disp-hint hm-pf-inherited", "data-testid": "model-policy-inherited" }, /* @__PURE__ */ React.createElement("b", null, "Inherits from its parent chain:"), " allow_providers=", fmtList(inh.allow_providers), " \xB7 allow_models=", fmtList(inh.allow_models), " \xB7 ", "min_ctx=", fmtScalar(inh.min_context, "t"), " \xB7 max_ctx=", fmtScalar(inh.max_context, "t"), " \xB7 ", "min_params=", fmtScalar(inh.min_params, "B"), " \xB7 max_params=", fmtScalar(inh.max_params, "B"), " \xB7 limit=", inh.limit != null ? `${inh.limit}/project` : "unlimited", " \xB7 default=", fmtDef(inh), " \xB7 priorities=", fmtPrio(inh))), customizing && /* @__PURE__ */ React.createElement(React.Fragment, null, hasParent && /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, "Customizing \u2014 this harness now OWNS a copy of its parent's policy. Every field below is editable. Restriction lists intersect: you can narrow what you inherited but not widen it (dispatch enforces the whole chain)."), /* @__PURE__ */ React.createElement("div", { className: "hm-row2" }, /* @__PURE__ */ React.createElement("div", { className: "disp-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Allowed providers"), /* @__PURE__ */ React.createElement("div", { className: "disp-models", role: "group", "aria-label": "Allowed providers" }, !hasParent && /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: `disp-seg ${!(p.allow_providers || []).length ? "on" : ""}`,
      onClick: () => set("allow_providers", [])
    },
    "all"
  ), providers.map((pr) => /* @__PURE__ */ React.createElement(
    "button",
    {
      key: pr,
      type: "button",
      className: `disp-seg ${(p.allow_providers || []).includes(pr) ? "on" : ""}`,
      onClick: () => setArr("allow_providers", (p.allow_providers || []).includes(pr) ? (p.allow_providers || []).filter((x) => x !== pr) : [...p.allow_providers || [], pr])
    },
    pr
  ))), /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, "Empty = any connected provider", hasParent ? " (i.e. the parent restricts, you do not narrow further)" : "", "."))), /* @__PURE__ */ React.createElement("div", { className: "disp-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Allowed models ", /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, "every model of the selected providers")), /* @__PURE__ */ React.createElement("div", { className: "hm-policy-models" }, grouped.map((g) => /* @__PURE__ */ React.createElement("div", { key: g.provider, className: "hm-model-group" }, /* @__PURE__ */ React.createElement("div", { className: "hm-model-prov" }, g.provider), g.models.map((s) => /* @__PURE__ */ React.createElement("label", { key: `${g.provider}:${s.key}`, className: "hm-check" }, /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "checkbox",
      checked: (p.allow_models || []).includes(s.key),
      onChange: () => toggleIn(p.allow_models, s.key)
    }
  ), /* @__PURE__ */ React.createElement("span", null, s.key || "(vendor default)"), /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, s.label)))))), /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, "Empty = any model on the allowed providers. The intersection rule applies here too.")), /* @__PURE__ */ React.createElement("div", { className: "hm-row2" }, POLICY_FIELDS.map(([key, label, unit, hint]) => /* @__PURE__ */ React.createElement("div", { className: "disp-field", key }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, label, " ", /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, "(", unit, ")")), /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "number",
      min: "0",
      className: "disp-input",
      value: p[key] ?? "",
      onChange: (e) => setNum(key, e.target.value),
      placeholder: "unset"
    }
  ), /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, hint)))), /* @__PURE__ */ React.createElement("div", { className: "disp-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Default model"), /* @__PURE__ */ React.createElement(
    "select",
    {
      className: "disp-input",
      value: p.default_model || "",
      onChange: (e) => set("default_model", e.target.value || null)
    },
    /* @__PURE__ */ React.createElement("option", { value: "" }, "\u2014 none (use the provider default) \u2014"),
    grouped.map((g) => g.models.map((s) => /* @__PURE__ */ React.createElement("option", { key: `${g.provider}:${s.key}`, value: s.key }, s.key || "(vendor default)", " \xB7 ", g.provider)))
  ), /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, "What a bare dispatch runs. If set, this wins over the code default (opus for claude).")), /* @__PURE__ */ React.createElement("div", { className: "disp-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Deployment priorities"), /* @__PURE__ */ React.createElement("div", { className: "hm-policy-models" }, grouped.map((g) => /* @__PURE__ */ React.createElement("div", { key: g.provider, className: "hm-model-group" }, /* @__PURE__ */ React.createElement("div", { className: "hm-model-prov" }, g.provider), g.models.map((s) => /* @__PURE__ */ React.createElement("label", { key: `${g.provider}:${s.key}`, className: "hm-check" }, /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "number",
      min: "1",
      className: "disp-input hm-pri",
      value: priorities[s.key] ?? 1,
      onChange: (e) => {
        const n = Math.max(1, Number(e.target.value) || 1);
        set("priorities", { ...priorities, [s.key]: n });
      }
    }
  ), /* @__PURE__ */ React.createElement("span", null, s.key || "(vendor default)"), /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, s.label)))))), /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, "Higher deploys first (default 1). A bare dispatch picks the highest-priority allowed model. Example: give claude flagship a high priority on a manager harness, deepseek models a high priority on a worker harness.")))));
}
function RouterPolicyEditor({ policy = {}, effective = null, providers = [], onChange }) {
  const [open, setOpen] = useState(false);
  const p = policy && typeof policy === "object" ? policy : {};
  const weights = p.provider_weights && typeof p.provider_weights === "object" ? p.provider_weights : {};
  const sched = p.provider_schedule && typeof p.provider_schedule === "object" ? p.provider_schedule : {};
  const set = (k, v) => onChange({ ...p, [k]: v });
  const setNum = (k, v) => {
    const n = String(v ?? "").trim();
    if (n === "") {
      const next = { ...p };
      delete next[k];
      onChange(next);
    } else set(k, Number(n));
  };
  const setWeight = (prov, v) => {
    const n = String(v ?? "").trim();
    const next = { ...weights };
    if (n === "") delete next[prov];
    else next[prov] = Math.max(0, Number(n) || 0);
    set("provider_weights", next);
  };
  const setHours = (prov, which, v) => {
    const cur = sched[prov] || {};
    const hours = Array.isArray(cur.hours) && cur.hours.length === 2 ? [...cur.hours] : [0, 24];
    hours[which] = Math.min(24, Math.max(0, Number(v) || 0));
    set("provider_schedule", { ...sched, [prov]: { ...cur, hours } });
  };
  const clearSched = (prov) => {
    const next = { ...sched };
    delete next[prov];
    set("provider_schedule", next);
  };
  return /* @__PURE__ */ React.createElement("div", { className: "disp-field", "data-testid": "harness-router-policy" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Router policy ", /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, "how the router decides each dispatch \u2014 weights, schedules, rewrite (migration 139)")), /* @__PURE__ */ React.createElement("button", { type: "button", className: "hm-add", onClick: () => setOpen(!open) }, open ? "\u25BE hide router policy" : "\u25B8 edit router policy"), effective && /* @__PURE__ */ React.createElement("div", { className: "disp-hint", "data-testid": "effective-router-policy" }, /* @__PURE__ */ React.createElement("b", null, "Effective (what the router obeys):"), " weights=", JSON.stringify(effective.provider_weights || {}), Object.keys(effective.provider_schedule || {}).length ? ` \xB7 schedule=${JSON.stringify(effective.provider_schedule)}` : "", effective.max_concurrent != null ? ` \xB7 max_concurrent=${effective.max_concurrent}` : "", effective.default_mode != null ? ` \xB7 default_mode=${effective.default_mode}` : "", effective.rewrite ? ` \xB7 rewrite=${effective.rewrite}` : "", effective.max_task_chars != null ? ` \xB7 max_task_chars=${effective.max_task_chars}` : "", effective.fallback_provider ? ` \xB7 fallback=${effective.fallback_provider}` : ""), open && /* @__PURE__ */ React.createElement("div", { className: "hm-policy" }, /* @__PURE__ */ React.createElement("div", { className: "disp-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Provider weights ", /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, "relative share of dispatches (0 = never, unless fallback)")), /* @__PURE__ */ React.createElement("div", { className: "hm-policy-models" }, (providers.length ? providers : ["claude", "codex", "kimi"]).map((prov) => /* @__PURE__ */ React.createElement("label", { key: prov, className: "hm-check" }, /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "number",
      min: "0",
      step: "0.5",
      className: "disp-input hm-pri",
      "data-testid": `router-weight-${prov}`,
      value: weights[prov] ?? "",
      placeholder: "\u2014",
      onChange: (e) => setWeight(prov, e.target.value)
    }
  ), /* @__PURE__ */ React.createElement("span", null, prov)))), /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, "The router spreads its dispatches so each provider's share trends toward its weight. All blank = the router's own judgement.")), /* @__PURE__ */ React.createElement("div", { className: "disp-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Provider schedule ", /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, "UTC hours a provider may be picked (blank = always)")), /* @__PURE__ */ React.createElement("div", { className: "hm-policy-models" }, (providers.length ? providers : ["claude", "codex", "kimi"]).map((prov) => {
    const win = sched[prov] || null;
    const hours = win && Array.isArray(win.hours) ? win.hours : null;
    return /* @__PURE__ */ React.createElement("label", { key: prov, className: "hm-check", "data-testid": `router-sched-${prov}` }, /* @__PURE__ */ React.createElement("span", null, prov), /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "number",
        min: "0",
        max: "24",
        className: "disp-input hm-pri",
        value: hours ? hours[0] : "",
        placeholder: "from",
        onChange: (e) => setHours(prov, 0, e.target.value)
      }
    ), /* @__PURE__ */ React.createElement("span", null, "\u2013"), /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "number",
        min: "0",
        max: "24",
        className: "disp-input hm-pri",
        value: hours ? hours[1] : "",
        placeholder: "to",
        onChange: (e) => setHours(prov, 1, e.target.value)
      }
    ), win ? /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        className: "hm-add",
        title: "Remove this window (always available)",
        onClick: () => clearSched(prov)
      },
      "\u2715"
    ) : /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, "always"));
  })), /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, "A window may wrap midnight (22\u20136). Off-window providers are named in every routing request so the router never picks them blind.")), /* @__PURE__ */ React.createElement("div", { className: "hm-row2" }, /* @__PURE__ */ React.createElement("div", { className: "disp-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Max concurrent ", /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, "(workers)")), /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "number",
      min: "0",
      className: "disp-input",
      value: p.max_concurrent ?? "",
      onChange: (e) => setNum("max_concurrent", e.target.value),
      placeholder: "unlimited"
    }
  ), /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, "At the cap the router HOLDS new requests (visibly) until a worker finishes.")), /* @__PURE__ */ React.createElement("div", { className: "disp-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Default autonomy ", /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, "(1\u20135)")), /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "number",
      min: "1",
      max: "5",
      className: "disp-input",
      value: p.default_mode ?? "",
      onChange: (e) => setNum("default_mode", e.target.value),
      placeholder: "router's call"
    }
  ), /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, "What a routed dispatch runs at unless the prompt demands eyes on it.")), /* @__PURE__ */ React.createElement("div", { className: "disp-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Max task chars"), /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "number",
      min: "1",
      className: "disp-input",
      value: p.max_task_chars ?? "",
      onChange: (e) => setNum("max_task_chars", e.target.value),
      placeholder: "unset"
    }
  ), /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, "Target ceiling for the recomposed brief."))), /* @__PURE__ */ React.createElement("div", { className: "hm-row2" }, /* @__PURE__ */ React.createElement("div", { className: "disp-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Rewrite style"), /* @__PURE__ */ React.createElement(
    "select",
    {
      className: "disp-input",
      value: p.rewrite || "",
      onChange: (e) => set("rewrite", e.target.value || null)
    },
    /* @__PURE__ */ React.createElement("option", { value: "" }, "\u2014 router's call \u2014"),
    /* @__PURE__ */ React.createElement("option", { value: "concise" }, "concise \u2014 tight prose, no ceremony"),
    /* @__PURE__ */ React.createElement("option", { value: "structured" }, "structured \u2014 goal / constraints / verification sections"),
    /* @__PURE__ */ React.createElement("option", { value: "verbatim" }, "verbatim \u2014 pass the human's words through untouched")
  )), /* @__PURE__ */ React.createElement("div", { className: "disp-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Fallback provider"), /* @__PURE__ */ React.createElement(
    "select",
    {
      className: "disp-input",
      value: p.fallback_provider || "",
      onChange: (e) => set("fallback_provider", e.target.value || null)
    },
    /* @__PURE__ */ React.createElement("option", { value: "" }, "\u2014 none \u2014"),
    (providers.length ? providers : ["claude", "codex", "kimi"]).map((prov) => /* @__PURE__ */ React.createElement("option", { key: prov, value: prov }, prov))
  ), /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, "Where a request lands when weights/schedule exclude everything else.")))));
}
function HarnessManager({ onClose }) {
  const [list, setList] = useState([]);
  const [sel, setSel] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState(null);
  const [modelSpecs, setModelSpecs] = useState([]);
  const refresh = useCallback(() => getHarnesses().then((hs) => setList(hs.filter((h) => !h.is_law_core))).catch((e) => setErr(e.message)), []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    getModelSpecs().then(setModelSpecs).catch(() => {
    });
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const open = (key) => {
    setSaved(false);
    setErr(null);
    getHarnessFull(key).then((h) => {
      setSel(key);
      setForm({ ...blank(), ...h });
    }).catch((e) => setErr(e.message));
  };
  const startNew = () => {
    setSel("");
    setForm(blank());
    setSaved(false);
    setErr(null);
  };
  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved(false);
  };
  const setSkill = (i, k, v) => set("skills", form.skills.map((s, j) => j === i ? { ...s, [k]: v } : s));
  const addSkill = () => set("skills", [...form.skills, { name: "", when: "", body: "" }]);
  const rmSkill = (i) => set("skills", form.skills.filter((_, j) => j !== i));
  const setMem = (i, k, v) => set("memory", form.memory.map((m, j) => j === i ? { ...m, [k]: v } : m));
  const addMem = () => set("memory", [...form.memory, { path: "", text: "" }]);
  const rmMem = (i) => set("memory", form.memory.filter((_, j) => j !== i));
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (sel === "") {
        if (!form.label.trim()) throw new Error("give the harness a name");
        const created = await createHarness({ label: form.label, glyph: form.glyph, zee_type: form.zee_type || "worker" });
        await updateHarness(created.key, form);
        await refresh();
        open(created.key);
      } else {
        const h = await updateHarness(sel, form);
        setForm({ ...blank(), ...h });
        await refresh();
      }
      setSaved(true);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (sel === "" || !sel) {
      setSel(null);
      setForm(null);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await deleteHarness(sel);
      setSel(null);
      setForm(null);
      await refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ React.createElement("div", { className: "disp-overlay", onClick: onClose }, /* @__PURE__ */ React.createElement("div", { className: "disp hm", role: "dialog", "aria-label": "Harnesses", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ React.createElement("div", { className: "disp-head" }, /* @__PURE__ */ React.createElement("span", { className: "disp-title" }, "\u2699 Harnesses \u2014 personas a zee can wear"), /* @__PURE__ */ React.createElement("button", { className: "disp-x", onClick: onClose, "aria-label": "Close" }, "\u2715")), /* @__PURE__ */ React.createElement("div", { className: "hm-body" }, /* @__PURE__ */ React.createElement("aside", { className: "hm-list" }, treeRows(list).map(({ h, depth }) => /* @__PURE__ */ React.createElement(HarnessRow, { key: h.key, h, depth, on: sel === h.key, onOpen: () => open(h.key) })), /* @__PURE__ */ React.createElement("button", { className: "hm-new", onClick: startNew }, "\uFF0B New harness")), /* @__PURE__ */ React.createElement("section", { className: "hm-edit" }, !form && /* @__PURE__ */ React.createElement("div", { className: "disp-note" }, "Select a harness, or create one. A harness is a persona \u2014 personality, skills, and memory \u2014 that a zee wears when it works a xell. It layers below the law (the manual & your binding rules), never over it."), form && /* @__PURE__ */ React.createElement(HarnessEmptyBanner, { h: form }), form && /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { className: "hm-row2" }, /* @__PURE__ */ React.createElement("div", { className: "disp-field", style: { flex: 3 } }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Name"), /* @__PURE__ */ React.createElement("input", { className: "disp-input", value: form.label, onChange: (e) => set("label", e.target.value), placeholder: "e.g. Scribe" })), /* @__PURE__ */ React.createElement("div", { className: "disp-field", style: { flex: 1 } }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Badge glyph"), /* @__PURE__ */ React.createElement("input", { className: "disp-input", value: form.glyph || "", onChange: (e) => set("glyph", e.target.value), placeholder: "\u2712\uFE0F", maxLength: 4 }))), /* @__PURE__ */ React.createElement(
    HmFold,
    {
      title: "Customization",
      testid: "harness-customization",
      hint: "badge art, accessories (border \xB7 hat \xB7 equipment), worn preview",
      defaultOpen: true
    },
    /* @__PURE__ */ React.createElement(AvatarField, { svg: form.avatar_svg || "", onChange: (v) => set("avatar_svg", v) }),
    /* @__PURE__ */ React.createElement(
      WornPreview,
      {
        label: form.label,
        glyph: form.glyph,
        gear: form.gear || "",
        accessories: form.accessories || [],
        custom_accessories: form.custom_accessories || [],
        onGear: (v) => set("gear", v),
        onAccessories: (v) => set("accessories", v),
        onCustomAccessories: (v) => set("custom_accessories", v)
      }
    )
  ), /* @__PURE__ */ React.createElement("div", { className: "disp-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "For zee type"), /* @__PURE__ */ React.createElement("div", { className: "disp-models", role: "group", "aria-label": "Zee type" }, ["worker", "manager"].map((t) => /* @__PURE__ */ React.createElement(
    "button",
    {
      key: t,
      className: `disp-seg ${(form.zee_type || "worker") === t ? "on" : ""}`,
      "data-testid": `harness-type-${t}`,
      title: t === "manager" ? "A MANAGER zee: dispatches and monitors a crew, holds production read-only, cannot push to the xource." : "A WORKER zee: does the job in its own xell and lands its own work.",
      onClick: () => {
        set("zee_type", t);
        if (form.parent) set("parent", null);
      }
    },
    t === "manager" ? "\u2B22 manager" : "worker"
  ))), /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, "Only a xell of this type can wear this harness. A worker picker will not offer a manager persona, and assigning one is refused.")), sel !== "" && /* @__PURE__ */ React.createElement("div", { className: "disp-field", "data-testid": "harness-scope-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Scope"), /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, form.scope === "project" ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("b", null, "\u2302 ", form.project_name), " \u2014 visible to that project only, offered in no other project's picker, and deleted with the project.") : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("b", null, "System-wide"), " \u2014 every project sees this persona and any project's xell may wear it."))), /* @__PURE__ */ React.createElement("div", { className: "disp-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Inherits (parent harness)"), /* @__PURE__ */ React.createElement(
    "select",
    {
      className: "disp-input",
      value: form.parent || "",
      onChange: async (e) => {
        const parent = e.target.value || null;
        set("parent", parent);
        try {
          const h = await getHarnessFull(sel);
          setForm((f) => ({ ...f, parent, inherited_model_policy: h.inherited_model_policy, effective_model_policy: h.effective_model_policy }));
        } catch {
        }
      }
    },
    /* @__PURE__ */ React.createElement("option", { value: "" }, "\u2014 none (root) \u2014"),
    parentOptions(list, { key: sel, zee_type: form.zee_type, project_id: form.project_id }).map((h) => /* @__PURE__ */ React.createElement("option", { key: h.key, value: h.key }, h.label, h.scope === "project" ? " \u2302" : ""))
  ), /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, "This harness merges its parent's persona, skills & memory (root \u2192 this), then the law applies on top. The model policy inherits the parent's too \u2014 see the Model policy editor.")), /* @__PURE__ */ React.createElement("div", { className: "disp-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Summary"), /* @__PURE__ */ React.createElement("input", { className: "disp-input", value: form.summary || "", onChange: (e) => set("summary", e.target.value), placeholder: "one line \u2014 shown on the badge/picker" })), /* @__PURE__ */ React.createElement("div", { className: "disp-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Personality / voice ", /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, chars(form.personality))), /* @__PURE__ */ React.createElement(
    "textarea",
    {
      className: "disp-input hm-ta hm-mono",
      rows: 12,
      value: form.personality || "",
      onChange: (e) => set("personality", e.target.value),
      spellCheck: false,
      placeholder: "How this persona thinks and writes\u2026"
    }
  )), /* @__PURE__ */ React.createElement("div", { className: "disp-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Skills (", form.skills.length, ")", /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, " \u2014 each skill collapses to its name; expand to edit")), form.skills.map((s, i) => /* @__PURE__ */ React.createElement(
    SkillEditor,
    {
      key: i,
      skill: s,
      onChange: (k, v) => setSkill(i, k, v),
      onRemove: () => rmSkill(i)
    }
  )), /* @__PURE__ */ React.createElement("button", { className: "hm-add", onClick: addSkill }, "\uFF0B Add skill")), /* @__PURE__ */ React.createElement("div", { className: "disp-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Memory (", form.memory.length, ")"), form.memory.map((m, i) => /* @__PURE__ */ React.createElement("div", { key: i, className: "hm-sub" }, /* @__PURE__ */ React.createElement("div", { className: "hm-row2" }, /* @__PURE__ */ React.createElement("input", { className: "disp-input", value: m.path, onChange: (e) => setMem(i, "path", e.target.value), placeholder: "note name" }), /* @__PURE__ */ React.createElement("button", { className: "hm-del", onClick: () => rmMem(i), title: "Remove memory" }, "\u{1F5D1}")), /* @__PURE__ */ React.createElement(
    "textarea",
    {
      className: "disp-input hm-ta hm-mono",
      rows: 18,
      value: m.text,
      onChange: (e) => setMem(i, "text", e.target.value),
      spellCheck: false,
      placeholder: "a fact the persona always carries \u2014 a manual, a note, a checklist"
    }
  ), /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, chars(m.text), " \xB7 lands in the xell as ", /* @__PURE__ */ React.createElement("code", null, ".zeehive/harness/memory/", memFile(m.path)), ", stamped as generated"))), /* @__PURE__ */ React.createElement("button", { className: "hm-add", onClick: addMem }, "\uFF0B Add memory")), form.inherited && (form.inherited.skills.length > 0 || form.inherited.memory.length > 0) && /* @__PURE__ */ React.createElement("div", { className: "disp-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Inherited \u2014 from ", form.inherited.chain.join(" \u2192 ") || "parent"), form.inherited.skills.map((s, i) => /* @__PURE__ */ React.createElement(InheritedEntry, { key: `is${i}`, icon: "\u2605", name: s.name, note: s.when, text: s.body })), form.inherited.memory.map((m, i) => /* @__PURE__ */ React.createElement(InheritedEntry, { key: `im${i}`, icon: "\u{1F9E0}", name: m.path, text: m.text })), /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, "Read-only \u2014 carried from the parent chain (the cxell manual comes down from Zee Base this way). Open one to read exactly what a wearer gets; to change it, edit the parent.")), (sel === "router" || form.parent === "router" || Object.keys(form.router_policy || {}).length > 0) && /* @__PURE__ */ React.createElement(
    RouterPolicyEditor,
    {
      policy: form.router_policy,
      effective: form.effective_router_policy,
      providers: [...new Set(modelSpecs.map((s) => s.provider))].sort(),
      onChange: (v) => {
        set("router_policy", v);
      }
    }
  ), /* @__PURE__ */ React.createElement(
    ModelPolicyEditor,
    {
      policy: form.model_policy,
      effective: form.effective_model_policy,
      inherited: form.inherited_model_policy,
      hasParent: !!form.parent,
      specs: modelSpecs,
      onChange: (v) => {
        set("model_policy", v);
      }
    }
  ), /* @__PURE__ */ React.createElement("div", { className: "disp-hint hm-total" }, "A zee wearing this is briefed with ", /* @__PURE__ */ React.createElement("b", null, briefingChars(form).toLocaleString()), " characters of persona, skills and memory (its own plus everything inherited) \u2014 paid on every dispatch, before it has read a line of the project."), /* @__PURE__ */ React.createElement("div", { className: "disp-field", "data-testid": "harness-archival-settings" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Conversation & reflection ", /* @__PURE__ */ React.createElement("span", { className: "disp-hint" }, "what happens to a wearer's work after it leaves the xell")), /* @__PURE__ */ React.createElement("label", { className: "hm-check" }, /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "checkbox",
      checked: form.upload_conversations_on_done !== false,
      onChange: (e) => set("upload_conversations_on_done", e.target.checked)
    }
  ), /* @__PURE__ */ React.createElement("span", null, "Upload conversations on done")), /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, "When a zee wearing this harness proposes ", /* @__PURE__ */ React.createElement("code", null, "zee done"), ", the queenzee archives its conversation (", /* @__PURE__ */ React.createElement("code", null, "zee upload-conversation"), ") automatically \u2014 best-effort, never blocking the done proposal. A manager can then review it with ", /* @__PURE__ */ React.createElement("code", null, "zee conversations"), "."), /* @__PURE__ */ React.createElement("label", { className: "hm-check" }, /* @__PURE__ */ React.createElement(
    "input",
    {
      type: "checkbox",
      checked: form.enable_reflection !== false,
      onChange: (e) => set("enable_reflection", e.target.checked)
    }
  ), /* @__PURE__ */ React.createElement("span", null, "Enable reflection")), /* @__PURE__ */ React.createElement("div", { className: "disp-hint" }, "When a wearer's work SHIPS to production, the queenzee re-invokes it for the post-ship reflection pass (", /* @__PURE__ */ React.createElement("code", null, "zee report --kind reflection"), "). Off = the zee is not called back after a ship.")), /* @__PURE__ */ React.createElement("div", { className: "disp-field" }, /* @__PURE__ */ React.createElement("label", { className: "disp-label" }, "Enabled"), /* @__PURE__ */ React.createElement("div", { className: "disp-sup" }, /* @__PURE__ */ React.createElement("button", { className: `disp-seg ${form.enabled ? "on" : ""}`, onClick: () => set("enabled", true) }, "on"), /* @__PURE__ */ React.createElement("button", { className: `disp-seg ${!form.enabled ? "on" : ""}`, onClick: () => set("enabled", false) }, "off")))), err && /* @__PURE__ */ React.createElement("div", { className: "disp-err" }, err))), /* @__PURE__ */ React.createElement("div", { className: "disp-foot" }, form && sel !== "" && /* @__PURE__ */ React.createElement("button", { className: "disp-cancel", onClick: remove, disabled: busy }, "Delete"), /* @__PURE__ */ React.createElement("span", { style: { flex: 1 } }), /* @__PURE__ */ React.createElement("button", { className: "disp-cancel", onClick: onClose }, "Close"), form && /* @__PURE__ */ React.createElement("button", { className: "disp-submit", onClick: save, disabled: busy }, saved ? "Saved \u2713" : busy ? "Saving\u2026" : sel === "" ? "Create" : "Save"))));
}
export {
  AvatarField,
  CustomAccessoryAdd,
  HarnessEmptyBanner,
  HarnessRow,
  HmFold,
  InheritedEntry,
  ModelPolicyEditor,
  RouterPolicyEditor,
  SkillEditor,
  WornPreview,
  briefingChars,
  HarnessManager as default,
  parentOptions
};
