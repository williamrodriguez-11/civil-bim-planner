"""CPM scheduling in whole working days, with the rules of Microsoft Project.

Working time. Each calendar measures time in working days: the start of its
k-th working day is k and its end is k + 1. «Friday 17:00» and «Monday 08:00»
are therefore the same instant of work, as in Project, but they are shown as
different dates. A point in time is a pair (date, half): half 0 is the start
of the day and 1 its end.

Activities are scheduled as soon as possible from the project start, in the
calendar of each activity. Links (FS, SS, FF, SF) and their lags are measured
in the successor's calendar. A duration of 0 makes a milestone, which sits at
the instant that drives it: after an FS link it shows the predecessor's
finish date, as Project does.

Known differences with Project are listed in README («Reglas de programación»)
and each rule is covered by tests in tests_web/test_scheduling_rules.py.
"""

import math
from bisect import bisect_left
from datetime import date, timedelta
from graphlib import CycleError, TopologicalSorter

from .models import Plan

MAGNITUDES = {
    "m³": "Volumen (m³)",
    "m²": "Área (m²)",
    "ud": "Elementos",
    "m": "Longitud (m)",
    "kg": "Masa (kg)",
}
HORIZON = 36525  # 100 years, in calendar days
RELATION = {"FS": "FC", "SS": "CC", "FF": "FF", "SF": "CF"}


class ScheduleError(ValueError):
    """A scheduling problem tied, when possible, to one activity and field."""

    def __init__(self, message, task=None, field=None, cycle=None):
        super().__init__(message)
        self.task = task
        self.field = field
        self.cycle = cycle or []

    def info(self):
        return {"task": self.task, "field": self.field, "cycle": self.cycle}


class Calendar:
    """Working days of one calendar, counted from the project start."""

    def __init__(self, origin, weekdays, holidays):
        if not set(weekdays).issubset(range(7)):
            raise ScheduleError("El calendario acepta días entre lunes y domingo.")
        self.origin = origin
        self.weekdays = frozenset(weekdays)
        self.holidays = frozenset(holidays)
        self.days = []
        self._next = origin

    def works(self, day):
        return day.weekday() in self.weekdays and day not in self.holidays

    def _grow(self, until=None, count=0):
        while len(self.days) < count or (until is not None and self._next <= until):
            if (self._next - self.origin).days > HORIZON:
                raise ScheduleError(
                    "El cronograma supera el horizonte admitido de 100 años."
                )
            if self.works(self._next):
                self.days.append(self._next)
            self._next += timedelta(days=1)

    def work(self, point):
        """Working time (in days) at a point (date, half)."""
        day, half = point
        if day < self.origin:
            return 0
        self._grow(until=day)
        return bisect_left(self.days, day) + (1 if half and self.works(day) else 0)

    def start_point(self, w):
        """The start of working day number w."""
        self._grow(count=w + 1)
        return (self.days[w], 0)

    def end_point(self, w):
        """The end of working day number w - 1 (the instant w seen as a finish)."""
        if w <= 0:
            return (self.origin, 0)
        self._grow(count=w)
        return (self.days[w - 1], 1)


def non_working(calendar, first, last, limit=31):
    """Non-working days in [first, last), labelled for explanations."""
    found = []
    day = first
    while day < last and len(found) < limit:
        if not calendar.works(day):
            found.append(
                {
                    "date": day.isoformat(),
                    "kind": "festivo" if day in calendar.holidays else "no laborable",
                }
            )
        day += timedelta(days=1)
    return found


def calendars_for(plan):
    project = Calendar(plan.start, plan.weekdays, plan.holidays)
    named = {
        name: Calendar(
            plan.start,
            c.weekdays,
            set(c.holidays) | (set(plan.holidays) if c.project_holidays else set()),
        )
        for name, c in plan.calendars.items()
    }
    return project, named


def quantity_duration(task, sources):
    q = task.quantity
    rows = [
        r
        for r in sources.get(q.table, [])
        if (not q.level or r["Nivel"] == q.level)
        and (not q.category or r["Categoría"] == q.category)
    ]
    values = [r.get(MAGNITUDES[q.unit]) for r in rows]
    if q.unit == "m²" and len({r["Categoría"] for r in rows}) > 1:
        raise ScheduleError(
            f"{task.name}: selecciona una categoría para sumar superficies comparables.",
            task.id,
            "duration",
        )
    if not values or None in values:
        raise ScheduleError(
            f"{task.name}: la cantidad vinculada está incompleta o sin filas válidas.",
            task.id,
            "duration",
        )
    total = math.fsum(values)
    if total <= 0:
        raise ScheduleError(
            f"{task.name}: la cantidad debe ser positiva para calcular la duración.",
            task.id,
            "duration",
        )
    ratio = total / q.rate
    if not math.isfinite(ratio) or ratio > HORIZON:
        raise ScheduleError(
            f"{task.name}: revisa el rendimiento y la duración resultante.",
            task.id,
            "duration",
        )
    return max(1, math.ceil(ratio)), total


def validate(plan):
    if not 1900 <= plan.start.year <= 2199:
        raise ScheduleError("La fecha inicial debe estar entre 1900 y 2199.")
    ids, codes = {}, {}
    for t in plan.tasks:
        if t.id in ids:
            raise ScheduleError(f"{t.name}: el identificador está repetido.", t.id, "id")
        ids[t.id] = t
        if t.wbs in codes:
            raise ScheduleError(
                f"«{t.name}» y «{codes[t.wbs].name}» usan el mismo código EDT {t.wbs}.",
                t.id,
                "wbs",
            )
        codes[t.wbs] = t
        if t.calendar and t.calendar not in plan.calendars:
            raise ScheduleError(
                f"{t.name}: el calendario «{t.calendar}» no existe.", t.id, "calendar"
            )
    for code, t in codes.items():
        parts = code.split(".")
        for i in range(1, len(parts)):
            parent = codes.get(".".join(parts[:i]))
            if parent:
                raise ScheduleError(
                    f"«{parent.name}» ({parent.wbs}) contiene a «{t.name}». Las fases "
                    "agrupan actividades: usa códigos de hoja para las actividades.",
                    parent.id,
                    "wbs",
                )
    for t in plan.tasks:
        preds = [link.predecessor for link in t.links]
        if t.id in preds:
            raise ScheduleError(
                f"{t.name}: una actividad no puede depender de sí misma.", t.id, "links"
            )
        missing = [p for p in preds if p not in ids]
        if missing:
            raise ScheduleError(
                f"{t.name}: hay predecesoras que no existen.", t.id, "links"
            )
        if len(set(preds)) != len(preds):
            raise ScheduleError(f"{t.name}: predecesora repetida.", t.id, "links")
    return ids


def schedule(plan: Plan, sources, today=None):
    """Leaf activities with their computed dates, slack and explanations."""
    tasks = validate(plan)
    project, named = calendars_for(plan)
    cal = {t.id: named[t.calendar] if t.calendar else project for t in plan.tasks}
    durations, quantities = {}, {}
    for t in plan.tasks:
        if t.quantity:
            durations[t.id], quantities[t.id] = quantity_duration(t, sources)
        else:
            durations[t.id] = t.duration
    edges = {t.id: [link.predecessor for link in t.links] for t in plan.tasks}
    try:
        order = list(TopologicalSorter(edges).static_order())
    except CycleError as exc:
        cycle = list(dict.fromkeys(exc.args[1]))[::-1]
        names = [tasks[i].name for i in cycle] + [tasks[cycle[0]].name]
        raise ScheduleError(
            "Dependencia circular: " + " → ".join(names) + ". Quita uno de estos vínculos.",
            cycle[0],
            "links",
            cycle,
        ) from exc

    # Forward pass: earliest start and finish, as working time and as points.
    start_w, finish_w, start_pt, finish_pt, driver, natural = {}, {}, {}, {}, {}, {}
    for i in order:
        t, c, d = tasks[i], cal[i], durations[i]

        def at(w, finish_based):
            # A milestone driven by a finish sits at the end of that day.
            if d == 0 and finish_based and w > 0:
                return c.end_point(w)
            return c.start_point(w)

        # Candidates (working time, point, driver, natural date, finish
        # based). The latest wins; on a tie the earlier candidate wins, so
        # links come first and explain the date.
        candidates = []
        for link in t.links:
            p = link.predecessor
            base = finish_pt[p] if link.relation in ("FS", "FF") else start_pt[p]
            w = c.work(base) + link.lag
            if link.relation in ("FF", "SF"):
                w -= d  # the link constrains the finish
            w = max(w, 0)  # never before the project start
            finish_based = link.relation in ("FS", "FF")
            after = base[0] + timedelta(days=base[1])
            point = at(w, finish_based)
            if link.lag >= 0 and point < base:
                # The predecessor ends on a day this calendar does not work:
                # never place the activity before it.
                point = c.start_point(w)
            candidates.append(
                (
                    w,
                    point,
                    {
                        "type": "link",
                        "predecessor": p,
                        "relation": link.relation,
                        "lag": link.lag,
                    },
                    after if link.relation in ("FS", "SS") else None,
                    finish_based,
                )
            )
        if t.earliest:
            w = c.work((t.earliest, 0))
            candidates.append(
                (
                    w,
                    at(w, False),
                    {"type": "earliest", "date": t.earliest.isoformat()},
                    t.earliest,
                    False,
                )
            )
        candidates.append((0, at(0, False), {"type": "start"}, plan.start, False))
        s, point, why, near, finish_based = max(candidates, key=lambda x: (x[0], x[1]))
        if t.fixed_finish:
            if not c.works(t.fixed_finish):
                raise ScheduleError(
                    f"{t.name}: la fecha de finalización debe ser laborable.",
                    i,
                    "fixed_finish",
                )
            fixed = c.work((t.fixed_finish, 1)) - d
            if fixed < s:
                raise ScheduleError(
                    f"{t.name}: la duración, el inicio o las predecesoras impiden "
                    "finalizar en esa fecha.",
                    i,
                    "fixed_finish",
                )
            s = fixed
            why = {"type": "fixed_finish", "date": t.fixed_finish.isoformat()}
            near = None
            point = at(s, True)
        start_w[i], finish_w[i] = s, s + d
        driver[i], natural[i] = why, near
        if d == 0:
            # A milestone sits at the instant that drives it.
            start_pt[i] = finish_pt[i] = point
        else:
            start_pt[i], finish_pt[i] = c.start_point(s), c.end_point(s + d)

    # Backward pass: latest dates against the project finish.
    end = max(finish_pt.values(), default=(plan.start, 0))
    late_finish, late_start = {}, {}
    successors = {i: [] for i in tasks}
    for t in plan.tasks:
        for link in t.links:
            successors[link.predecessor].append((t.id, link))
    for i in reversed(order):
        t, c, d = tasks[i], cal[i], durations[i]
        lf = finish_w[i] if t.fixed_finish else c.work(end)
        for s, link in successors[i]:
            cs = cal[s]
            # The successor's bound, as the latest instant with that working
            # time (start of its next working day), so the predecessor keeps
            # days its own calendar works and the successor's does not.
            if link.relation in ("FS", "SS"):
                bound = cs.start_point(max(late_start[s] - link.lag, 0))
            else:
                bound = cs.start_point(max(late_finish[s] - link.lag, 0))
            if link.relation in ("FS", "FF"):
                lf = min(lf, c.work(bound))
            else:
                lf = min(lf, c.work(bound) + d)
        lf = max(lf, finish_w[i])
        late_finish[i], late_start[i] = lf, lf - d

    cut = plan.status_date or today or date.today()
    output = []
    for t in sorted(plan.tasks, key=lambda t: tuple(map(int, t.wbs.split(".")))):
        i, c, d = t.id, cal[t.id], durations[t.id]
        first, last = start_pt[i][0], finish_pt[i][0]
        # Dates outside the activity need no calendar (and no horizon).
        if cut >= last:
            planned = 100.0
        elif cut < first:
            planned = 0.0
        else:
            planned = round(100 * max(0, min(d, c.work((cut, 1)) - start_w[i])) / d, 1)
        slack = late_start[i] - start_w[i]
        row = {
            **t.model_dump(mode="json"),
            "duration": d,
            "amount": quantities.get(i),
            "milestone": d == 0,
            # A milestone at the end of its day (17:00), e.g. after an FS link.
            "at_day_end": d == 0 and start_pt[i][1] == 1,
            "start": first.isoformat(),
            "finish": last.isoformat(),
            "slack": slack,
            "critical": slack <= 0,
            "planned": planned,
            # Without slack the latest dates are the scheduled ones (this keeps
            # a milestone fixed at 17:00 on its own day).
            "late_start": (
                first if slack <= 0 else c.start_point(late_start[i])[0]
            ).isoformat(),
            "late_finish": (
                last
                if slack <= 0
                else (c.end_point(late_finish[i]) if d else c.start_point(late_start[i]))[0]
            ).isoformat(),
            "driver": driver[i],
            # Why the start moved: non-working days between the date the
            # driver allows and the actual start.
            "shifted": non_working(c, natural[i], first) if natural[i] else [],
            # Non-working days inside the activity, which lengthen it in
            # calendar days.
            "spanned": non_working(c, first, last) if d else [],
        }
        base = plan.baseline.get(i)
        if base:
            # Count from the earliest date involved: the baseline may be
            # before a project start that moved later.
            first_day = min(base.start, first, plan.start)
            span = Calendar(first_day, c.weekdays, c.holidays)
            end_half = 1 if base.duration or base.at_day_end else 0
            row["baseline"] = {
                "start": base.start.isoformat(),
                "finish": base.finish.isoformat(),
                "duration": base.duration,
                "at_day_end": base.at_day_end,
                # Positive = later than the baseline, in working days.
                "start_variance": span.work(start_pt[i])
                - span.work((base.start, end_half if not base.duration else 0)),
                "finish_variance": span.work(finish_pt[i]) - span.work((base.finish, end_half)),
            }
        output.append(row)
    return output


def phases(plan: Plan, rows):
    """Summary rows for every phase code (WBS prefix) used by the activities."""
    project, _ = calendars_for(plan)
    children = {}
    for row in rows:
        parts = row["wbs"].split(".")
        for i in range(1, len(parts)):
            children.setdefault(".".join(parts[:i]), []).append(row)
    output = []
    for code in sorted(children, key=lambda c: tuple(map(int, c.split(".")))):
        group = children[code]
        start = min(r["start"] for r in group)
        finish = max(r["finish"] for r in group)
        weight = sum(r["duration"] for r in group)
        average = lambda key: (  # noqa: E731
            round(sum(r[key] * r["duration"] for r in group) / weight, 1)
            if weight
            else round(sum(r[key] for r in group) / len(group), 1)
        )
        summary = {
            "code": code,
            "name": plan.groups.get(code, "Fase " + code),
            "start": start,
            "finish": finish,
            "duration": max(
                0,
                project.work((date.fromisoformat(finish), 1))
                - project.work((date.fromisoformat(start), 0)),
            )
            if weight
            else 0,
            "progress": average("progress"),
            "planned": average("planned"),
            "slack": min(r["slack"] for r in group),
            "critical": any(r["critical"] for r in group),
            "tasks": len(group),
        }
        bases = [r["baseline"] for r in group if r.get("baseline")]
        if bases:
            summary["baseline"] = {
                "start": min(b["start"] for b in bases),
                "finish": max(b["finish"] for b in bases),
            }
        output.append(summary)
    return output
