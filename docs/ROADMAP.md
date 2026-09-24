# Focus: what to focus on next

*Week 5, September 23, 2026. Written for the team forming this week.*

> **Build the planner for students who work: classes, shifts, and cash on one page, with a single insight layer that reads across all three. Stop building things Google gives away.**

## The decision

Every generic direction we tested (modes, a customizable insights feed, the email digest as the headline) lands Focus in a category where it is a worse version of Structured, Gemini Daily Brief, or Copilot Money. The only uncontested gap is the join of academic deadlines, shift-based earning, and cash position. No competitor holds all three, and the join exists only because those things already live together in one local state blob. That is the product, the moat, and the pitch.

## Keep / Stop

| Keep | Stop |
|---|---|
| The one-page day surface: timers, lists, calendar, envelope. It is the join. | Focus / Talk / Money modes. Three products, three eval sets, walls between the data. |
| Two-way Google Calendar sync. It becomes the shift pipe. | User-added insight sources (deals, events). Google Now shipped this in 2012. |
| The self-hosted digest pipeline, as proof of engineering, not as the product. | The digest as the headline. Daily Brief is free; reading Gmail needs a CASA audit and caps you near 100 users. |
| The Student and Night Owl templates. Merge them into a default "Working student" template. | New themes. Nine is enough. |

## Why now

- **July 1, 2026.** Parent PLUS loans capped at $20,000 a year and $65,000 lifetime; Grad PLUS eliminated; loans prorated for part-time enrollment. Working more now shrinks what a student can borrow. Rules are under legal challenge.
- **September 30, 2026.** FY27 budget deadline. The House cuts Federal Work-Study by $322M; the President's request cuts it to $123M and shifts 90% of wages onto employers. Fewer campus jobs means more off-campus shifts.
- **April to May 2026.** The Canvas breach exposed names, emails, student IDs, and messages. Any Canvas integration has to lead with "we store due dates, not people." A local-first PWA can say that; a data-hoarding SaaS can't.

## The numbers, and who each one is for

| Number | What it says | Audience |
|---|---|---|
| **1 in 4** | students missed class because of a work-schedule conflict (Trellis, fall 2024, 53,158 students) | VC: the collision is measurable |
| **68%** | ran out of money at least once in ten months; 1 in 5 did it eight times; 56% couldn't cover a $500 surprise | Student: it's timing, not literacy |
| **38%** | think their school knows their financial situation, while 32% considered stopping out in the last six months | Financial-aid director: you have the budget and can't see the problem |
| **~40%** | of full-time undergrads work in a given term (NCES); Trellis's 67% is from an opt-in sample and runs high | Use the conservative figure on slides |

## Build order, as time budgets

| Weeks | Work |
|---|---|
| 6 | Foundation: split `app.js`, commit from the CLI |
| 6–7 | Shifts + wage: iCal feeds through existing Calendar sync, wage field per event |
| 7–8 | Canvas import: student OAuth2, due dates only |
| 7–9 | Three fixed insight cards + evals (Week 7 is evals week) |
| 8–9 | Cash runway: envelope × projected shifts → days until payday |
| 10 | Pilot beta with a UT office |
| 11–13 | Iterate on real users; YC draft in Week 13 |
| 12 | Optional: MCP `add_insight` write tool |
| 15–16 | Pitch practice, public demo (Week 14 is Thanksgiving) |

The three insight cards: a shift collides with a deadline; days of cash until the next paycheck; a timer you overrun three days running means the budget is wrong, not you. Each is computed from data only Focus holds, so each can be evaluated.

## Before teammates touch the code

- `app.js` is 8,052 lines in one file and most commits are "Add files via upload." Split into modules and commit from the CLI, or the first merge conflict costs a week.
- The privacy policy says GitHub Pages; you're on Amplify. Pick one name, Focus or Worky, everywhere.
- Shift schedules from When I Work, Sling, 7shifts, and Homebase arrive as iCal feeds a student subscribes to in Google Calendar. Your sync already sees them. Add a wage field to calendar events and you have earning capacity with no new Google permission.
- No bank linking in v1. Plaid pricing is gated and the compliance load is real; manual envelope plus projected pay is enough to test the thesis.

## Prove it

Run a free, opt-in pilot with 50 to 200 self-identified working students for one semester. First doors: the financial aid office, Student Emergency Services, Texas One Stop, with introductions through the Texas Innovation Center. TRIO is a natural fit but is proposed for elimination in FY27, so don't make it the only door.

Measure four things: weekly active use, classes missed for work, times money ran out, and next-term registration against a comparison group. That data is worth more than year-one revenue; it is what makes the second school and the YC application credible.

Money, plainly: consumer direct is validation, not a business (web is about 3% of subscription revenue; roughly 2.6% of downloads convert). The institutional rate card is $2 to $5 per student per year. A realistic year one is one free pilot and, at best, one paid school.

## The pitch in two lines

- **Why now:** loan caps took effect July 1 and Work-Study is being cut on September 30. More students will work more hours with less borrowing to fall back on.
- **Why us:** Google has the calendar but not the wage or the envelope. The bank has the balance but not the deadlines. Canvas has the deadlines but neither. Focus is the only place all three sit in one state, on the student's own device.
- **Positioning:** Focus is the one place a working student sees their classes, their shifts, and whether they'll make rent, and it replans when something slips.

## First five interviews

1. Walk me through how you track deadlines, shifts, and money today. Which tools?
2. When did a shift and a deadline last collide? What did you decide, and how?
3. Have you ever picked up or dropped a shift because of money?
4. Do you know right now whether you'll make rent this month? How do you check?
5. If your university gave you this for free, would you trust it more or less?

## Sources

- [Trellis Student Financial Wellness Survey, fall 2024 (Inside Higher Ed summary)](https://www.insidehighered.com/news/student-success/college-experience/2025/04/29/college-students-lack-housing-food-reliable)
- [Lumina Foundation-Gallup 2025 State of Higher Education](https://news.gallup.com/poll/659897/one-three-college-students-consider-leaving-program.aspx)
- [NCES, college student employment](https://nces.ed.gov/programs/coe/indicator/ssa/college-student-employment)
- [NASFAA on the House FY2027 budget](https://www.nasfaa.org/statement_on_house_fiscal_year_2027_budget_proposal) and [the President's FY2027 request](https://www.powerslaw.com/washington-update-april-2026/)
- [Federal loan changes effective July 1, 2026](https://www.ets.org/grad-school-journey/student-loan-changes-2026.html)
- [Instructure, IgniteAI Agent and Canvas tiers](https://www.instructure.com/press-release/instructure-introduces-simplified-canvas-tiers-and-ecosystem-updates-new-next); [2026 Canvas data breach](https://en.wikipedia.org/wiki/2026_Canvas_data_breach)
- [Menlo Ventures, 2026 State of Consumer AI](https://menlovc.com/perspective/2026-the-state-of-consumer-ai/)
- [RevenueCat, State of Subscription Apps 2026](https://www.revenuecat.com/state-of-subscription-apps)
