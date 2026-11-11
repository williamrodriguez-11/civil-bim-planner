"""Exportación MSPDI: días laborables de 8 horas y dependencias en décimas de minuto."""

from xml.etree import ElementTree as ET


def project_xml(name, plan, tasks):
    root = ET.Element("Project", xmlns="http://schemas.microsoft.com/project/2007")

    def fields(parent, **values):
        for key, val in values.items():
            ET.SubElement(parent, key).text = str(val)

    fields(
        root,
        SaveVersion=12,
        Name=name,
        ScheduleFromStart=1,
        StartDate=f"{plan.start}T08:00:00",
        CurrencyCode="COP",
        CalendarUID=1,
        DefaultStartTime="08:00:00",
        DefaultFinishTime="17:00:00",
        MinutesPerDay=480,
        MinutesPerWeek=480 * len(plan.weekdays),
        DurationFormat=7,
    )
    calendar = ET.SubElement(ET.SubElement(root, "Calendars"), "Calendar")
    fields(
        calendar, UID=1, Name="Calendario de obra", IsBaseCalendar=1, BaseCalendarUID=-1
    )
    weekdays = ET.SubElement(calendar, "WeekDays")
    for i in range(1, 8):
        work = (i + 5) % 7 in plan.weekdays
        day = ET.SubElement(weekdays, "WeekDay")
        fields(day, DayType=i, DayWorking=int(work))
        if work:
            times = ET.SubElement(day, "WorkingTimes")
            for a, b in [("08:00:00", "12:00:00"), ("13:00:00", "17:00:00")]:
                fields(ET.SubElement(times, "WorkingTime"), FromTime=a, ToTime=b)
    if plan.holidays:
        exceptions = ET.SubElement(calendar, "Exceptions")
        for h in sorted(plan.holidays):
            e = ET.SubElement(exceptions, "Exception")
            fields(e, EnteredByOccurrences=0)
            fields(
                ET.SubElement(e, "TimePeriod"),
                FromDate=f"{h}T00:00:00",
                ToDate=f"{h}T23:59:00",
            )
            fields(e, Occurrences=1, Name="Día no laborable", Type=1, DayWorking=0)
    collection = ET.SubElement(root, "Tasks")
    group_uid = max((task["id"] for task in tasks), default=0)
    seen_groups = set()
    index = 0
    for task in tasks:
        parts = task["wbs"].split(".")
        for level in range(1, len(parts)):
            code = ".".join(parts[:level])
            if code not in seen_groups:
                seen_groups.add(code)
                group_uid += 1
                index += 1
                fields(
                    ET.SubElement(collection, "Task"),
                    UID=group_uid,
                    ID=index,
                    Name=plan.groups.get(code, "Grupo " + code),
                    WBS=code,
                    OutlineLevel=level,
                    Summary=1,
                )
        index += 1
        t = ET.SubElement(collection, "Task")
        fields(
            t,
            UID=task["id"],
            ID=index,
            Name=task["name"],
            Type=1,
            IsNull=0,
            WBS=task["wbs"],
            OutlineLevel=len(parts),
            Start=task["start"] + "T08:00:00",
            Finish=task["finish"] + "T17:00:00",
            Duration=f"PT{task['duration'] * 8}H0M0S",
            DurationFormat=7,
            Critical=int(task["critical"]),
            PercentComplete=round(task["progress"]),
        )
        if task.get("fixed_finish"):
            fields(
                t, ConstraintType=3, ConstraintDate=task["fixed_finish"] + "T17:00:00"
            )
        elif task["earliest"]:
            fields(t, ConstraintType=4, ConstraintDate=task["earliest"] + "T08:00:00")
        for link in task["links"]:
            fields(
                ET.SubElement(t, "PredecessorLink"),
                PredecessorUID=link["predecessor"],
                Type={"FF": 0, "FS": 1, "SF": 2, "SS": 3}[link["relation"]],
                CrossProject=0,
                LinkLag=link["lag"] * 4800,
                LagFormat=7,
            )
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)
