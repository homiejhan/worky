/* Lists: starring or recolouring a list repaints it where it is drawn.
 * Neither rebuilds the cards (nor Day by Day). A click focuses the star, and a
 * rebuild destroyed that button half-way through: the browser then laid out
 * the half-built page and the panel jumped up toward the top of the lists,
 * and every checked box popped again. So the checks here are that the very
 * same nodes stay on the page, and that everything wearing the star or the
 * colour shows the change.
 * Run: npm test (or node --experimental-vm-modules tests/test_lists.js) */
const { loadApp } = require('./load-app');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)})`); }

(async () => {
  const { w, d, errors } = await loadApp({ storage: { 'focus-tour-done': '1' } });
  const today = w.dbdTodayKey();

  /* a list of three: the first checked, the second due today (so it is in Day by Day and on Home) */
  w.addTodoList();
  const list = w.todoLists[w.todoLists.length - 1];
  w.setListTitle(list.id, 'Errands');
  const tasks = ['Post office', 'Pharmacy', 'Groceries'].map(text => {
    w.addTask(list.id);
    const t = list.tasks[list.tasks.length - 1];
    w.setTaskText(list.id, t.id, text);
    return t;
  });
  w.toggleTask(list.id, tasks[0].id);
  w.setListTaskDue(list.id, tasks[1].id, today);

  const allCards = () => [...d.querySelectorAll('.todo-card')];
  const dbdRows = () => [...d.querySelectorAll('.dbd-row')];
  const cardsOf = id => [...d.querySelectorAll(`.todo-card[data-list-id="${id}"]`)];
  const same = (before, now) => before.length === now.length && before.every((n, i) => n === now[i]);
  const saved = id => JSON.parse(w.localStorage.getItem('focus-app-state')).todoLists.find(l => l.id === id);
  const homeTitles = () => [...d.querySelectorAll('#homeContainer-d .home-list-card .home-list-title')].map(e => e.textContent.trim());
  const rgb = c => { const s = d.createElement('i').style; s.color = c; return s.color; };

  console.log('\n── 1. Starring a list: repainted in place, nothing rebuilt ──');
  {
    eq(cardsOf(list.id).length, 2, 'the list is drawn twice (desktop and phone layouts)');
    const cards0 = allCards(), rows0 = dbdRows();
    const star = d.querySelector(`#todoContainer-d .todo-card[data-list-id="${list.id}"] .list-star-btn`);
    star.click();
    ok(same(cards0, allCards()), 'every list card is the node it was (none rebuilt)');
    ok(same(rows0, dbdRows()), 'Day by Day is untouched');
    ok(star.isConnected, 'the star that was clicked is still on the page');
    ok(cardsOf(list.id).every(c => c.classList.contains('starred')), 'both of its cards show it starred');
    ok(cardsOf(list.id).every(c => {
      const b = c.querySelector('.list-star-btn');
      return b.classList.contains('starred') && b.title === 'Unstar list';
    }), 'both stars are filled and say "Unstar list"');
    eq(saved(list.id).starred, true, 'saved as starred');
    ok(homeTitles().includes('Errands'), 'Home shows it under Starred lists');

    star.click();
    ok(same(cards0, allCards()), 'unstarring rebuilds nothing either');
    ok(cardsOf(list.id).every(c => !c.classList.contains('starred') && !c.querySelector('.list-star-btn').classList.contains('starred')),
      'both cards and stars are plain again');
    eq(star.title, 'Star list as more important', 'and the star says so');
    eq(saved(list.id).starred, false, 'saved as not starred');
    ok(!homeTitles().includes('Errands'), 'Home no longer shows it');
  }

  console.log('\n── 2. Recolouring a list: repainted in place at every step of the picker ──');
  {
    const cards0 = allCards(), rows0 = dbdRows();
    const picker = d.querySelector(`#todoContainer-d .todo-card[data-list-id="${list.id}"] input[type="color"]`);
    const C = '#8b5cf6';
    ['#e11d48', '#0ea5e9', C].forEach(c => { picker.value = c; picker.dispatchEvent(new w.Event('input', { bubbles: true })); });
    ok(same(cards0, allCards()), 'every list card is the node it was');
    ok(same(rows0, dbdRows()), 'Day by Day rows are the nodes they were (it was redrawn at every step)');
    eq(saved(list.id).color, C, 'saved');
    ok(cardsOf(list.id).every(c => c.style.getPropertyValue('--lc') === C), 'its cards wear the colour');
    ok(cardsOf(list.id).every(c => rgb(c.querySelector('.color-swatch').style.backgroundColor) === rgb(C)
      && rgb(c.querySelector('.todo-accent-strip').style.backgroundColor) === rgb(C)), 'swatch and strip');
    ok([...d.querySelectorAll(`.task-checks-${tasks[0].id}`)].every(c => rgb(c.style.backgroundColor) === rgb(C)), 'the checked box');
    const chips = cardsOf(list.id).map(c => c.querySelector('.task-date-chip.has-date'));
    ok(chips.length === 2 && chips.every(ch => ch && rgb(ch.style.color) === rgb(C)), 'the date chip of the task due today (it kept the old colour)');
    const rows = dbdRows().filter(r => r.dataset.listId === String(list.id));
    ok(rows.length === 2 && rows.every(r => r.style.getPropertyValue('--tagc') === C), 'its rows in Day by Day');
    const dot = d.querySelector('#homeContainer-d .home-dbd-tag[title="Errands"]');
    ok(dot && rgb(dot.style.backgroundColor) === rgb(C), 'its task on Home');
  }

  console.log('\n── 3. A Daily list stars in place too ──');
  {
    const daily = w.todoLists.find(l => l.isDefault && cardsOf(l.id).length);
    ok(!!daily, 'a Daily list is on the page');
    const cards0 = allCards(), was = !!daily.starred;   // (the starter day stars some)
    d.querySelector(`#defaultContainer-d .todo-card[data-list-id="${daily.id}"] .list-star-btn`).click();
    ok(same(cards0, allCards()), 'nothing rebuilt');
    ok(cardsOf(daily.id).every(c => c.classList.contains('starred') === !was) && saved(daily.id).starred === !was,
      `its cards show it ${was ? 'unstarred' : 'starred'}, and it is saved`);
  }

  console.log('\n── 4. (control) a full redraw does put in new nodes ──');
  {
    const cards0 = allCards();
    w.renderTodos();
    ok(cards0.every(c => !c.isConnected), 'renderTodos() replaces every card, so the checks above would catch one');
  }

  eq(errors.length, 0, 'no uncaught error');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
