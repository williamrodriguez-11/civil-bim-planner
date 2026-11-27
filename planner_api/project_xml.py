"""Exportación MSPDI: días laborables de 8 horas y dependencias en décimas de minuto."""

from xml.etree import ElementTree as ET

MORNING, EVENING = "08:00:00", "17:00:00"


def project_xml(name, plan, tasks, phases=()):
    root = ET.Element("Project", xmlns="http://schemas.microsoft.com/project/2007")

    def fields(parent, **values):
        for key, val in values.items():
            ET.SubElement(parent, key).text = str(val)

    fields(
        root,
        SaveVersion=12,
        Name=name,
        ScheduleFromStart=1,
        StartDate=f"{plan.start}T{MORNING}",
        CurrencyCode="COP",
        CalendarUID=1,
        DefaultStartTime=MORNING,
        DefaultFinishTime=EVENING,
        MinutesPerDay=480,
        MinutesPerWeek=480 * len(plan.weekdays),
        DurationFormat=7,
    )
    if plan.status_date:
        fields(root, StatusDate=f"{plan.status_date}T{EVENING}")

    calendars = ET.SubElement(root, "Calendars")
    calendar_uid = {"": 1}

    def calendar(uid, label, weekdays, holidays):
        node = ET.SubElement(calendars, "Calendar")
        fields(node, UID=uid, Name=label, IsBaseCalendar=1, BaseCalendarUID=-1)
        days = ET.SubElement(node, "WeekDays")
        for i in range(1, 8):
            work = (i + 5) % 7 in weekdays
            day = ET.SubElement(days, "WeekDay")
            fields(day, DayType=i, DayWorking=int(work))
            if work:
                times = ET.SubElement(day, "WorkingTimes")
                for a, b in [(MORNING, "12:00:00"), ("13:00:00", EVENING)]:
                    fields(ET.SubElement(times, "WorkingTime"), FromTime=a, ToTime=b)
        if holidays:
            exceptions = ET.SubElement(node, "Exceptions")
            for h in sorted(holidays):
                e = ET.SubElement(exceptions, "Exception")
                fields(e, EnteredByOccurrences=0)
                fields(
                    ET.SubElement(e, "TimePeriod"),
                    FromDate=f"{h}T00:00:00",
                    ToDate=f"{h}T23:59:00",
                )
                fields(e, Occurrences=1, Name="Día no laborable", Type=1, DayWorking=0)

    calendar(1, "Calendario de obra", plan.weekdays, plan.holidays)
    for uid, (label, c) in enumerate(sorted(plan.calendars.items()), 2):
        calendar_uid[label] = uid
        holidays = set(c.holidays) | (set(plan.holidays) if c.project_holidays else set())
        calendar(uid, label, c.weekdays, holidays)

    summaries = {p["code"]: p for p in phases}
    collection = ET.SubElement(root, "Tasks")
    group_uid = max((task["id"] for task in tasks), default=0)
    seen_groups = set()
    index = 0

    def baseline(node, base, duration):
        b = ET.SubElement(node, "Baseline")
        fields(
            b,
            Number=0,
            Start=f"{base['start']}T{EVENING if not duration and base.get('at_day_end') else MORNING}",
            Finish=f"{base['finish']}T{EVENING if duration or base.get('at_day_end') else MORNING}",
            Duration=f"PT{duration * 8}H0M0S",
            DurationFormat=7,
        )

    for task in tasks:
        parts = task["wbs"].split(".")
        for level in range(1, len(parts)):
            code = ".".join(parts[:level])
            if code not in seen_groups:
                seen_groups.add(code)
                group_uid += 1
                index += 1
                node = ET.SubElement(collection, "Task")
                fields(
                    node,
                    UID=group_uid,
                    ID=index,
                    Name=plan.groups.get(code, "Grupo " + code),
                    WBS=code,
                    OutlineLevel=level,
                )
                # MSPDI fixes the order: dates, Summary, Critical, PercentComplete.
                summary = summaries.get(code)
                if summary:
                    fields(
                        node,
                        Start=f"{summary['start']}T{MORNING}",
                        Finish=f"{summary['finish']}T{EVENING}",
                        Duration=f"PT{summary['duration'] * 8}H0M0S",
                        DurationFormat=7,
                    )
                fields(node, Summary=1)
                if summary:
                    fields(
                        node,
                        Critical=int(summary["critical"]),
                        PercentComplete=round(summary["progress"]),
                    )
        index += 1
        t = ET.SubElement(collection, "Task")
        milestone = task["duration"] == 0
        at = EVENING if task.get("at_day_end") else MORNING
        fields(
            t,
            UID=task["id"],
            ID=index,
            Name=task["name"],
            Type=1,
            IsNull=0,
            WBS=task["wbs"],
            OutlineLevel=len(parts),
            Start=task["start"] + "T" + (at if milestone else MORNING),
            Finish=task["finish"] + "T" + (at if milestone else EVENING),
            Duration=f"PT{task['duration'] * 8}H0M0S",
            DurationFormat=7,
            Milestone=int(milestone),
            Critical=int(task["critical"]),
            PercentComplete=round(task["progress"]),
        )
        # MSPDI order: ConstraintType, CalendarUID, ConstraintDate.
        constraint = None
        if task.get("fixed_finish"):
            constraint = (3, task["fixed_finish"] + "T" + EVENING)
        elif task["earliest"]:
            constraint = (4, task["earliest"] + "T" + MORNING)
        if constraint:
            fields(t, ConstraintType=constraint[0])
        if task.get("calendar"):
            fields(t, CalendarUID=calendar_uid[task["calendar"]])
        if constraint:
            fields(t, ConstraintDate=constraint[1])
        for link in task["links"]:
            fields(
                ET.SubElement(t, "PredecessorLink"),
                PredecessorUID=link["predecessor"],
                Type={"FF": 0, "FS": 1, "SF": 2, "SS": 3}[link["relation"]],
                CrossProject=0,
                LinkLag=link["lag"] * 4800,
                LagFormat=7,
            )
        if task.get("baseline"):
            baseline(t, task["baseline"], task["baseline"]["duration"])
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)
