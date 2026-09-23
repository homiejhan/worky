/* templates.js — Ready-made Formats templates and the template picker. */
import { $, closeModal, escAttr, showToast } from './util.js';
import { saveToLocal } from './persistence.js';
import { renderTimers, setTimerDefaults, setTimers } from './timers.js';
import { makeTasks, nextTodoId, renderTodos, setTodoLists, todoLists } from './lists.js';
import { viewEnabled } from './views.js';
import { setViewEnabled } from './settings.js';
import { formatMode, nextFormatTimerId, setPreFormatTimerState } from './formats.js';
import { taskLinkRefOfEvent } from './tasklinks.js';
import {
  calEvents, calRefresh, calSave, calTemplates, nextCalEventId, reseedTemplate,
  setCalFmtMobileDay, setCalTemplates,
} from './calendar.js';
import { themeApplyPreset, themeFontStack, themePreset } from './theme.js';

/* ───────────────────────── FORMAT TEMPLATES ─────────────────────────
 * Ready-made "starting points" for Formats. Applying one replaces the
 * three things Formats owns — timers, Daily lists, weekly calendar
 * templates — and (optionally) switches to a matching theme preset.
 * Custom lists, Day-by-Day tasks, budget, and calendar events you added
 * by hand are never touched; a template's `lists` are only added when no
 * list of that name exists, and its `views` are only switched on. Nothing
 * reaches the cloud until Done, so a template can be tried and tweaked
 * freely. Working student is the default: a fresh device starts from it
 * (see applyStarterProfile). */
export const DEFAULT_TEMPLATE = 'working';
export const FORMAT_TEMPLATES = [
  { id: 'working', name: 'Working student', tagline: 'Classes, shifts and cash on one page. The default setup.', theme: 'midnight',
    timers: [
      { label: 'Study', seconds: 3*3600, color: '#8B5CF6' },
      { label: 'Work',  seconds: 4*3600, color: '#22C55E' },
      { label: 'Sleep', seconds: 8*3600, color: '#378ADD' },
    ],
    daily: [
      { title: 'Before class or shift', color: '#2F6FE0', starred: true,
        tasks: ['Check today\'s classes and shift', 'Pack bag, charger and work clothes', 'Eat something real', 'Pick the one assignment that matters most'] },
      { title: 'Wind down', color: '#8B5CF6', starred: true,
        tasks: ['Set out tomorrow\'s clothes', 'Screens off 30 minutes before bed', 'Phone on silent', 'Lights out on time'] },
      { title: 'Sunday planning', color: '#F97316', activeDays: [0],
        tasks: ['Map this week\'s deadlines', 'Check next week\'s shifts', 'Block study time around shifts', 'Check cash until payday', 'Laundry'] },
    ],
    lists: [{ title: 'Deadlines', color: '#EC3636', starred: true }],   // where due dates live
    views: ['budget'],                                                  // the envelope stays on
    cal: [
      { title: 'Study block',   start: '14:00', end: '16:00', color: '#8B5CF6', repeatDays: [1,3,5] },
      { title: 'Lunch',         start: '12:15', end: '12:15', color: '#505050', repeatDays: [1,2,3,4,5], type: 'divider' },
      { title: 'Plan the week', start: '19:00', end: '19:30', color: '#F97316', repeatDays: [0] },
      { title: 'Lights out',    start: '23:30', end: '23:30', color: '#378ADD', repeatDays: [0,1,2,3,4,5,6], type: 'divider' },
    ] },

  { id: 'classic', name: 'Classic', tagline: 'The original Focus setup — work, growth, faith, skills.', theme: 'midnight',
    timers: [
      { label: 'Productivity Timer',   seconds: 5*3600, color: '#378ADD' },
      { label: 'Personal Development', seconds: 3*3600, color: '#EC3636' },
      { label: 'Time with God',        seconds: 2*3600, color: '#8B5CF6' },
      { label: 'Skill Development',    seconds: 1*3600, color: '#F97316' },
    ],
    daily: [
      { title: 'Morning routine', color: '#22C55E', starred: true,
        tasks: ['Make the bed', 'Stretch for 10 minutes', 'Drink a glass of water', 'Plan the day'] },
      { title: 'Health', color: '#378ADD', starred: true,
        tasks: ['Morning routine', 'Walk or workout', 'Eight glasses of water', 'In bed by 11'] },
      { title: 'Weekend reset', color: '#F97316', activeDays: [0, 6],
        tasks: ['Tidy up', 'Meal prep', 'Plan next week'] },
    ],
    cal: [
      { title: 'Deep work',     start: '09:00', end: '11:00', color: '#378ADD', repeatDays: [1,2,3,4,5] },
      { title: 'Lunch',         start: '12:30', end: '12:30', color: '#505050', repeatDays: [1,2,3,4,5], type: 'divider' },
      { title: 'Workout',       start: '17:30', end: '18:30', color: '#22C55E', repeatDays: [1,3,5] },
      { title: 'Weekly review', start: '18:00', end: '18:45', color: '#8B5CF6', repeatDays: [0] },
    ] },

  { id: 'deepwork', name: 'Deep Work', tagline: 'Long focus blocks with a startup and shutdown ritual.', theme: 'ocean',
    timers: [
      { label: 'Deep Work',  seconds: 4*3600,       color: '#5AA9FF' },
      { label: 'Meetings',   seconds: 2*3600,       color: '#EAB308' },
      { label: 'Admin',      seconds: 1*3600,       color: '#505050' },
      { label: 'Learning',   seconds: 1*3600,       color: '#22C55E' },
    ],
    daily: [
      { title: 'Startup ritual', color: '#5AA9FF', starred: true,
        tasks: ['Inbox to zero (10 min max)', 'Pick 3 most-important tasks', 'Phone on Do Not Disturb', 'Open only what today needs'] },
      { title: 'Shutdown ritual', color: '#8B5CF6', starred: true,
        tasks: ['Log what shipped today', 'Write tomorrow\'s first task', 'Close every tab', 'Clear the desk'] },
      { title: 'Friday review', color: '#F97316', activeDays: [5],
        tasks: ['What moved the needle this week?', 'What got in the way?', 'Set next week\'s one big goal'] },
    ],
    cal: [
      { title: 'Deep work',     start: '08:30', end: '11:30', color: '#5AA9FF', repeatDays: [1,2,3,4,5] },
      { title: 'Standup',       start: '11:30', end: '11:30', color: '#EAB308', repeatDays: [1,2,3,4,5], type: 'divider' },
      { title: 'Focus block 2', start: '14:00', end: '16:00', color: '#5AA9FF', repeatDays: [1,2,3,4] },
      { title: 'Admin & email', start: '16:00', end: '16:45', color: '#505050', repeatDays: [1,2,3,4,5] },
      { title: 'Weekly review', start: '15:00', end: '16:00', color: '#F97316', repeatDays: [5] },
    ] },

  { id: 'fitness', name: 'Fitness', tagline: 'Training, nutrition, and recovery all week.', theme: 'forest',
    timers: [
      { label: 'Training',            seconds: 90*60,  color: '#22C55E' },
      { label: 'Mobility & Recovery', seconds: 45*60,  color: '#5DCAA5' },
      { label: 'Meal Prep',           seconds: 1*3600, color: '#E0B84F' },
      { label: 'Wind-down',           seconds: 30*60,  color: '#8B5CF6' },
    ],
    daily: [
      { title: 'Morning', color: '#22C55E', starred: true,
        tasks: ['Big glass of water', '10-minute stretch', 'Protein breakfast', 'Log weight or how you feel'] },
      { title: 'Nutrition', color: '#E0B84F', starred: true,
        tasks: ['Protein with every meal', '3 litres of water', 'Vegetables twice', 'Nothing after 9 pm'] },
      { title: 'Sleep', color: '#8B5CF6',
        tasks: ['Screens off 30 min before bed', 'Lights out by 10:30', '7+ hours'] },
      { title: 'Recovery day', color: '#5DCAA5', activeDays: [0],
        tasks: ['Foam roll', 'Plan next week\'s workouts', 'Prep meals', 'Long walk'] },
    ],
    cal: [
      { title: 'Strength',   start: '06:30', end: '07:30', color: '#22C55E', repeatDays: [1,3,5] },
      { title: 'Cardio',     start: '06:30', end: '07:15', color: '#E0B84F', repeatDays: [2,4] },
      { title: 'Mobility',   start: '09:00', end: '10:00', color: '#5DCAA5', repeatDays: [6] },
      { title: 'Meal prep',  start: '15:00', end: '17:00', color: '#E0B84F', repeatDays: [0] },
      { title: 'Wind-down',  start: '21:30', end: '21:30', color: '#8B5CF6', repeatDays: [0,1,2,3,4,5,6], type: 'divider' },
    ] },

  { id: 'creative', name: 'Creative', tagline: 'Make first, consume later. Studio time every day.', theme: 'lavender',
    timers: [
      { label: 'Creating',    seconds: 3*3600, color: '#B49CFF' },
      { label: 'Practice',    seconds: 1*3600, color: '#D4537E' },
      { label: 'Research',    seconds: 1*3600, color: '#378ADD' },
      { label: 'Sharing',     seconds: 30*60,  color: '#F97316' },
    ],
    daily: [
      { title: 'Warm-up', color: '#B49CFF', starred: true,
        tasks: ['Morning pages (3 pages)', 'Sketch or doodle 10 minutes', 'Write down one new idea'] },
      { title: 'Studio habits', color: '#D4537E', starred: true,
        tasks: ['Create before you consume', 'Back up today\'s files', 'Tidy the workspace', 'Note what to start with tomorrow'] },
      { title: 'Share day', color: '#F97316', activeDays: [2,5],
        tasks: ['Post one piece of work', 'Reply to comments & messages', 'Save 3 things that inspired you'] },
    ],
    cal: [
      { title: 'Studio time', start: '10:00', end: '13:00', color: '#B49CFF', repeatDays: [1,2,3,4,5] },
      { title: 'Lunch',       start: '13:00', end: '13:00', color: '#505050', repeatDays: [1,2,3,4,5], type: 'divider' },
      { title: 'Critique',    start: '16:00', end: '17:00', color: '#378ADD', repeatDays: [3] },
      { title: 'Practice',    start: '19:00', end: '20:00', color: '#D4537E', repeatDays: [0,1,2,3,4,5,6] },
      { title: 'Open studio', start: '10:00', end: '14:00', color: '#B49CFF', repeatDays: [6] },
    ] },

  { id: 'faith', name: 'Faith & Family', tagline: 'Devotion in the morning, family at the table.', theme: 'ember',
    timers: [
      { label: 'Time with God', seconds: 1*3600, color: '#8B5CF6' },
      { label: 'Family Time',   seconds: 2*3600, color: '#F0894A' },
      { label: 'Work',          seconds: 6*3600, color: '#378ADD' },
      { label: 'Service',       seconds: 30*60,  color: '#22C55E' },
    ],
    daily: [
      { title: 'Morning devotion', color: '#8B5CF6', starred: true,
        tasks: ['Prayer', 'Read scripture', 'Write down 3 things you\'re grateful for'] },
      { title: 'Family', color: '#F0894A', starred: true,
        tasks: ['Dinner together', 'No phones at the table', 'Bedtime check-in', 'One kind thing for someone at home'] },
      { title: 'Sabbath', color: '#22C55E', activeDays: [0],
        tasks: ['Church', 'Rest — no work email', 'Call a relative', 'Plan the week with the family'] },
    ],
    cal: [
      { title: 'Devotion',      start: '06:30', end: '07:00', color: '#8B5CF6', repeatDays: [0,1,2,3,4,5,6] },
      { title: 'Work',          start: '09:00', end: '17:00', color: '#378ADD', repeatDays: [1,2,3,4,5] },
      { title: 'Family dinner', start: '18:30', end: '19:30', color: '#F0894A', repeatDays: [0,1,2,3,4,5,6] },
      { title: 'Small group',   start: '19:00', end: '20:30', color: '#22C55E', repeatDays: [3] },
      { title: 'Church',        start: '10:00', end: '12:00', color: '#8B5CF6', repeatDays: [0] },
    ] },

  { id: 'minimal', name: 'Minimal', tagline: 'Two timers, one list. Nothing extra.', theme: 'sky',
    timers: [
      { label: 'Focus', seconds: 4*3600, color: '#1F8FD8' },
      { label: 'Rest',  seconds: 1*3600, color: '#22C55E' },
    ],
    daily: [
      { title: 'Essentials', color: '#1F8FD8', starred: true,
        tasks: ['Move', 'Read', 'Reflect'] },
    ],
    cal: [
      { title: 'Focus', start: '09:00', end: '13:00', color: '#1F8FD8', repeatDays: [1,2,3,4,5] },
      { title: 'Walk',  start: '17:00', end: '17:30', color: '#22C55E', repeatDays: [0,1,2,3,4,5,6] },
    ] },

];

/* A custom list that already plays the part of a template's list (same name). */
function templateListFor(l) {
  const name = l.title.trim().toLowerCase();
  return todoLists.find(x => !x.isDefault && (x.title || '').trim().toLowerCase() === name) || null;
}

export function formatTemplateById(id) { return FORMAT_TEMPLATES.find(t => t.id === id) || null; }

export function openFormatTemplates() {
  if (!formatMode) { showToast('Open Formats first, then pick a template.'); return; }
  renderFormatTemplates();
  $('fmtTemplateModal')?.classList.add('show');
}

function renderFormatTemplates() {
  const el = $('fmtTemplateGrid');
  if (!el) return;
  el.innerHTML = FORMAT_TEMPLATES.map(tp => {
    const th = themePreset(tp.theme);
    const swatches = tp.timers.map(t => `<span class="fmt-tpl-sw" style="background:${t.color}"></span>`).join('');
    const lists = [...tp.daily, ...(tp.lists || [])].map(d => `<span class="fmt-tpl-chip" style="--chip:${d.color}">${escAttr(d.title)}</span>`).join('');
    const counts = `${tp.timers.length} timer${tp.timers.length === 1 ? '' : 's'} · ${tp.daily.length} daily list${tp.daily.length === 1 ? '' : 's'}` +
      (tp.lists ? ` + ${tp.lists.map(l => escAttr(l.title)).join(', ')}` : '') +
      ` · ${tp.cal.length} calendar block${tp.cal.length === 1 ? '' : 's'}`;
    return `
      <button class="fmt-tpl-card" data-tpl="${tp.id}"
        style="--t-bg:${th.bg};--t-sf:${th.surface};--t-ink:${th.ink};--t-ink2:${th.ink2};--t-ac:${th.accent};--t-font:${escAttr(themeFontStack(th.font))};--t-r:${th.radius}px">
        <span class="fmt-tpl-preview" aria-hidden="true">
          <span class="fmt-tpl-preview-bar"></span>
          <span class="fmt-tpl-preview-row">${swatches}</span>
          <span class="fmt-tpl-preview-line" style="width:70%"></span>
          <span class="fmt-tpl-preview-line" style="width:45%"></span>
        </span>
        <span class="fmt-tpl-body">
          <span class="fmt-tpl-name">${escAttr(tp.name)}${tp.id === DEFAULT_TEMPLATE ? '<span class="fmt-tpl-default">Default</span>' : ''}</span>
          <span class="fmt-tpl-tag">${escAttr(tp.tagline)}</span>
          <span class="fmt-tpl-chips">${lists}</span>
          <span class="fmt-tpl-counts">${counts}</span>
        </span>
      </button>`;
  }).join('');
  el.querySelectorAll('.fmt-tpl-card').forEach(card => {
    card.addEventListener('click', () => {
      const withTheme = !!$('fmtTemplateTheme')?.checked;
      applyFormatTemplate(card.dataset.tpl, withTheme);
    });
  });
}

/* Replace the Formats-owned defaults with a template. Only runs inside
 * Formats, so the cloud stays held until Done — the user can undo by
 * simply editing, or by reloading the page before pressing Done. */
function applyFormatTemplate(id, withTheme) {
  if (!formatMode) return;
  const tp = formatTemplateById(id);
  if (!tp) return;
  const addLists = (tp.lists || []).filter(l => !templateListFor(l));
  const msg = `Load the "${tp.name}" template?\n\nThis replaces your timers, Daily lists, and weekly calendar templates` +
              (withTheme ? ', and switches the theme' : '') +
              `. Today's timer progress resets.\n\nCustom lists, Day by Day tasks, budget, and hand-added calendar events are kept` +
              (addLists.length ? `, and it adds ${addLists.map(l => `a ${l.title} list`).join(' and ')}.` : '.');
  if (!confirm(msg)) return;

  /* timers — a fresh set; live progress of the replaced timers is dropped */
  setTimers(tp.timers.map(t => ({
    id: nextFormatTimerId(), label: t.label, seconds: t.seconds, color: t.color,
    running: false, startedAt: null, secondsAtStart: null,
  })));
  setTimerDefaults(tp.timers.map(t => ({ label: t.label, seconds: t.seconds, color: t.color })));
  setPreFormatTimerState([]);

  /* Daily lists — replaced; custom lists ride along untouched, plus any
   * list the template brings that doesn't exist yet (added at the end) */
  const customLists = todoLists.filter(l => !l.isDefault);
  const dailyLists = tp.daily.map(d => ({
    id: nextTodoId(), title: d.title, color: d.color,
    isDefault: true, starred: !!d.starred,
    activeDays: Array.isArray(d.activeDays) ? d.activeDays.slice() : null,
    tasks: makeTasks(d.tasks),
  }));
  const newLists = addLists.map(l => ({
    id: nextTodoId(), title: l.title, color: l.color,
    isDefault: false, starred: !!l.starred, activeDays: null, tasks: [],
  }));
  setTodoLists([...dailyLists, ...customLists, ...newLists]);

  /* calendar templates — drop instances of the old ones (a linked instance
   * survives as a plain event, like reseedTemplate does), then seed new */
  const oldIds = new Set(calTemplates.map(t => t.id));
  Object.keys(calEvents).forEach(k => {
    calEvents[k] = calEvents[k].reduce((acc, e) => {
      if (e.templateId == null || !oldIds.has(e.templateId)) { acc.push(e); return acc; }
      if (taskLinkRefOfEvent(e)) acc.push({ ...e, fromTemplate: false, templateId: undefined });
      return acc;
    }, []);
  });
  setCalTemplates(tp.cal.map(c => ({
    id: nextCalEventId(), title: c.title, start: c.start, end: c.end, color: c.color,
    type: c.type || 'event', isTemplate: true, repeatDays: c.repeatDays.slice(),
  })));
  calTemplates.forEach(reseedTemplate);

  if (withTheme) themeApplyPreset(tp.theme);
  (tp.views || []).forEach(v => { if (!viewEnabled(v)) setViewEnabled(v, true); });

  renderTimers();
  renderTodos();
  setCalFmtMobileDay(0);
  calRefresh();
  calSave();
  saveToLocal();
  closeModal('fmtTemplateModal');
  showToast(`"${tp.name}" loaded — tweak anything, then press Done`);
}
