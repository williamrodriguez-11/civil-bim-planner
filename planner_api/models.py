from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Name = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)
]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Project(Input):
    name: Name
    description: str = Field("", max_length=4000)
    kind: Name = "Edificación"
    location: str = Field("", max_length=200)
    status: Literal["En estudio", "En ejecución", "Finalizado"] = "En estudio"


class Options(Input):
    header_row: int = Field(1, ge=1)
    sheet: str | int = 0
    delimiter: Literal["auto", ";", ",", "\t"] = "auto"
    encoding: Literal[
        "auto", "utf-8-sig", "utf-16", "utf-16-le", "utf-16-be", "cp1252"
    ] = "auto"
    trim: bool = False


class ArchiveIssue(Input):
    index: int = Field(ge=0)


class ReportOptions(Input):
    sections: list[
        Literal[
            "Proyecto",
            "Resumen por nivel",
            "Detalle",
            "Incidencias",
            "Configuración",
            "Fuentes",
            "Criterios",
        ]
    ] = Field(
        default_factory=lambda: [
            "Proyecto",
            "Resumen por nivel",
            "Detalle",
            "Incidencias",
            "Configuración",
            "Fuentes",
            "Criterios",
        ],
        min_length=1,
    )
    tables: list[int] | None = Field(None, min_length=1)


class Mapping(Input):
    category: Name
    fields: dict[str, str]
    units: dict[str, str]
    decimal: Literal[",", "."]
    mode: Literal["direct", "dimensions", "inventory"]
    direct_basis: Literal["row_total", "per_element"]
    excluded_rows: list[int] = []
    filter_column: str | None = None
    filter_values: list[str] = []
    material: str = ""
    strength: str = ""
    family: str = ""
    attributes: list[str] = []
    category_field: str = ""
    # The user confirmed that a separate category column may repeat the level.
    category_confirmed: bool = False


class Link(Input):
    predecessor: int = Field(gt=0)
    relation: Literal["FS", "SS", "FF", "SF"] = "FS"
    lag: int = Field(0, ge=-3650, le=3650)


class QuantityLink(Input):
    table: int
    level: str = ""
    category: str = ""
    unit: Literal["m³", "m²", "ud", "kg", "m"]
    rate: float = Field(gt=0)


class Task(Input):
    id: int = Field(gt=0)
    name: Name
    wbs: str = Field(pattern=r"^[1-9]\d*(\.[1-9]\d*)*$", max_length=80)
    # Working days; 0 makes the activity a milestone.
    duration: int = Field(1, ge=0, le=3650)
    earliest: date | None = None
    fixed_finish: date | None = None
    progress: float = Field(0, ge=0, le=100)
    links: list[Link] = []
    quantity: QuantityLink | None = None
    # Name of one of the plan's calendars; empty uses the project calendar.
    calendar: str = Field("", max_length=160)


class WorkCalendar(Input):
    weekdays: set[int] = Field(min_length=1)
    holidays: set[date] = set()
    # Also skip the project's holidays.
    project_holidays: bool = True


class BaselineTask(Input):
    start: date
    finish: date
    duration: int = Field(ge=0)
    # A milestone captured at the end of its day (17:00).
    at_day_end: bool = False


class Plan(Input):
    start: date = Field(default_factory=date.today)
    status_date: date | None = None
    weekdays: set[int] = Field(default_factory=lambda: set(range(5)), min_length=1)
    holidays: set[date] = set()
    tasks: list[Task] = Field(default_factory=list, max_length=2000)
    groups: dict[str, Name] = {}
    calendars: dict[Name, WorkCalendar] = {}
    # Saved copy of the planned dates, keyed by task id.
    baseline: dict[int, BaselineTask] = {}
    baseline_saved: date | None = None
