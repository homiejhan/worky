/* digest-prompts.js — Email digest prompts and sections editor (Settings → Email Digest →
 * Prompts). */
import { $, showToast } from './util.js';
import { syncRef, syncUser } from './sync.js';

/* ── Prompts and sections (Settings → Email Digest → Prompts) ──
 * The originals are backend/prompts.json, the same file backend/digest.py
 * reads, so there is only one copy of them: three fixed prompts (rules,
 * overview, tasks) plus an ordered list of sections, each with a title, the
 * keywords that route emails into it, and its own prompt. Edits are written
 * to users/<uid>/digestPrompts = { rules?, overview?, tasks?, sections?, updatedAt }
 * — a sibling of state and digestInbox that sync pushes never touch (update(),
 * not set()) and that the backend reads at the start of every run. A text key
 * is stored only when it differs from the original; the section list is stored
 * whole once anything about it changed (order and deletions need the whole
 * list). Anything not stored runs the original.
 * Routing (mirrors classify() in digest.py): an email goes to the first
 * section, top to bottom, whose keywords match its sender + subject (or the
 * first lines of the body when that box is ticked); else it is skipped if
 * promotional; else to the first section that takes mailing-list mail; else to
 * the first section with no keywords at all (the catch-all). */
const DIGEST_PROMPTS_URL = 'backend/prompts.json';
const DIGEST_PROMPT_MAX  = 8000;   // same caps as digest.py
const DIGEST_SECTION_MAX = 12;
const DIGEST_KEYWORDS_MAX = 60;
const DIGEST_BUDGET_DEFAULT = 8000;
const DIGEST_PROMPT_TEXTS = [
  { key: 'rules',    label: 'Shared rules (every section)',
    hint: 'Sent first on every section call, followed by a "Section:" line and that section\'s own prompt.' },
  { key: 'overview', label: 'Top of the inbox and action items',
    hint: 'Keep the "## ✅ Action items" heading. The digest splits on it, and suggested tasks fall back to that checklist.' },
  { key: 'tasks',    label: 'Suggested tasks',
    hint: 'The reply is forced into { reasoning, tasks: [{ title, why, due, section }] }. Change the rules, not the fields. "{sections}" becomes the list of section ids.' },
];
const DIGEST_PROMPT_TEXT_KEYS = DIGEST_PROMPT_TEXTS.map(p => p.key);
const DIGEST_SECTION_NEW_PROMPT = 'These emails are about a topic of your choice. One line each: **sender** — what it says — whether action is needed. Skip anything with no real content.';
let digestPromptDefaults = null;         // backend/prompts.json, once fetched: { rules, overview, tasks, sections }
let digestPromptDefaultsState = 'idle';  // idle | loading | ok | error
export let digestPromptsSaved;                  // undefined until the sync listener reports, then { prompts, sections, updatedAt }
export function setDigestPromptsSaved(v) { digestPromptsSaved = v; }
let digestPromptKey = 'rules';           // a text key, or 'section:<id>'
export let digestPromptDirty = false;
export function setDigestPromptDirty(v) { digestPromptDirty = v; }
let digestPromptOpen = false;

function digestPromptSlug(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
function digestPromptKeywords(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[,\n]/);
  return arr.map(k => String(k).replace(/\s+/g, ' ').trim().slice(0, 60)).filter(Boolean).slice(0, DIGEST_KEYWORDS_MAX);
}
/* one section in canonical shape, or null when it is unusable */
function digestPromptNormSection(x, seen) {
  if (!x || typeof x !== 'object') return null;
  const id = digestPromptSlug(x.id || x.title);
  const title = String(x.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const prompt = String(x.prompt || '').trim().slice(0, DIGEST_PROMPT_MAX);
  if (!id || !title || !prompt || (seen && seen.has(id))) return null;
  if (seen) seen.add(id);
  const budget = Math.max(2000, Math.min(30000, parseInt(x.budget, 10) || DIGEST_BUDGET_DEFAULT));
  return { id, title, keywords: digestPromptKeywords(x.keywords), body: !!x.body, lists: !!x.lists, budget, prompt };
}
function digestPromptNormSections(arr) {
  const seen = new Set(), out = [];
  (Array.isArray(arr) ? arr : []).forEach(x => { const s = digestPromptNormSection(x, seen); if (s && out.length < DIGEST_SECTION_MAX) out.push(s); });
  return out;
}
function digestPromptsNormalize(node) {
  const out = { prompts: {}, sections: null, updatedAt: 0 };
  if (node && typeof node === 'object') {
    DIGEST_PROMPT_TEXT_KEYS.forEach(k => {
      if (typeof node[k] === 'string' && node[k].trim()) out.prompts[k] = node[k].trim().slice(0, DIGEST_PROMPT_MAX);
    });
    if (Array.isArray(node.sections)) { const secs = digestPromptNormSections(node.sections); if (secs.length) out.sections = secs; }
    out.updatedAt = Number(node.updatedAt) || 0;
  }
  return out;
}
/* called by the sync listener with users/<uid>/digestPrompts (or null) */
export function digestPromptsSeen(node) {
  digestPromptsSaved = digestPromptsNormalize(node);
  if (digestPromptKey.startsWith('section:') && !digestPromptSection(digestPromptKey.slice(8))) {
    digestPromptKey = 'rules'; digestPromptDirty = false;      // the section shown was removed elsewhere
  }
  digestPromptRender();
}
async function digestPromptsLoadDefaults() {
  if (digestPromptDefaultsState === 'loading' || digestPromptDefaultsState === 'ok') return;
  digestPromptDefaultsState = 'loading';
  digestPromptRender();
  try {
    const r = await fetch(DIGEST_PROMPTS_URL, { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const missing = DIGEST_PROMPT_TEXT_KEYS.filter(k => typeof data[k] !== 'string' || !data[k].trim());
    if (missing.length) throw new Error('missing ' + missing.join(', '));
    const sections = digestPromptNormSections(data.sections);
    if (!sections.length) throw new Error('no sections');
    digestPromptDefaults = { sections };
    DIGEST_PROMPT_TEXT_KEYS.forEach(k => { digestPromptDefaults[k] = data[k].trim(); });
    digestPromptDefaultsState = 'ok';
  } catch (e) {
    digestPromptDefaultsState = 'error';
  }
  digestPromptRender();
}

/* ── what is in effect right now ── */
function digestPromptText(key) {            // a text key: saved edit, else original
  return (digestPromptsSaved && digestPromptsSaved.prompts[key]) || (digestPromptDefaults && digestPromptDefaults[key]) || '';
}
function digestPromptSections() {
  if (digestPromptsSaved && digestPromptsSaved.sections) return digestPromptsSaved.sections;
  return (digestPromptDefaults && digestPromptDefaults.sections) || [];
}
function digestPromptSection(id) { return digestPromptSections().find(s => s.id === id) || null; }
function digestPromptDefaultSection(id) {
  return ((digestPromptDefaults && digestPromptDefaults.sections) || []).find(s => s.id === id) || null;
}
function digestPromptSectionKey(s) { return JSON.stringify([s.id, s.title, s.keywords, s.body, s.lists, s.budget, s.prompt]); }
function digestPromptSectionsKey(list) { return JSON.stringify(list.map(digestPromptSectionKey)); }
/* '' when the section is the original, 'edited' or 'new' otherwise */
function digestPromptSectionMark(s) {
  const d = digestPromptDefaultSection(s.id);
  return !d ? 'new' : digestPromptSectionKey(d) === digestPromptSectionKey(s) ? '' : 'edited';
}
function digestPromptFlat() {               // the stored node, minus updatedAt, as an object to patch
  const out = {};
  if (digestPromptsSaved) {
    DIGEST_PROMPT_TEXT_KEYS.forEach(k => { if (digestPromptsSaved.prompts[k]) out[k] = digestPromptsSaved.prompts[k]; });
    if (digestPromptsSaved.sections) out.sections = digestPromptsSaved.sections;
  }
  return out;
}

/* ── editor state ── */
function digestPromptSignedIn() { return !!(syncUser && syncRef); }
function digestPromptCanSave() {
  return digestPromptSignedIn() && digestPromptsSaved !== undefined && digestPromptDefaultsState === 'ok';
}
function digestPromptIsSection() { return digestPromptKey.startsWith('section:'); }
function digestPromptLabel(key) {
  if (key.startsWith('section:')) { const s = digestPromptSection(key.slice(8)); return s ? s.title : 'section'; }
  return (DIGEST_PROMPT_TEXTS.find(p => p.key === key) || DIGEST_PROMPT_TEXTS[0]).label;
}
/* what the fields currently hold, in canonical shape */
function digestPromptDraft() {
  if (!digestPromptIsSection()) return ($('digestPromptText').value || '').trim();
  const cur = digestPromptSection(digestPromptKey.slice(8));
  if (!cur) return null;
  return digestPromptNormSection({
    ...cur,
    title: $('digestPromptTitle').value,
    keywords: $('digestPromptKeywords').value,
    body: $('digestPromptBody').checked,
    lists: $('digestPromptLists').checked,
    prompt: $('digestPromptText').value,
  }) || { ...cur, title: $('digestPromptTitle').value.trim(), prompt: $('digestPromptText').value.trim(), keywords: digestPromptKeywords($('digestPromptKeywords').value), body: $('digestPromptBody').checked, lists: $('digestPromptLists').checked };
}
function digestPromptComputeDirty() {
  if (digestPromptIsSection()) {
    const cur = digestPromptSection(digestPromptKey.slice(8)), draft = digestPromptDraft();
    return !!(cur && draft && digestPromptSectionKey(cur) !== digestPromptSectionKey(draft));
  }
  return ($('digestPromptText').value || '').trim() !== digestPromptText(digestPromptKey);
}
function digestPromptFill() {               // push the current values into the fields
  const ta = $('digestPromptText');
  if (digestPromptIsSection()) {
    const s = digestPromptSection(digestPromptKey.slice(8));
    if (!s) return;
    $('digestPromptTitle').value = s.title;
    $('digestPromptKeywords').value = s.keywords.join(', ');
    $('digestPromptBody').checked = s.body;
    $('digestPromptLists').checked = s.lists;
    ta.value = s.prompt;
  } else {
    ta.value = digestPromptText(digestPromptKey);
  }
}
export function digestPromptRender() {
  const btn = $('digestPromptToggleBtn'), box = $('digestPromptEditor');
  if (!btn || !box) return;
  btn.textContent = digestPromptOpen ? 'Hide prompts' : 'Edit prompts';
  btn.setAttribute('aria-expanded', String(digestPromptOpen));
  box.hidden = !digestPromptOpen;
  if (!digestPromptOpen) return;

  const secs = digestPromptSections();
  const items = [{ key: 'rules', label: DIGEST_PROMPT_TEXTS[0].label }]
    .concat(secs.map(s => { const m = digestPromptSectionMark(s); return { key: 'section:' + s.id, label: s.title + (m ? ` (${m})` : '') }; }))
    .concat(DIGEST_PROMPT_TEXTS.slice(1).map(p => ({ key: p.key, label: p.label })));
  const sel = $('digestPromptSelect');
  if (sel.options.length !== items.length) {
    sel.innerHTML = '';
    items.forEach(() => sel.appendChild(document.createElement('option')));
  }
  items.forEach((it, i) => { sel.options[i].value = it.key; sel.options[i].textContent = it.label; });
  if (!items.some(it => it.key === digestPromptKey)) { digestPromptKey = 'rules'; digestPromptDirty = false; }
  sel.value = digestPromptKey;

  const canSave = digestPromptCanSave();
  const isSec = digestPromptIsSection();
  const sec = isSec ? digestPromptSection(digestPromptKey.slice(8)) : null;
  const at = sec ? secs.indexOf(sec) : -1;
  const hint = $('digestPromptHint');
  if (isSec) {
    hint.textContent = `Section ${at + 1} of ${secs.length}. Emails try each section in order and stop at the first whose keywords match, so the order above is the order in the digest and the order of matching.`;
  } else {
    const def = DIGEST_PROMPT_TEXTS.find(p => p.key === digestPromptKey);
    hint.textContent = def ? def.hint : '';
  }
  $('digestPromptSectionFields').hidden = !isSec;
  if (!digestPromptDirty) digestPromptFill();
  ['digestPromptTitle', 'digestPromptKeywords', 'digestPromptText'].forEach(id => { $(id).readOnly = !canSave; });
  ['digestPromptBody', 'digestPromptLists'].forEach(id => { $(id).disabled = !canSave; });
  $('digestPromptUpBtn').disabled = !canSave || at <= 0;
  $('digestPromptDownBtn').disabled = !canSave || at < 0 || at >= secs.length - 1;
  $('digestPromptDeleteBtn').disabled = !canSave || secs.length <= 1;
  const mark = sec ? digestPromptSectionMark(sec) : (digestPromptsSaved && digestPromptsSaved.prompts[digestPromptKey] ? 'edited' : '');
  $('digestPromptSaveBtn').disabled = !canSave || !digestPromptDirty;
  $('digestPromptSaveBtn').textContent = isSec ? 'Save section' : 'Save prompt';
  $('digestPromptResetBtn').disabled = !canSave || (!mark && !digestPromptDirty) || (mark === 'new' && !digestPromptDirty);
  $('digestPromptResetBtn').textContent = mark === 'new' ? 'Discard changes' : 'Reset to original';
  $('digestPromptNewBtn').disabled = !canSave || secs.length >= DIGEST_SECTION_MAX;
  $('digestPromptImportBtn').disabled = !canSave;
  $('digestPromptExportBtn').disabled = digestPromptDefaultsState !== 'ok';
  $('digestPromptRestoreAllBtn').disabled = !canSave;

  const st = $('digestPromptStatus');
  let msg = '', cls = '';
  const when = digestPromptsSaved && digestPromptsSaved.updatedAt
    ? new Date(digestPromptsSaved.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  if (digestPromptDefaultsState === 'error') {
    msg = 'Could not load the original prompts. Check your connection, then hide and reopen the editor.'; cls = 'err';
  } else if (digestPromptDefaultsState !== 'ok') {
    msg = 'Loading the original prompts…';
  } else if (!digestPromptSignedIn()) {
    msg = 'Sign in to cloud sync to edit prompts. Runs read them from your account.'; cls = 'err';
  } else if (digestPromptsSaved === undefined) {
    msg = 'Loading your saved prompts…';
  } else if (digestPromptDirty) {
    msg = 'Unsaved changes.'; cls = 'dirty';
  } else if (mark === 'new') {
    msg = `Your section${when ? ', saved ' + when : ''}. The next run uses it.`;
  } else if (mark) {
    msg = `Edited${when ? ', saved ' + when : ''}. The next run uses this version.`;
  } else {
    msg = isSec ? 'Original section.' : 'Original prompt.';
  }
  st.textContent = msg;
  st.className = 'theme-bg-status' + (cls ? ' ' + cls : '');
}

/* ── writing ── */
/* Store `flat` = { rules?, overview?, tasks?, sections? }, dropping anything
 * equal to the original; nothing left → remove the node. */
function digestPromptsWrite(flat, okMsg) {
  if (!digestPromptCanSave()) return Promise.resolve(false);
  const d = digestPromptDefaults, next = {};
  DIGEST_PROMPT_TEXT_KEYS.forEach(k => {
    const v = typeof flat[k] === 'string' ? flat[k].trim().slice(0, DIGEST_PROMPT_MAX) : '';
    if (v && v !== d[k]) next[k] = v;
  });
  if (Array.isArray(flat.sections)) {
    const secs = digestPromptNormSections(flat.sections);
    if (secs.length && digestPromptSectionsKey(secs) !== digestPromptSectionsKey(d.sections)) next.sections = secs;
  }
  const node = Object.keys(next).length ? { ...next, updatedAt: Date.now() } : null;
  const prev = digestPromptsSaved;
  const draft = { key: digestPromptKey, dirty: digestPromptDirty, title: $('digestPromptTitle').value, keywords: $('digestPromptKeywords').value,
                  body: $('digestPromptBody').checked, lists: $('digestPromptLists').checked, text: $('digestPromptText').value };
  digestPromptsSaved = digestPromptsNormalize(node);   // optimistic; the listener confirms
  digestPromptDirty = false;
  if (digestPromptIsSection() && !digestPromptSection(digestPromptKey.slice(8))) digestPromptKey = 'rules';
  digestPromptRender();
  return syncRef.child('digestPrompts').set(node)
    .then(() => { showToast(okMsg); return true; })
    .catch(err => {
      digestPromptsSaved = prev;                       // hand everything back so nothing typed is lost
      digestPromptKey = draft.key; digestPromptDirty = draft.dirty;
      $('digestPromptTitle').value = draft.title; $('digestPromptKeywords').value = draft.keywords;
      $('digestPromptBody').checked = draft.body; $('digestPromptLists').checked = draft.lists; $('digestPromptText').value = draft.text;
      digestPromptRender();
      const perm = /permission/i.test(String((err && (err.message || err.code)) || ''));
      showToast(perm ? 'Could not save: your database rules block users/<uid>/digestPrompts'
                     : 'Could not save. Try again when you are online.');
      return false;
    });
}
function digestPromptSave() {
  if (!digestPromptCanSave()) return;
  const flat = digestPromptFlat();
  if (digestPromptIsSection()) {
    const id = digestPromptKey.slice(8), cur = digestPromptSection(id);
    const draft = digestPromptDraft();
    if (!cur) return;
    if (!draft || !draft.title || !draft.prompt) { showToast(!draft || !draft.title ? 'Give the section a title.' : 'A section needs a prompt. Use Reset to restore the original.'); return; }
    flat.sections = digestPromptSections().map(s => (s.id === id ? draft : s));
    return digestPromptsWrite(flat, 'Section saved. The next digest run uses it.');
  }
  const text = ($('digestPromptText').value || '').trim();
  if (!text) { showToast('A prompt cannot be empty. Use Reset to restore the original.'); return; }
  flat[digestPromptKey] = text;
  return digestPromptsWrite(flat, 'Prompt saved. The next digest run uses it.');
}
function digestPromptReset() {
  if (!digestPromptCanSave()) return;
  const flat = digestPromptFlat();
  if (digestPromptIsSection()) {
    const id = digestPromptKey.slice(8), cur = digestPromptSection(id), orig = digestPromptDefaultSection(id);
    if (!cur) return;
    const mark = digestPromptSectionMark(cur);
    if (!orig || !mark) { digestPromptDirty = false; digestPromptRender(); return; }   // only unsaved typing to throw away
    if (!window.confirm(`Reset "${cur.title}" to the original section? Its title, keywords and prompt go back too.`)) return;
    flat.sections = digestPromptSections().map(s => (s.id === id ? orig : s));
    return digestPromptsWrite(flat, 'Reset to the original section.');
  }
  if (!(digestPromptsSaved && digestPromptsSaved.prompts[digestPromptKey])) { digestPromptDirty = false; digestPromptRender(); return; }
  if (!window.confirm(`Reset "${digestPromptLabel(digestPromptKey)}" to the original prompt?`)) return;
  delete flat[digestPromptKey];
  return digestPromptsWrite(flat, 'Reset to the original prompt.');
}
function digestPromptDiscardOk() {
  return !digestPromptDirty || window.confirm(`Discard unsaved changes to "${digestPromptLabel(digestPromptKey)}"?`);
}
function digestPromptNewSection() {
  if (!digestPromptCanSave() || !digestPromptDiscardOk()) return;
  const secs = digestPromptSections();
  if (secs.length >= DIGEST_SECTION_MAX) { showToast(`Up to ${DIGEST_SECTION_MAX} sections.`); return; }
  let n = 1, id = 'section-1';
  while (secs.some(s => s.id === id)) id = 'section-' + (++n);
  const flat = digestPromptFlat();
  flat.sections = secs.concat([{ id, title: 'New section', keywords: [], body: false, lists: false, budget: DIGEST_BUDGET_DEFAULT, prompt: DIGEST_SECTION_NEW_PROMPT }]);
  digestPromptKey = 'section:' + id;
  digestPromptDirty = false;
  return digestPromptsWrite(flat, 'Section added at the end. Give it a title and keywords, then save.');
}
function digestPromptMove(dir) {
  if (!digestPromptCanSave() || !digestPromptIsSection()) return;
  const id = digestPromptKey.slice(8), secs = digestPromptSections().slice();
  const at = secs.findIndex(s => s.id === id), to = at + dir;
  if (at < 0 || to < 0 || to >= secs.length) return;
  [secs[at], secs[to]] = [secs[to], secs[at]];
  const flat = digestPromptFlat(); flat.sections = secs;
  return digestPromptsWrite(flat, dir < 0 ? 'Moved up.' : 'Moved down.');
}
function digestPromptDeleteSection() {
  if (!digestPromptCanSave() || !digestPromptIsSection()) return;
  const id = digestPromptKey.slice(8), secs = digestPromptSections(), cur = digestPromptSection(id);
  if (!cur || secs.length <= 1) { showToast('Keep at least one section.'); return; }
  if (!window.confirm(`Delete the "${cur.title}" section? Its emails will fall through to the sections below it.`)) return;
  const at = secs.indexOf(cur), rest = secs.filter(s => s.id !== id);
  const flat = digestPromptFlat(); flat.sections = rest;
  digestPromptKey = 'section:' + rest[Math.min(at, rest.length - 1)].id;
  digestPromptDirty = false;
  return digestPromptsWrite(flat, 'Section deleted.');
}
function digestPromptRestoreAll() {
  if (!digestPromptCanSave()) return;
  if (!window.confirm('Put every prompt and section back to the originals? Sections you added will be removed.')) return;
  digestPromptDirty = false;
  return digestPromptsWrite({}, 'All prompts and sections restored.');
}

/* ── Markdown file: Export writes the whole set, Import reads it back ──
 * One "## " block per item: a `key:` line for the three prompts, a
 * "## Section: <title>" heading with id/keywords/flag lines for sections,
 * then the prompt inside a ```text fence. */
const DIGEST_PROMPT_FILE = 'worky-digest-prompts.md';
function digestPromptsExportText() {
  const fence = t => '```text\n' + String(t).replace(/^```/gm, ' ```') + '\n```';
  const when = new Date().toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const out = ['# Worky digest prompts', '',
    `Exported ${when}. Import this file under Settings → Email Digest → Prompts to restore every prompt and section in it.`,
    'Each "## Section:" block is one digest section, in order; an email goes to the first section whose keywords match. The three other blocks are the fixed prompts.', ''];
  const text = DIGEST_PROMPT_TEXTS.find(p => p.key === 'rules');
  out.push(`## ${text.label}`, 'key: rules', '', fence(digestPromptText('rules')), '');
  digestPromptSections().forEach(s => {
    out.push(`## Section: ${s.title}`, `id: ${s.id}`, `keywords: ${s.keywords.join(', ')}`,
      `search body: ${s.body ? 'yes' : 'no'}`, `mailing lists: ${s.lists ? 'yes' : 'no'}`, `budget: ${s.budget}`, '', fence(s.prompt), '');
  });
  DIGEST_PROMPT_TEXTS.slice(1).forEach(p => { out.push(`## ${p.label}`, `key: ${p.key}`, '', fence(digestPromptText(p.key)), ''); });
  return out.join('\n');
}
/* → { flat } or { error } */
function digestPromptsParseMd(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let cur = null, inFence = false;
  lines.forEach(line => {
    if (inFence) {
      if (/^```\s*$/.test(line)) { inFence = false; cur.closed = true; }
      else cur.text.push(line.replace(/^ ```/, '```'));
      return;
    }
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = { heading: h[1], meta: {}, text: [], closed: false }; blocks.push(cur); return; }
    if (!cur) return;
    if (/^```/.test(line)) { if (!cur.closed && !cur.text.length) inFence = true; return; }
    const m = line.match(/^([A-Za-z][A-Za-z ]*):\s*(.*)$/);
    if (m && !cur.closed) cur.meta[m[1].trim().toLowerCase()] = m[2].trim();
  });
  const flat = { sections: [] }, seen = new Set();
  const yes = v => /^(yes|true|on|1)$/i.test(String(v || ''));
  for (const b of blocks) {
    const text = b.text.join('\n').trim();
    const sec = b.heading.match(/^section:\s*(.+)$/i);
    if (sec) {
      const title = sec[1].trim();
      const s = digestPromptNormSection({ id: b.meta.id || title, title, keywords: b.meta.keywords, body: yes(b.meta['search body']),
        lists: yes(b.meta['mailing lists']), budget: b.meta.budget, prompt: text }, seen);
      if (!s) return { error: !text ? `Section "${title}" has no prompt.` : `Section "${title}" could not be read.` };
      if (flat.sections.length >= DIGEST_SECTION_MAX) return { error: `Up to ${DIGEST_SECTION_MAX} sections.` };
      flat.sections.push(s);
      continue;
    }
    const key = (b.meta.key || '').toLowerCase() || (DIGEST_PROMPT_TEXTS.find(p => p.label.toLowerCase() === b.heading.toLowerCase()) || {}).key;
    if (!DIGEST_PROMPT_TEXT_KEYS.includes(key)) continue;          // an unknown block is ignored, not fatal
    if (!text) return { error: `"${b.heading}" has no prompt text.` };
    flat[key] = text;
  }
  if (!flat.sections.length) return { error: 'No "## Section:" blocks found. Export a copy first to see the format.' };
  return { flat };
}
function digestPromptExport() {
  if (digestPromptDefaultsState !== 'ok') return;
  const blob = new Blob([digestPromptsExportText()], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = DIGEST_PROMPT_FILE; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showToast(`Exported ${DIGEST_PROMPT_FILE}`);
}
function digestPromptImportText(md, name) {
  if (!digestPromptCanSave()) return Promise.resolve(false);
  const r = digestPromptsParseMd(md);
  if (r.error) { showToast('Import failed: ' + r.error); return Promise.resolve(false); }
  const n = r.flat.sections.length, texts = DIGEST_PROMPT_TEXT_KEYS.filter(k => r.flat[k]).length;
  if (!window.confirm(`Replace your prompts and sections with the ${n} section${n === 1 ? '' : 's'} and ${texts} prompt${texts === 1 ? '' : 's'} in "${name}"? Anything the file leaves out goes back to the original.`)) return Promise.resolve(false);
  digestPromptDirty = false;
  return digestPromptsWrite(r.flat, `Imported ${name}. The next digest run uses it.`);
}
export function bindDigestPrompts() {
  $('digestPromptToggleBtn')?.addEventListener('click', () => {
    if (digestPromptOpen && !digestPromptDiscardOk()) return;
    if (digestPromptOpen) digestPromptDirty = false;
    digestPromptOpen = !digestPromptOpen;
    if (digestPromptOpen && digestPromptDefaultsState !== 'ok') {
      digestPromptDefaultsState = 'idle';
      digestPromptsLoadDefaults();
    }
    digestPromptRender();
  });
  $('digestPromptSelect')?.addEventListener('change', e => {
    const key = e.target.value;
    if (!digestPromptDiscardOk()) { e.target.value = digestPromptKey; return; }
    digestPromptKey = key;
    digestPromptDirty = false;
    digestPromptRender();
  });
  const onEdit = () => { const dirty = digestPromptComputeDirty(); if (dirty !== digestPromptDirty) { digestPromptDirty = dirty; digestPromptRender(); } };
  ['digestPromptText', 'digestPromptTitle', 'digestPromptKeywords'].forEach(id => $(id)?.addEventListener('input', onEdit));
  ['digestPromptBody', 'digestPromptLists'].forEach(id => $(id)?.addEventListener('change', onEdit));
  $('digestPromptSaveBtn')?.addEventListener('click', digestPromptSave);
  $('digestPromptResetBtn')?.addEventListener('click', digestPromptReset);
  $('digestPromptNewBtn')?.addEventListener('click', digestPromptNewSection);
  $('digestPromptUpBtn')?.addEventListener('click', () => { if (digestPromptDiscardOk()) { digestPromptDirty = false; digestPromptMove(-1); } });
  $('digestPromptDownBtn')?.addEventListener('click', () => { if (digestPromptDiscardOk()) { digestPromptDirty = false; digestPromptMove(1); } });
  $('digestPromptDeleteBtn')?.addEventListener('click', digestPromptDeleteSection);
  $('digestPromptRestoreAllBtn')?.addEventListener('click', digestPromptRestoreAll);
  $('digestPromptExportBtn')?.addEventListener('click', digestPromptExport);
  $('digestPromptImportBtn')?.addEventListener('click', () => { if (digestPromptCanSave() && digestPromptDiscardOk()) $('digestPromptFile')?.click(); });
  $('digestPromptFile')?.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => digestPromptImportText(String(rd.result || ''), f.name);
    rd.onerror = () => showToast('Could not read that file.');
    rd.readAsText(f);
  });
}
