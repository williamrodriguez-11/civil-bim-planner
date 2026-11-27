"""Scheduling rules checked against concrete cases.

Each expected date follows Microsoft Project's rules for an «as soon as
possible» schedule in whole working days (Friday 17:00 and Monday 08:00 are
the same working instant). These are the behaviours implemented here; they
were not compared with a desktop copy of Project. Known differences are
listed in README, «Reglas de programación».

Calendar: 2026-11-02 is a Monday; Monday to Friday are working days.
"""

import unittest
from datetime import date

from planner_api.models import Plan
from planner_api.planning import ScheduleError, phases, schedule

MONDAY = "2026-11-02"


def plan(*tasks, **extra):
    return Plan.model_validate({"start": MONDAY, "tasks": list(tasks), **extra})


def task(id, wbs, duration, *links, **extra):
    return {
        "id": id,
        "wbs": wbs,
        "name": extra.pop("name", f"Actividad {id}"),
        "duration": duration,
        "links": [
            {"predecessor": p, "relation": r, "lag": lag} for p, r, lag in links
        ],
        **extra,
    }


def run(p):
    return {row["id"]: row for row in schedule(p, {}, today=date(2026, 11, 2))}


class Relations(unittest.TestCase):
    def test_finish_to_start_crosses_the_weekend(self):
        rows = run(plan(task(1, "1", 5), task(2, "2", 2, (1, "FS", 0))))
        self.assertEqual((rows[1]["start"], rows[1]["finish"]), (MONDAY, "2026-11-06"))
        self.assertEqual((rows[2]["start"], rows[2]["finish"]), ("2026-11-09", "2026-11-10"))
        self.assertEqual(rows[2]["driver"]["predecessor"], 1)
        self.assertEqual(
            [(d["date"], d["kind"]) for d in rows[2]["shifted"]],
            [("2026-11-07", "no laborable"), ("2026-11-08", "no laborable")],
        )

    def test_holiday_moves_the_successor_and_is_explained(self):
        rows = run(
            plan(task(1, "1", 5), task(2, "2", 2, (1, "FS", 0)), holidays=["2026-11-09"])
        )
        self.assertEqual(rows[2]["start"], "2026-11-10")
        self.assertIn({"date": "2026-11-09", "kind": "festivo"}, rows[2]["shifted"])

    def test_lag_and_lead_in_working_days(self):
        lag = run(plan(task(1, "1", 5), task(2, "2", 1, (1, "FS", 2))))
        self.assertEqual(lag[2]["start"], "2026-11-11")  # Mon and Tue waited
        lead = run(plan(task(1, "1", 5), task(2, "2", 1, (1, "FS", -2))))
        self.assertEqual(lead[2]["start"], "2026-11-05")  # starts Thursday

    def test_start_to_start_finish_to_finish_and_start_to_finish(self):
        ss = run(plan(task(1, "1", 5), task(2, "2", 2, (1, "SS", 1))))
        self.assertEqual(ss[2]["start"], "2026-11-03")
        ff = run(plan(task(1, "1", 5), task(2, "2", 2, (1, "FF", 0))))
        self.assertEqual((ff[2]["start"], ff[2]["finish"]), ("2026-11-05", "2026-11-06"))
        # B must not finish before A starts (Wednesday 08:00 = Tuesday 17:00).
        sf = run(
            plan(
                task(1, "1", 2, earliest="2026-11-04"),
                task(2, "2", 2, (1, "SF", 0)),
            )
        )
        self.assertEqual((sf[2]["start"], sf[2]["finish"]), (MONDAY, "2026-11-03"))
        late = run(
            plan(
                task(1, "1", 2, earliest="2026-11-11"),
                task(2, "2", 2, (1, "SF", 0)),
            )
        )
        self.assertEqual((late[2]["start"], late[2]["finish"]), ("2026-11-09", "2026-11-10"))

    def test_negative_lag_never_starts_before_the_project(self):
        rows = run(plan(task(1, "1", 1), task(2, "2", 1, (1, "SS", -3))))
        self.assertEqual(rows[2]["start"], MONDAY)


class Milestones(unittest.TestCase):
    def test_milestone_after_a_task_shows_the_finish_date(self):
        rows = run(
            plan(
                task(1, "1", 5),
                task(2, "2", 0, (1, "FS", 0), name="Entrega"),
                task(3, "3", 1, (2, "FS", 0)),
            )
        )
        self.assertTrue(rows[2]["milestone"])
        self.assertEqual((rows[2]["start"], rows[2]["finish"]), ("2026-11-06",) * 2)
        self.assertEqual(rows[3]["start"], "2026-11-09")
        self.assertTrue(rows[2]["critical"])

    def test_milestone_without_predecessors_sits_at_the_project_start(self):
        rows = run(plan(task(1, "1", 0), task(2, "2", 3)))
        self.assertEqual(rows[1]["start"], MONDAY)
        self.assertEqual(rows[1]["planned"], 100.0)

    def test_milestone_driven_by_a_start_shows_that_start(self):
        rows = run(plan(task(1, "1", 3, earliest="2026-11-04"), task(2, "2", 0, (1, "SS", 0))))
        self.assertEqual(rows[2]["start"], "2026-11-04")


class Calendars(unittest.TestCase):
    def test_activity_calendar_works_on_weekends(self):
        rows = run(
            plan(
                task(1, "1", 5),
                task(2, "2", 3, (1, "FS", 0), calendar="Curado continuo"),
                calendars={"Curado continuo": {"weekdays": list(range(7))}},
            )
        )
        self.assertEqual((rows[2]["start"], rows[2]["finish"]), ("2026-11-07", "2026-11-09"))

    def test_project_holidays_apply_to_activity_calendars_by_default(self):
        cal = {"weekdays": list(range(7))}
        holidays = ["2026-11-07"]
        rows = run(
            plan(
                task(1, "1", 5),
                task(2, "2", 1, (1, "FS", 0), calendar="7 días"),
                calendars={"7 días": cal},
                holidays=holidays,
            )
        )
        self.assertEqual(rows[2]["start"], "2026-11-08")
        rows = run(
            plan(
                task(1, "1", 5),
                task(2, "2", 1, (1, "FS", 0), calendar="7 días"),
                calendars={"7 días": {**cal, "project_holidays": False}},
                holidays=holidays,
            )
        )
        self.assertEqual(rows[2]["start"], "2026-11-07")

    def test_holidays_inside_an_activity_lengthen_it(self):
        rows = run(plan(task(1, "1", 5), holidays=["2026-11-04"]))
        self.assertEqual(rows[1]["finish"], "2026-11-09")
        self.assertEqual(
            [d["date"] for d in rows[1]["spanned"]],
            ["2026-11-04", "2026-11-07", "2026-11-08"],
        )


class CriticalPath(unittest.TestCase):
    def test_slack_and_critical_path(self):
        rows = run(
            plan(
                task(1, "1", 5),
                task(2, "2", 2),
                task(3, "3", 2, (1, "FS", 0)),
            )
        )
        self.assertEqual([rows[i]["slack"] for i in (1, 2, 3)], [0, 5, 0])
        self.assertEqual([rows[i]["critical"] for i in (1, 2, 3)], [True, False, True])
        self.assertEqual(rows[2]["late_finish"], "2026-11-10")

    def test_longer_duration_moves_every_successor_and_the_phase(self):
        base = plan(
            task(1, "1.1", 3),
            task(2, "1.2", 2, (1, "FS", 0)),
            task(3, "2.1", 1, (2, "FS", 0)),
            groups={"1": "Cimentación", "2": "Estructura"},
        )
        before = run(base)
        longer = base.model_copy(deep=True)
        longer.tasks[0].duration = 5
        after = run(longer)
        self.assertEqual(before[3]["start"], "2026-11-09")
        self.assertEqual(after[2]["start"], "2026-11-09")
        self.assertEqual(after[3]["start"], "2026-11-11")
        summary = {p["code"]: p for p in phases(longer, list(after.values()))}
        self.assertEqual(summary["1"]["name"], "Cimentación")
        self.assertEqual((summary["1"]["start"], summary["1"]["finish"]), (MONDAY, "2026-11-10"))
        self.assertEqual(summary["1"]["duration"], 7)

    def test_baseline_variance_in_working_days(self):
        p = plan(
            task(1, "1", 5),
            task(2, "2", 2, (1, "FS", 0)),
            baseline={
                "1": {"start": MONDAY, "finish": "2026-11-04", "duration": 3},
                "2": {"start": "2026-11-05", "finish": "2026-11-06", "duration": 2},
            },
        )
        rows = run(p)
        self.assertEqual(rows[2]["baseline"]["start_variance"], 2)
        self.assertEqual(rows[2]["baseline"]["finish_variance"], 2)
        self.assertEqual(phases(p, list(rows.values())), [])


class EdgeCases(unittest.TestCase):
    def test_mixed_calendars_keep_slack_non_negative(self):
        # A Saturday task (7-day calendar) before a Monday–Friday task.
        rows = run(
            plan(
                task(1, "1", 1, earliest="2026-11-07", calendar="7 días"),
                task(2, "2", 2, (1, "FS", 0)),
                calendars={"7 días": {"weekdays": list(range(7))}},
            )
        )
        self.assertEqual(rows[1]["start"], "2026-11-07")
        self.assertEqual(rows[2]["start"], "2026-11-09")
        # It may slip to Sunday (its calendar works it) without delaying
        # Monday's task: one day of slack, never a negative one.
        self.assertEqual(rows[1]["slack"], 1)
        self.assertEqual(rows[1]["late_finish"], "2026-11-08")
        self.assertTrue(rows[2]["critical"])

    def test_milestone_honours_an_earliest_date_on_a_tie(self):
        rows = run(
            plan(
                task(1, "1", 5),
                task(2, "2", 0, (1, "FS", 0), earliest="2026-11-09"),
            )
        )
        self.assertEqual(rows[2]["start"], "2026-11-09")
        self.assertFalse(rows[2]["at_day_end"])

    def test_baseline_before_a_later_project_start(self):
        p = Plan.model_validate(
            {
                "start": "2026-11-09",
                "tasks": [task(1, "1", 2)],
                "baseline": {"1": {"start": MONDAY, "finish": "2026-11-03", "duration": 2}},
            }
        )
        row = schedule(p, {}, today=date(2026, 11, 2))[0]
        self.assertEqual(row["baseline"]["start_variance"], 5)
        self.assertEqual(row["baseline"]["finish_variance"], 5)

    def test_unchanged_milestone_has_no_variance(self):
        p = plan(
            task(1, "1", 5),
            task(2, "2", 0, (1, "FS", 0)),
            baseline={
                "2": {
                    "start": "2026-11-06",
                    "finish": "2026-11-06",
                    "duration": 0,
                    "at_day_end": True,
                }
            },
        )
        row = run(p)[2]
        self.assertEqual(
            (row["baseline"]["start_variance"], row["baseline"]["finish_variance"]), (0, 0)
        )


class MoreEdgeCases(unittest.TestCase):
    def test_milestone_never_precedes_a_weekend_predecessor(self):
        rows = run(
            plan(
                task(1, "1", 1, earliest="2026-11-07", calendar="7 días"),
                task(2, "2", 0, (1, "FS", 0)),
                calendars={"7 días": {"weekdays": list(range(7))}},
            )
        )
        self.assertEqual(rows[2]["start"], "2026-11-09")

    def test_far_tracking_date_needs_no_calendar(self):
        p = Plan.model_validate(
            {"start": "1900-01-01", "tasks": [task(1, "1", 1)], "status_date": "2026-11-02"}
        )
        self.assertEqual(schedule(p, {})[0]["planned"], 100.0)

    def test_fixed_milestone_reports_its_own_late_dates(self):
        rows = run(plan(task(1, "1", 0, fixed_finish="2026-11-06")))
        self.assertEqual(rows[1]["start"], "2026-11-06")
        self.assertEqual((rows[1]["late_start"], rows[1]["late_finish"]), ("2026-11-06",) * 2)


class Export(unittest.TestCase):
    def test_xml_keeps_milestones_calendars_baseline_and_phases(self):
        from xml.etree import ElementTree as ET

        from planner_api.project_xml import project_xml

        p = plan(
            task(1, "1.1", 5, name="Excavación"),
            task(2, "1.2", 3, (1, "FS", 1), calendar="Curado", name="Curado"),
            task(3, "2.1", 0, (2, "FS", 0), name="Entrega"),
            groups={"1": "Cimentación", "2": "Cierre"},
            calendars={"Curado": {"weekdays": list(range(7))}},
            baseline={"1": {"start": MONDAY, "finish": "2026-11-06", "duration": 5}},
        )
        rows = schedule(p, {}, today=date(2026, 11, 2))
        root = ET.fromstring(project_xml("Obra", p, rows, phases(p, rows)))
        ns = {"p": "http://schemas.microsoft.com/project/2007"}
        names = [c.findtext("p:Name", namespaces=ns) for c in root.iterfind(".//p:Calendar", ns)]
        self.assertEqual(names, ["Calendario de obra", "Curado"])
        by_name = {t.findtext("p:Name", namespaces=ns): t for t in root.iterfind(".//p:Task", ns)}
        phase = by_name["Cimentación"]
        self.assertEqual(phase.findtext("p:Summary", namespaces=ns), "1")
        self.assertEqual(phase.findtext("p:Start", namespaces=ns), f"{MONDAY}T08:00:00")
        # Child order required by the MSPDI schema.
        tags = [c.tag.split("}")[1] for c in phase]
        self.assertLess(tags.index("Finish"), tags.index("Summary"))
        entrega = by_name["Entrega"]
        self.assertEqual(entrega.findtext("p:Milestone", namespaces=ns), "1")
        self.assertEqual(entrega.findtext("p:Duration", namespaces=ns), "PT0H0M0S")
        self.assertTrue(entrega.findtext("p:Start", namespaces=ns).endswith("T17:00:00"))
        self.assertEqual(by_name["Curado"].findtext("p:CalendarUID", namespaces=ns), "2")
        base = by_name["Excavación"].find("p:Baseline", ns)
        self.assertEqual(base.findtext("p:Finish", namespaces=ns), "2026-11-06T17:00:00")


class Errors(unittest.TestCase):
    def assertError(self, p, field, task_id, text):
        with self.assertRaises(ScheduleError) as caught:
            run(p)
        self.assertEqual((caught.exception.field, caught.exception.task), (field, task_id))
        self.assertIn(text, str(caught.exception))
        return caught.exception

    def test_cycle_names_every_activity(self):
        with self.assertRaises(ScheduleError) as caught:
            run(
                plan(
                    task(1, "1", 1, (3, "FS", 0), name="Excavación"),
                    task(2, "2", 1, (1, "FS", 0), name="Cimentación"),
                    task(3, "3", 1, (2, "FS", 0), name="Estructura"),
                )
            )
        error = caught.exception
        self.assertEqual(error.field, "links")
        self.assertEqual(sorted(error.cycle), [1, 2, 3])
        for name in ["Excavación", "Cimentación", "Estructura"]:
            self.assertIn(name, str(error))

    def test_errors_point_to_the_activity_and_field(self):
        self.assertError(plan(task(1, "1", 1, (1, "FS", 0))), "links", 1, "sí misma")
        self.assertError(plan(task(1, "1", 1, (9, "FS", 0))), "links", 1, "no existen")
        self.assertError(plan(task(1, "1", 1), task(2, "1", 1)), "wbs", 2, "mismo código")
        self.assertError(
            plan(task(1, "1", 3, fixed_finish="2026-11-07")),
            "fixed_finish",
            1,
            "laborable",
        )
        self.assertError(
            plan(task(1, "1", 1, calendar="Nocturno")), "calendar", 1, "no existe"
        )


if __name__ == "__main__":
    unittest.main()
