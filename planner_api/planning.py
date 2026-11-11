"""CPM en días laborables. Los extremos de los intervalos son [inicio, fin)."""

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


def schedule(plan: Plan, sources, today=None):
    if not plan.weekdays.issubset(range(7)):
        raise ValueError("El calendario acepta días entre lunes y domingo.")
    if not 1900 <= plan.start.year <= 2199:
        raise ValueError("La fecha inicial debe estar entre 1900 y 2199.")
    tasks = {t.id: t for t in plan.tasks}
    if len(tasks) != len(plan.tasks) or len({t.wbs for t in plan.tasks}) != len(tasks):
        raise ValueError("Cada actividad debe tener un ID y un código EDT únicos.")
    codes = {t.wbs for t in plan.tasks}
    for code in codes:
        if any(
            ".".join(code.split(".")[:i]) in codes
            for i in range(1, len(code.split(".")))
        ):
            raise ValueError(
                "Usa códigos EDT de hoja para las actividades. Los códigos superiores se reservan para fases y capítulos."
            )
    days = []
    next_day = plan.start

    def extend(target=None, count=0):
        nonlocal next_day
        while len(days) < count or (
            target is not None and (not days or days[-1] < target)
        ):
            if (next_day - plan.start).days > 36525:
                raise ValueError(
                    "El cronograma supera el horizonte admitido de 100 años."
                )
            if next_day.weekday() in plan.weekdays and next_day not in plan.holidays:
                days.append(next_day)
            next_day += timedelta(days=1)

    edges, durations, quantities = {}, {}, {}
    for t in tasks.values():
        duration = t.duration
        if t.quantity:
            q = t.quantity
            rows = [
                r
                for r in sources.get(q.table, [])
                if (not q.level or r["Nivel"] == q.level)
                and (not q.category or r["Categoría"] == q.category)
            ]
            values = [r.get(MAGNITUDES[q.unit]) for r in rows]
            if q.unit == "m²" and len({r["Categoría"] for r in rows}) > 1:
                raise ValueError(
                    f"{t.name}: selecciona una categoría para sumar superficies comparables."
                )
            if not values or None in values:
                raise ValueError(
                    f"{t.name}: la cantidad vinculada está incompleta o sin filas válidas."
                )
            total = math.fsum(values)
            if total <= 0:
                raise ValueError(
                    f"{t.name}: la cantidad debe ser positiva para calcular la duración."
                )
            ratio = total / q.rate
            if not math.isfinite(ratio) or ratio > 36525:
                raise ValueError(
                    f"{t.name}: revisa el rendimiento y la duración resultante."
                )
            duration = max(1, math.ceil(ratio))
            quantities[t.id] = total
        durations[t.id] = duration
        edges[t.id] = [link.predecessor for link in t.links]
        if set(edges[t.id]) - tasks.keys():
            raise ValueError(f"{t.name}: hay predecesoras que no existen.")
        if len(set(edges[t.id])) != len(edges[t.id]):
            raise ValueError(f"{t.name}: predecesora repetida.")
    try:
        order = list(TopologicalSorter(edges).static_order())
    except CycleError as exc:
        raise ValueError("Las dependencias forman un ciclo.") from exc

    starts, constraints = {}, []
    for i in order:
        task = tasks[i]
        earliest = 0
        if task.earliest:
            extend(target=task.earliest)
            earliest = bisect_left(days, task.earliest)
        for link in task.links:
            p = link.predecessor
            offset = link.lag
            if link.relation[0] == "F":
                offset += durations[p]
            if link.relation[1] == "F":
                offset -= durations[i]
            earliest = max(earliest, starts[p] + offset)
            constraints.append((p, i, offset))
        if task.fixed_finish:
            extend(target=task.fixed_finish)
            end = bisect_left(days, task.fixed_finish)
            if days[end] != task.fixed_finish:
                raise ValueError(
                    f"{task.name}: la fecha de finalización debe ser laborable."
                )
            fixed_start = end + 1 - durations[i]
            if fixed_start < earliest:
                raise ValueError(
                    f"{task.name}: la duración, el inicio o las predecesoras impiden finalizar en esa fecha."
                )
            earliest = fixed_start
        starts[i] = earliest
    finish = max((starts[i] + durations[i] for i in order), default=0)
    extend(count=finish)
    latest = {
        i: starts[i] if tasks[i].fixed_finish else finish - durations[i] for i in order
    }
    for p, i, offset in reversed(constraints):
        latest[p] = min(latest[p], latest[i] - offset)
    elapsed = bisect_left(days, (today or date.today()) + timedelta(days=1))
    output = []
    for t in sorted(plan.tasks, key=lambda t: tuple(map(int, t.wbs.split(".")))):
        i = t.id
        span = durations[i]
        output.append(
            {
                **t.model_dump(mode="json"),
                "duration": span,
                "amount": quantities.get(i),
                "start": days[starts[i]].isoformat(),
                "finish": days[starts[i] + span - 1].isoformat(),
                "slack": latest[i] - starts[i],
                "critical": latest[i] == starts[i],
                "planned": round(
                    100 * max(0, min(span, elapsed - starts[i])) / span, 1
                ),
            }
        )
    return output
