import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from planner_api.main import app
from planner_api.models import Plan, QuantityLink
from planner_api.project_import import plan_from_xml

PLAN = {
    "start": "2026-11-02",
    "weekdays": [0, 1, 2, 3, 4],
    "holidays": ["2026-11-16"],
    "groups": {"1": "Cimentación", "2": "Estructura"},
    "calendars": {"Curado": {"weekdays": [0, 1, 2, 3, 4, 5, 6], "holidays": []}},
    "tasks": [
        {"id": 1, "name": "Excavación", "wbs": "1.1", "duration": 5},
        {
            "id": 2,
            "name": "Zapatas",
            "wbs": "1.2",
            "duration": 3,
            "links": [{"predecessor": 1, "relation": "FS", "lag": 2}],
            "earliest": "2026-11-10",
        },
        {
            "id": 3,
            "name": "Curado",
            "wbs": "2.1",
            "duration": 7,
            "calendar": "Curado",
            "links": [{"predecessor": 2, "relation": "SS", "lag": 1}],
        },
        {
            "id": 4,
            "name": "Entrega",
            "wbs": "2.2",
            "duration": 0,
            "links": [{"predecessor": 3, "relation": "FS", "lag": 0}],
        },
    ],
}

PROJECT_FILE = b"""<?xml version="1.0" encoding="UTF-8"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>Desde Project</Name>
  <StartDate>2027-01-04T08:00:00</StartDate>
  <MinutesPerDay>480</MinutesPerDay>
  <CalendarUID>1</CalendarUID>
  <Calendars>
    <Calendar><UID>1</UID><Name>Estandar</Name><IsBaseCalendar>1</IsBaseCalendar>
      <BaseCalendarUID>-1</BaseCalendarUID>
      <WeekDays>
        <WeekDay><DayType>1</DayType><DayWorking>0</DayWorking></WeekDay>
        <WeekDay><DayType>2</DayType><DayWorking>1</DayWorking></WeekDay>
        <WeekDay><DayType>3</DayType><DayWorking>1</DayWorking></WeekDay>
        <WeekDay><DayType>4</DayType><DayWorking>1</DayWorking></WeekDay>
        <WeekDay><DayType>5</DayType><DayWorking>1</DayWorking></WeekDay>
        <WeekDay><DayType>6</DayType><DayWorking>1</DayWorking></WeekDay>
        <WeekDay><DayType>7</DayType><DayWorking>1</DayWorking></WeekDay>
      </WeekDays>
      <Exceptions><Exception><TimePeriod><FromDate>2027-01-11T00:00:00</FromDate>
        <ToDate>2027-01-12T23:59:00</ToDate></TimePeriod><DayWorking>0</DayWorking></Exception></Exceptions>
    </Calendar>
  </Calendars>
  <Tasks>
    <Task><UID>0</UID><Name>Proyecto</Name><OutlineLevel>0</OutlineLevel><Summary>1</Summary></Task>
    <Task><UID>10</UID><Name>Obra gris</Name><OutlineLevel>1</OutlineLevel><Summary>1</Summary></Task>
    <Task><UID>11</UID><Name>Muros</Name><OutlineLevel>2</OutlineLevel>
      <Duration>PT24H0M0S</Duration><PercentComplete>40</PercentComplete></Task>
    <Task><UID>12</UID><Name>Pa\xc3\xb1ete</Name><OutlineLevel>2</OutlineLevel>
      <Duration>PT16H0M0S</Duration><ConstraintType>7</ConstraintType>
      <ConstraintDate>2027-02-01T17:00:00</ConstraintDate>
      <PredecessorLink><PredecessorUID>11</PredecessorUID><Type>1</Type>
        <LinkLag>14400</LinkLag><LagFormat>8</LagFormat></PredecessorLink>
      <PredecessorLink><PredecessorUID>10</PredecessorUID><Type>1</Type></PredecessorLink>
    </Task>
    <Task><UID>13</UID><Name>Fin</Name><OutlineLevel>1</OutlineLevel>
      <Duration>PT0H0M0S</Duration><Milestone>1</Milestone>
      <PredecessorLink><PredecessorUID>12</PredecessorUID><Type>1</Type>
        <LinkLag>-4800</LinkLag><LagFormat>7</LagFormat></PredecessorLink>
      <PredecessorLink><PredecessorUID>99</PredecessorUID><Type>1</Type></PredecessorLink>
    </Task>
  </Tasks>
  <Resources><Resource><UID>1</UID><Name>Cuadrilla</Name></Resource></Resources>
</Project>
"""


class ProjectImport(unittest.TestCase):
    def setUp(self):
        self.tmp = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(
            patch.dict(
                os.environ, CIVIL_BIM_DB=str(Path(self.tmp) / "synthetic.sqlite3")
            )
        )
        self.client = self.enterContext(TestClient(app))
        self.client.post(
            "/api/auth/register",
            json={"username": "importa", "password": "frase de prueba larga"},
        )
        pid = self.client.post("/api/projects", json={"name": "Obra"}).json()["id"]
        self.base = f"/api/projects/{pid}"

    def put(self, plan):
        revision = self.client.get(self.base).json()["project"]["revision"]
        response = self.client.put(
            self.base + "/plan", headers={"If-Match": str(revision)}, json=plan
        )
        self.assertEqual(response.status_code, 200, response.text)

    def load(self, data, name="Cronograma.xml"):
        return self.client.post(
            self.base + "/plan/import",
            files={"file": (name, data, "application/xml")},
        )

    def test_round_trip_keeps_the_schedule(self):
        self.put(PLAN)
        before = {r["id"]: r for r in self.client.get(self.base).json()["schedule"]}
        xml = self.client.get(self.base + "/schedule.xml").content
        response = self.load(xml)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        plan = body["plan"]
        self.assertEqual(plan["start"], "2026-11-02")
        self.assertEqual(sorted(plan["holidays"]), ["2026-11-16"])
        self.assertEqual(plan["groups"], {"1": "Cimentación", "2": "Estructura"})
        tasks = {t["id"]: t for t in plan["tasks"]}
        self.assertEqual(
            [(t["wbs"], t["name"], t["duration"]) for t in plan["tasks"]],
            [
                ("1.1", "Excavación", 5),
                ("1.2", "Zapatas", 3),
                ("2.1", "Curado", 7),
                ("2.2", "Entrega", 0),
            ],
        )
        self.assertEqual(
            tasks[2]["links"], [{"predecessor": 1, "relation": "FS", "lag": 2}]
        )
        self.assertEqual(tasks[3]["links"][0]["relation"], "SS")
        self.assertEqual(tasks[2]["earliest"], "2026-11-10")
        self.assertEqual(tasks[3]["calendar"], "Curado")
        self.assertEqual(set(plan["calendars"]["Curado"]["weekdays"]), set(range(7)))
        # Same dates as before the round trip.
        after = {r["id"]: r for r in body["schedule"]}
        for i in before:
            self.assertEqual(
                (after[i]["start"], after[i]["finish"]),
                (before[i]["start"], before[i]["finish"]),
                before[i]["name"],
            )
        # Nothing is saved until the user saves it.
        self.assertEqual(len(self.client.get(self.base).json()["plan"]["tasks"]), 4)

    def test_project_file_with_what_the_app_does_not_handle(self):
        response = self.load(PROJECT_FILE)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        plan = body["plan"]
        self.assertEqual(plan["start"], "2027-01-04")
        self.assertEqual(sorted(plan["weekdays"]), [0, 1, 2, 3, 4, 5])
        self.assertEqual(sorted(plan["holidays"]), ["2027-01-11", "2027-01-12"])
        self.assertEqual(plan["groups"], {"1": "Obra gris"})
        tasks = {t["name"]: t for t in plan["tasks"]}
        self.assertEqual(tasks["Muros"]["wbs"], "1.1")
        self.assertEqual(tasks["Muros"]["duration"], 3)
        self.assertEqual(tasks["Muros"]["progress"], 40)
        self.assertEqual(tasks["Pañete"]["duration"], 2)
        # 1440 minutes of elapsed lag: one calendar day.
        self.assertEqual(
            tasks["Pañete"]["links"], [{"predecessor": 11, "relation": "FS", "lag": 1}]
        )
        self.assertIsNone(tasks["Pañete"]["fixed_finish"])
        self.assertEqual(tasks["Fin"]["wbs"], "2")
        self.assertEqual(tasks["Fin"]["duration"], 0)
        self.assertEqual(tasks["Fin"]["links"][0]["lag"], -1)
        notes = " ".join(body["notes"])
        self.assertIn("tareas resumen", notes)
        self.assertIn("no están en el archivo", notes)
        self.assertIn("restricciones", notes)
        self.assertIn("recursos", notes)

    def test_quantity_link_survives_a_round_trip(self):
        self.put(PLAN)
        xml = self.client.get(self.base + "/schedule.xml").content
        current = Plan.model_validate(PLAN)
        link = {"table": 5, "unit": "m³", "rate": 2.5}
        current.tasks[0].quantity = QuantityLink(**link)
        # A renamed task is another activity: its link is not carried over.
        current.tasks[1].quantity = QuantityLink(**link)
        current.tasks[1].name = "Otra cosa"
        plan, _ = plan_from_xml(xml, current, {1: 5, 2: 3})
        tasks = {t.id: t for t in plan.tasks}
        self.assertEqual(tasks[1].quantity.table, 5)
        self.assertEqual(tasks[1].quantity.rate, 2.5)
        self.assertIsNone(tasks[2].quantity)
        # Days changed in Project: the file's duration wins, and it says so.
        plan, notes = plan_from_xml(xml, current, {1: 9})
        self.assertIsNone(plan.tasks[0].quantity)
        self.assertIn("cambiaron de duración", " ".join(notes))

    def test_textual_booleans_and_elapsed_durations(self):
        xml = b"""<Project><StartDate>2027-01-04T08:00:00</StartDate>
<Calendars><Calendar><UID>1</UID><Name>Base</Name><IsBaseCalendar>true</IsBaseCalendar>
<Exceptions><Exception><TimePeriod><FromDate>2027-01-06T00:00:00</FromDate>
<ToDate>2027-01-06T23:59:00</ToDate></TimePeriod><Type>9</Type><DayWorking>false</DayWorking></Exception>
<Exception><TimePeriod><FromDate>2027-01-01T00:00:00</FromDate>
<ToDate>2030-12-31T23:59:00</ToDate></TimePeriod><Type>6</Type><DayWorking>0</DayWorking></Exception>
</Exceptions></Calendar></Calendars>
<Tasks>
<Task><UID>1</UID><Name>Fase</Name><OutlineLevel>1</OutlineLevel><Summary>true</Summary></Task>
<Task><UID>2</UID><Name>Curado</Name><OutlineLevel>2</OutlineLevel>
 <Duration>PT48H0M0S</Duration><DurationFormat>8</DurationFormat></Task>
</Tasks></Project>"""
        plan, notes = plan_from_xml(xml, Plan())
        self.assertEqual(plan.groups, {"1": "Fase"})
        self.assertEqual(plan.tasks[0].wbs, "1.1")
        self.assertEqual(plan.tasks[0].duration, 2)  # two elapsed days
        self.assertEqual(sorted(map(str, plan.holidays)), ["2027-01-06"])
        text = " ".join(notes)
        self.assertIn("días corridos", text)
        self.assertIn("repetitivas", text)

    def test_only_conflicting_finish_dates_are_dropped(self):
        xml = b"""<Project><StartDate>2027-01-04T08:00:00</StartDate><Tasks>
<Task><UID>1</UID><Name>A</Name><OutlineLevel>1</OutlineLevel><Duration>PT40H0M0S</Duration>
 <ConstraintType>3</ConstraintType><ConstraintDate>2027-01-08T17:00:00</ConstraintDate></Task>
<Task><UID>2</UID><Name>B</Name><OutlineLevel>1</OutlineLevel><Duration>PT16H0M0S</Duration>
 <ConstraintType>3</ConstraintType><ConstraintDate>2027-01-05T17:00:00</ConstraintDate>
 <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type></PredecessorLink></Task>
<Task><UID>3</UID><Name>Manual</Name><OutlineLevel>1</OutlineLevel><Duration>PT8H0M0S</Duration>
 <Manual>1</Manual><Start>2027-02-01T08:00:00</Start></Task>
<Task><UID>4</UID><Name>C</Name><OutlineLevel>1</OutlineLevel><Duration>PT8H0M0S</Duration>
 <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type><CrossProject>1</CrossProject></PredecessorLink></Task>
</Tasks></Project>"""
        body = self.load(xml).json()
        tasks = {t["name"]: t for t in body["plan"]["tasks"]}
        self.assertEqual(tasks["A"]["fixed_finish"], "2027-01-08")
        self.assertIsNone(tasks["B"]["fixed_finish"])
        self.assertEqual(tasks["Manual"]["earliest"], "2027-02-01")
        self.assertEqual(tasks["C"]["links"], [])
        notes = " ".join(body["notes"])
        self.assertIn("B:", notes)
        self.assertNotIn("A:", notes)
        self.assertIn("otros proyectos", notes)
        self.assertIn("manualmente", notes)

    def test_inactive_tasks_and_short_milestones(self):
        xml = b"""<Project><StartDate>2027-01-04T08:00:00</StartDate><Tasks>
<Task><UID>1</UID><Name>Viejo</Name><OutlineLevel>1</OutlineLevel><Summary>1</Summary><Active>0</Active></Task>
<Task><UID>2</UID><Name>Hijo</Name><OutlineLevel>2</OutlineLevel><Duration>PT8H0M0S</Duration></Task>
<Task><UID>3</UID><Name>Aprobacion</Name><OutlineLevel>1</OutlineLevel>
 <Duration>PT2H0M0S</Duration><Milestone>1</Milestone><ConstraintType>1</ConstraintType>
 <PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type></PredecessorLink></Task>
</Tasks></Project>"""
        plan, notes = plan_from_xml(xml, Plan())
        self.assertEqual([(t.name, t.wbs, t.duration) for t in plan.tasks], [("Aprobacion", "1", 1)])
        self.assertEqual(plan.tasks[0].links, [])
        self.assertEqual(plan.groups, {})
        text = " ".join(notes)
        self.assertIn("inactivas", text)
        self.assertIn("hitos con duración", text)
        self.assertIn("Lo más tarde posible", text)

    def test_rejects_files_that_are_not_project_xml(self):
        for data, words in (
            (b"no es xml", "no es un XML"),
            (b"<root><a/></root>", "Microsoft Project"),
            (
                b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">'
                b'<!ENTITY b "&a;&a;&a;&a;">]><Project><Tasks/>&b;</Project>',
                "no es un XML",
            ),
            (
                b"<Project><Tasks><Task><UID>0</UID><OutlineLevel>0</OutlineLevel>"
                b"</Task></Tasks></Project>",
                "no tiene actividades",
            ),
            (b'<?xml version="1.0" encoding="nada"?><Project/>', "no es un XML"),
        ):
            response = self.load(data)
            self.assertEqual(response.status_code, 422, data)
            self.assertIn(words, response.json()["detail"], data)

    def test_requires_access_to_the_project(self):
        with TestClient(app) as other:
            other.post(
                "/api/auth/register",
                json={"username": "ajena", "password": "frase de prueba larga"},
            )
            response = other.post(
                self.base + "/plan/import",
                files={"file": ("x.xml", PROJECT_FILE, "application/xml")},
            )
            self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
