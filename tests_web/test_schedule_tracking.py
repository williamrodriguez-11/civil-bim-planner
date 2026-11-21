from datetime import date
from unittest import TestCase
from xml.etree import ElementTree as ET

from planner_api.models import Plan
from planner_api.planning import schedule
from planner_api.project_xml import project_xml


class TrackingTests(TestCase):
    def test_cutoff_counts_workdays_without_changing_dates_or_reported_progress(self):
        plan = Plan.model_validate(
            {
                "start": "2026-11-02",
                "holidays": ["2026-11-04"],
                "status_date": "2026-11-03",
                "tasks": [
                    {
                        "id": 1,
                        "wbs": "1",
                        "name": "Excavación",
                        "duration": 4,
                        "progress": 25,
                    },
                    {
                        "id": 2,
                        "wbs": "2",
                        "name": "Cimentación",
                        "duration": 2,
                        "links": [{"predecessor": 1, "lag": 1}],
                    },
                ],
            }
        )
        first = schedule(plan, {}, today=date(2030, 1, 1))
        self.assertEqual([t["planned"] for t in first], [50, 0])
        self.assertEqual(first[0]["finish"], "2026-11-06")
        self.assertEqual(first[1]["start"], "2026-11-10")
        for cutoff, expected in [
            (date(2026, 11, 1), [0, 0]),
            (date(2026, 11, 8), [100, 0]),
            (date(2026, 11, 11), [100, 100]),
        ]:
            plan.status_date = cutoff
            rows = schedule(plan, {})
            self.assertEqual([t["planned"] for t in rows], expected)
            for before, after in zip(first, rows):
                for field in ("start", "finish", "progress", "slack", "critical"):
                    self.assertEqual(before[field], after[field])
        persisted = Plan.model_validate_json(plan.model_dump_json())
        root = ET.fromstring(project_xml("Obra", persisted, rows))
        ns = {"p": "http://schemas.microsoft.com/project/2007"}
        self.assertEqual(
            root.findtext("p:StatusDate", namespaces=ns), "2026-11-11T17:00:00"
        )
        self.assertEqual(
            root.findtext("p:Tasks/p:Task/p:PercentComplete", namespaces=ns), "25"
        )

    def test_old_plans_keep_today_as_default(self):
        plan = Plan.model_validate(
            {
                "start": "2026-11-02",
                "tasks": [
                    {"id": 1, "wbs": "1", "name": "Actividad", "duration": 4},
                ],
            }
        )
        self.assertIsNone(plan.status_date)
        self.assertEqual(schedule(plan, {}, today=date(2026, 11, 2))[0]["planned"], 25)
