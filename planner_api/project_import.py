"""Importación MSPDI (XML de Microsoft Project) a un plan de la app.

Lo que la app no representa se omite y se explica en `notes`: recursos,
costos, vínculos con tareas resumen y algunos tipos de restricción.
"""

import re
from datetime import date, timedelta

from defusedxml import ElementTree as ET
from defusedxml.common import DefusedXmlException

from .models import Plan

MAX_TASKS = 2000
RELATIONS = {0: "FF", 1: "FS", 2: "SF", 3: "SS"}
# LagFormat codes counted in calendar time rather than working time.
ELAPSED = {4, 6, 8, 10, 12}
PERCENT = {19, 20}


class XmlImportError(ValueError):
    pass


def _tag(node):
    return node.tag.rsplit("}", 1)[-1]


def _child(node, name):
    for c in node:
        if _tag(c) == name:
            return c
    return None


def _children(node, name):
    return [c for c in node if _tag(c) == name]


def _text(node, name, default=""):
    c = _child(node, name)
    return c.text.strip() if c is not None and c.text else default


def _int(node, name, default=0):
    try:
        value = float(_text(node, name, str(default)))
        return int(value) if abs(value) < 1e12 else default
    except (ValueError, OverflowError):
        return default


def _bool(node, name, default=False):
    """xsd:boolean: 1/0 or true/false."""
    value = _text(node, name).lower()
    return value in ("1", "true") if value else default


def _elapsed(fmt):
    """Duration formats in calendar time; estimated ones add 32 (MSPDI)."""
    return (fmt - 32 if fmt >= 32 else fmt) in ELAPSED


def _day(value):
    try:
        return date.fromisoformat(value[:10]) if value else None
    except ValueError:
        return None


def _minutes(duration):
    """PT16H30M0S (also with days, and fractional seconds) to minutes."""
    m = re.fullmatch(
        r"-?P(?:(\d+(?:\.\d+)?)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?",
        duration or "",
    )
    if not m:
        return 0.0
    d, h, mi, s = (float(x) if x else 0.0 for x in m.groups())
    return d * 24 * 60 + h * 60 + mi + s / 60


def _calendar(node):
    """Working weekdays (0 = Monday), non-working dates of a calendar, and
    how many recurring exceptions (weekly, monthly, yearly) were left out."""
    weekdays, holidays, explicit, recurring, working = set(), set(), False, 0, 0
    week = _child(node, "WeekDays")
    for day in _children(week, "WeekDay") if week is not None else []:
        kind = _int(day, "DayType")
        period = _child(day, "TimePeriod")
        if kind == 0 and period is not None:
            # Older files keep exceptions here.
            if not _bool(day, "DayWorking", True):
                holidays |= _span(period)
        elif 1 <= kind <= 7 and period is None:
            explicit = True
            if _bool(day, "DayWorking"):
                weekdays.add((kind + 5) % 7)
    exceptions = _child(node, "Exceptions")
    for e in _children(exceptions, "Exception") if exceptions is not None else []:
        period = _child(e, "TimePeriod")
        if period is None:
            continue
        if _bool(e, "DayWorking", True):
            working += 1  # an extra working day: the app can't add one
            continue
        # A one-off span (Type 9) or a daily one every day (Type 1, period 1)
        # covers all its days; other recurrences only some of them, which
        # the app can't keep.
        kind = _int(e, "Type", 1)
        if kind == 9 or (kind == 1 and _int(e, "Period", 1) <= 1):
            holidays |= _span(period)
        else:
            recurring += 1
    return (weekdays if explicit else None), holidays, recurring, working


def _span(period):
    start, end = _day(_text(period, "FromDate")), _day(_text(period, "ToDate"))
    if not start or not end or end < start:
        return set()
    days = min((end - start).days, 3660)
    return {start + timedelta(d) for d in range(days + 1)}


def plan_from_xml(data: bytes, current: Plan, durations=None):
    """`durations`: current duration of each saved activity, to keep a
    link to quantities only while Project did not change those days."""
    try:
        root = ET.fromstring(data)
    except (ET.ParseError, DefusedXmlException, ValueError, LookupError):
        raise XmlImportError(
            "El archivo no es un XML válido. En Project usa Archivo › Guardar como › XML."
        ) from None
    if _tag(root) != "Project" or _child(root, "Tasks") is None:
        raise XmlImportError(
            "Este XML no es un cronograma de Microsoft Project (formato MSPDI)."
        )

    notes = []
    per_day = _int(root, "MinutesPerDay", 480) or 480
    start = _day(_text(root, "StartDate")) or current.start

    calendars = {}
    nodes = _child(root, "Calendars")
    for c in _children(nodes, "Calendar") if nodes is not None else []:
        if not _bool(c, "IsBaseCalendar", True):
            continue  # resource calendars
        weekdays, holidays, recurring, working = _calendar(c)
        if working:
            notes.append(
                f"El calendario «{_text(c, 'Name') or 'sin nombre'}» tiene {working} días extra de trabajo (por ejemplo un sábado laborable) que la app no puede añadir; revisa las fechas cercanas."
            )
        if recurring:
            notes.append(
                f"El calendario «{_text(c, 'Name') or 'sin nombre'}» tiene {recurring} excepciones repetitivas (semanales, mensuales o anuales) que no se importaron; agrega esos días como festivos."
            )
        calendars[_int(c, "UID", -1)] = {
            "name": _text(c, "Name") or "Calendario",
            "base": _int(c, "BaseCalendarUID", -1),
            "weekdays": weekdays,
            "holidays": holidays,
        }

    def resolved(uid, depth=0):
        """A calendar with what it inherits from its base calendar."""
        c = calendars.get(uid)
        if not c:
            return None
        weekdays, holidays = c["weekdays"], set(c["holidays"])
        if c["base"] in calendars and c["base"] != uid and depth < 5:
            parent = resolved(c["base"], depth + 1)
            if parent:
                weekdays = weekdays if weekdays is not None else parent[0]
                holidays |= parent[1]
        return (weekdays if weekdays is not None else set(range(5))), holidays

    project_uid = _int(root, "CalendarUID", 1)
    base = resolved(project_uid) or (set(current.weekdays), set(current.holidays))
    if not base[0]:
        base = (set(range(5)), base[1])

    before = {t.id: t for t in current.tasks}
    tasks, groups, links, summary_uids = [], {}, {}, set()
    own_calendars, baseline = {}, {}
    counters = []
    skipped = {
        "links_summary": 0,
        "links_missing": 0,
        "links_external": 0,
        "constraints": 0,
        "elapsed": 0,
        "manual": 0,
        "milestones": 0,
        "elapsed_tasks": 0,
        "quantity": 0,
        "inactive": 0,
    }
    inactive = set()
    skip_below = None

    for node in _children(_child(root, "Tasks"), "Task"):
        uid = _int(node, "UID", -1)
        level = _int(node, "OutlineLevel", 0)
        if uid <= 0 or level <= 0 or _bool(node, "IsNull"):
            continue
        # Inactive in Project (with everything under it): it schedules
        # nothing there either.
        if skip_below is not None and level > skip_below:
            inactive.add(uid)
            continue
        skip_below = None
        if not _bool(node, "Active", True):
            skipped["inactive"] += 1
            inactive.add(uid)
            skip_below = level
            continue
        name = (_text(node, "Name") or "Sin nombre")[:160]
        # Our own outline numbering from the order and levels in the file.
        level = min(level, len(counters) + 1)
        del counters[level:]
        if len(counters) < level:
            counters.append(0)
        counters[level - 1] += 1
        wbs = ".".join(map(str, counters))
        if _bool(node, "Summary"):
            groups[wbs] = name
            summary_uids.add(uid)
            # Links whose successor is a phase can't be kept either.
            skipped["links_summary"] += len(_children(node, "PredecessorLink"))
            continue
        if len(tasks) >= MAX_TASKS:
            raise XmlImportError(f"El cronograma tiene más de {MAX_TASKS} actividades.")
        minutes = _minutes(_text(node, "Duration"))
        if _elapsed(_int(node, "DurationFormat", 7)) and minutes:
            # Elapsed days (24 h each) become the same number of working days.
            minutes = minutes / (24 * 60) * per_day
            skipped["elapsed_tasks"] += 1
        # A milestone here has no duration; one with work in Project keeps
        # its days and loses the mark.
        flagged = _bool(node, "Milestone")
        milestone = minutes == 0
        if flagged and not milestone:
            skipped["milestones"] += 1
        duration = 0 if milestone else max(1, round(minutes / per_day))
        task = {
            "id": uid,
            "name": name,
            "wbs": wbs,
            "duration": min(duration, 3650),
            "progress": min(100, max(0, _int(node, "PercentComplete"))),
        }
        kind = _int(node, "ConstraintType")
        when = _day(_text(node, "ConstraintDate"))
        if kind in (2, 4) and when:  # must / start no earlier than
            task["earliest"] = when
        elif kind == 3 and when:  # must finish on
            task["fixed_finish"] = when
        elif kind == 1 or (kind not in (0,) and when):
            skipped["constraints"] += 1  # includes «as late as possible»
        # A manually scheduled task sits where it was placed: keep its start
        # as «no empezar antes del» when nothing else fixes it.
        placed = _day(_text(node, "Start"))
        if (
            _bool(node, "Manual")
            and placed
            and "earliest" not in task
            and "fixed_finish" not in task
        ):
            task["earliest"] = placed
            skipped["manual"] += 1
        cal = _int(node, "CalendarUID", -1)
        if cal not in (-1, project_uid) and cal in calendars:
            own = resolved(cal)
            label = calendars[cal]["name"][:160]
            if own and own[0]:
                own_calendars[label] = {
                    "weekdays": sorted(own[0]),
                    "holidays": sorted(own[1]),
                    "project_holidays": False,
                }
                task["calendar"] = label
        # Kept from this app's plan: the link to quantities of the same task.
        old = before.get(uid)
        if old and old.quantity and old.name.strip().lower() == name.strip().lower():
            if (durations or {}).get(uid) == task["duration"]:
                task["quantity"] = old.quantity.model_dump()
            else:
                skipped["quantity"] += 1
        links[uid] = _children(node, "PredecessorLink")
        b = next(
            (x for x in _children(node, "Baseline") if _text(x, "Number", "0") == "0"),
            None,
        )
        if b is not None and _day(_text(b, "Start")) and _day(_text(b, "Finish")):
            # What was saved then, not what the task is now.
            saved_minutes = _minutes(_text(b, "Duration"))
            if _elapsed(_int(b, "DurationFormat", 7)):
                saved_minutes = saved_minutes / (24 * 60) * per_day
            saved = (
                0 if saved_minutes == 0 else min(3650, max(1, round(saved_minutes / per_day)))
            )
            baseline[uid] = {
                "start": _day(_text(b, "Start")),
                "finish": _day(_text(b, "Finish")),
                "duration": saved,
                "at_day_end": saved == 0 and _text(b, "Start")[11:13] >= "12",
            }
        tasks.append(task)

    if not tasks:
        raise XmlImportError("El XML no tiene actividades para importar.")

    ids = {t["id"]: t for t in tasks}
    for t in tasks:
        t["links"] = []
        for link in links[t["id"]]:
            pred = _int(link, "PredecessorUID", -1)
            if _bool(link, "CrossProject"):
                skipped["links_external"] += 1
                continue
            if pred in inactive:
                continue  # counted with the inactive task
            if pred in summary_uids:
                skipped["links_summary"] += 1
                continue
            if pred not in ids or pred == t["id"]:
                skipped["links_missing"] += 1
                continue
            if any(x["predecessor"] == pred for x in t["links"]):
                continue
            fmt = _int(link, "LagFormat", 7)
            base_fmt = fmt - 32 if fmt >= 32 else fmt  # estimated formats
            if base_fmt in PERCENT:
                # Stored as the percentage itself.
                lag = round(ids[pred]["duration"] * _int(link, "LinkLag") / 100)
            elif _elapsed(fmt):
                # Tenths of minutes of calendar time; applied in working days.
                lag = round(_int(link, "LinkLag") / 10 / (24 * 60))
                skipped["elapsed"] += bool(lag)
            else:
                lag = round(_int(link, "LinkLag") / 10 / per_day)
            t["links"].append(
                {
                    "predecessor": pred,
                    "relation": RELATIONS.get(_int(link, "Type", 1), "FS"),
                    "lag": max(-3650, min(3650, lag)),
                }
            )

    if skipped["links_summary"]:
        notes.append(
            f"Se omitieron {skipped['links_summary']} vínculos con tareas resumen (fases): aquí solo se vinculan actividades."
        )
    if skipped["links_missing"]:
        notes.append(
            f"Se omitieron {skipped['links_missing']} vínculos con tareas que no están en el archivo."
        )
    if skipped["links_external"]:
        notes.append(
            f"Se omitieron {skipped['links_external']} vínculos con otros proyectos."
        )
    if skipped["elapsed"]:
        notes.append(
            f"{skipped['elapsed']} esperas en días corridos se pasaron a días laborables; revisa esas fechas."
        )
    if skipped["inactive"]:
        notes.append(
            f"Se omitieron {skipped['inactive']} tareas inactivas y sus vínculos."
        )
    if skipped["elapsed_tasks"]:
        notes.append(
            f"{skipped['elapsed_tasks']} duraciones en días corridos se pasaron a días laborables; revisa esas fechas."
        )
    if skipped["quantity"]:
        notes.append(
            f"{skipped['quantity']} actividades cambiaron de duración en Project: se usa la del archivo y dejan de calcularse con cantidades."
        )
    if skipped["milestones"]:
        notes.append(
            f"{skipped['milestones']} hitos con duración en Project se importaron como actividades, para no perder sus días."
        )
    if skipped["manual"]:
        notes.append(
            f"{skipped['manual']} tareas programadas manualmente conservan su inicio como «No empezar antes del»."
        )
    if skipped["constraints"]:
        notes.append(
            f"Se omitieron {skipped['constraints']} restricciones que la app no maneja (por ejemplo «Lo más tarde posible» o «Terminar no antes del»)."
        )
    if _child(root, "Resources") is not None and _children(
        _child(root, "Resources"), "Resource"
    ):
        notes.append("Los recursos y costos se quedan en Project; no se importan.")

    status = _day(_text(root, "StatusDate"))
    plan = Plan.model_validate(
        {
            "start": start,
            "status_date": status,
            "weekdays": sorted(base[0]),
            "holidays": sorted(base[1]),
            "tasks": tasks,
            "groups": groups,
            "calendars": own_calendars,
            "baseline": baseline,
            "baseline_saved": (current.baseline_saved or date.today()) if baseline else None,
        }
    )
    return plan, notes
