# CIVIL BIM Planner

Plataforma web que reúne las tablas de Revit, las cantidades verificadas y el cronograma de obra en una ficha por proyecto. Cada persona entra con su propia cuenta y solo ve sus proyectos.

- **Interfaz:** React y TypeScript (`web/`).
- **API y reglas de ingeniería:** FastAPI en Python (`planner_api/` y `bim_planner/`).
- **Datos:** PostgreSQL en Neon para la versión publicada; SQLite para trabajar en un equipo sin conexión.

## Cómo está publicada

```
GitHub (rama main)  →  Render (servicio web con Docker)  →  Neon (PostgreSQL)
```

1. El código vive en GitHub. Al fusionar cambios en `main`, Render vuelve a construir y desplegar el servicio si tiene activado el despliegue automático; si no, se despliega desde el panel de Render con **Manual Deploy**.
2. Render construye el `Dockerfile`: compila la interfaz con Node, instala Python y arranca FastAPI, que sirve la interfaz y la API desde la misma dirección.
3. FastAPI guarda en Neon las cuentas, sesiones, proyectos, archivos originales importados, cronogramas y reportes Excel. Al arrancar crea las tablas que falten (`planner_api/postgres.sql`); no hace falta ejecutar migraciones a mano.

### Variables de entorno en Render

| Variable | Obligatoria | Valor |
| --- | --- | --- |
| `DATABASE_URL` | Sí | Cadena de conexión **agrupada** (pooled) de Neon. Si falta, la app usaría SQLite dentro del contenedor y los datos se perderían en cada despliegue. |
| `CIVIL_BIM_ADMIN` | No | Tu nombre de usuario. Esa cuenta ve en **Proyectos** cuánto ocupa la base de datos compartida respecto del límite del plan. |
| `CIVIL_BIM_STORAGE_LIMIT_MB` | No | Límite de almacenamiento del plan de la base, en MB. Por defecto 512 (Neon Free). Cámbialo si amplías el plan. |
| `CIVIL_BIM_HOST` | No | Dominio público, solo si usas un dominio propio. Render ya informa `RENDER_EXTERNAL_HOSTNAME` automáticamente. |
| `CIVIL_BIM_DB_POOL` | No | Conexiones abiertas como máximo hacia la base. Por defecto 5. |

El `Dockerfile` ya configura Uvicorn para confiar en el proxy de Render (`--proxy-headers` y `FORWARDED_ALLOW_IPS`), de modo que cada visitante se identifica por su propia dirección.

No hace falta un disco persistente en Render: con `DATABASE_URL` definido, todo se guarda en Neon.

La app reutiliza hasta cinco conexiones con Neon en lugar de abrir una por consulta. Las que quedan sin uso se cierran a los cuatro minutos, para que Neon pueda suspenderse cuando nadie usa la página. Conviene que el servicio de Render y la base de Neon estén en la misma región.

### Límites del plan gratuito

- **Render Free** suspende el servicio tras unos 15 minutos sin visitas. La siguiente visita tarda alrededor de un minuto en responder mientras se reactiva. La memoria es de 512 MB, por eso la app limita a dos los cálculos de contraseña simultáneos.
- **Neon Free** ofrece 0,5 GB de almacenamiento compartido por todos los usuarios y suspende la base cuando no se usa; la primera consulta tras la pausa tarda un poco más. Los archivos importados (hasta 16 MiB cada uno) y los reportes Excel se guardan dentro de la base, así que son lo que más espacio ocupa.

### Espacio de almacenamiento

No hay cuota por usuario: nadie queda bloqueado mientras quede espacio en la base. Para que no se llene:

- **Proyectos** muestra cuánto ocupan los proyectos de cada cuenta, sus reportes y su papelera.
- Las papeleras de proyectos y de tablas permiten **Eliminar definitivamente** un elemento o **Vaciar papelera**. Hasta entonces, lo enviado a la papelera sigue ocupando espacio. Eliminar no se puede deshacer.
- Cada reporte del historial se puede eliminar; las tablas y cantidades no cambian.
- Cuando la base supera el 70 % de `CIVIL_BIM_STORAGE_LIMIT_MB`, el servidor escribe un aviso en el registro de Render («La base de datos usa…») al arrancar, al importar y al generar reportes. La cuenta de `CIVIL_BIM_ADMIN` ve además la barra en rojo.

Si el aviso aparece aunque las papeleras estén vacías, amplía el plan de Neon y ajusta `CIVIL_BIM_STORAGE_LIMIT_MB`, o traslada los archivos a un almacenamiento de objetos.

## Cuentas y seguridad

- Desde **Crear una cuenta** se elige un correo o nombre de usuario y una contraseña de 12 a 256 caracteres. La misma cuenta funciona desde cualquier equipo.
- Las contraseñas se guardan con scrypt y una sal aleatoria; la sesión dura 14 días en una cookie `HttpOnly` y `Secure`.
- Cada dirección admite 60 intentos de acceso o registro cada 10 minutos, y cada cuenta 20 intentos de inicio de sesión en el mismo periodo. Al superarlos, la página pide esperar diez minutos.
- En **Configuración** (abajo en el menú) se ve la cuenta y se cambia la contraseña. La nueva debe tener al menos 12 caracteres, una mayúscula, una minúscula, un número y un símbolo, y no puede incluir el nombre de usuario; la pantalla muestra cada requisito mientras se escribe. Al cambiarla se cierran las sesiones abiertas en otros equipos. Las cuentas que entran con Google, Apple o Microsoft no usan contraseña.
- Todavía no hay recuperación de contraseña olvidada.

Los proyectos creados antes de que existieran las cuentas quedaron sin propietario. Para asignarlos a una cuenta, ejecuta en el servidor con la misma `DATABASE_URL` (o `CIVIL_BIM_DB`):

```
python -m planner_api.claim_legacy TU_USUARIO
```

### Acceso con Google, Apple y Microsoft (desactivado)

El formulario de acceso ya no muestra estos botones. El código del servidor (`planner_api/social.py`) se conserva y solo se activa si se definen `OAUTH_SESSION_SECRET` y el par `<PROVEEDOR>_CLIENT_ID` / `<PROVEEDOR>_CLIENT_SECRET`. Para volver a ofrecerlo habría que restaurar los botones en `web/src/Account.tsx` y registrar la URL de retorno `https://<tu-dominio>/api/auth/social/<proveedor>/callback` en cada proveedor.

## Ejecución en tu equipo

En el equipo preparado, ejecuta **Iniciar CIVIL BIM Planner.cmd** y abre [la aplicación local](http://127.0.0.1:8765). Para detenerla, pulsa Ctrl+C en su terminal.

Para preparar otro equipo Windows con Python 3.13 y Node 24:

```powershell
py -3.13 -m venv .venv-web
.\.venv-web\Scripts\python.exe -m pip install -r requirements-web.txt
npm.cmd --prefix web ci
npm.cmd --prefix web run build
.\.venv-web\Scripts\python.exe -m uvicorn planner_api.main:app --host 127.0.0.1 --port 8765
```

La base de datos local se elige así:

1. Si existe la variable de entorno `DATABASE_URL`, se usa ese PostgreSQL.
2. Si no, y existe `CIVIL_BIM_DB`, se usa ese archivo SQLite.
3. Si no, se lee `DATABASE_URL` de `.env.local` (lo crea la CLI de Neon y está excluido de Git). Ten en cuenta que entonces trabajas sobre la **misma base que la página publicada**.
4. Si nada de lo anterior existe, se usa `.civil-bim/planner.sqlite3`. Para respaldarla, detén el servidor y copia esa carpeta.

Para desarrollar la interfaz con recarga automática, ejecuta `npm.cmd --prefix web run dev` con la API activa en el puerto 8765. La API documenta su contrato en [/docs](http://127.0.0.1:8765/docs).

## Primer proyecto

1. Crea la ficha desde **Resumen**. Puedes cambiar de proyecto en la barra superior.
2. En **Tablas de origen**, selecciona uno o varios archivos CSV, TXT, TSV, XLS o XLSX. Revisa la vista previa de cada uno, la hoja, el encabezado y la codificación. Cada importación admite 16 MiB y 600 000 celdas.
3. Guarda la tabla y asigna sus campos. **Volumen de origen** lee la medición exportada. **Inventario** permite contar elementos y seleccionar mediciones disponibles de masa, longitud, área y volumen. Para una tabla mixta, indica el campo que contiene la categoría. **Dimensiones** aplica las geometrías descritas más abajo. Declara las unidades antes de calcular.
4. Selecciona familia, tipo, material y resistencia cuando existan. En las opciones adicionales puedes conservar otros atributos, excluir registros por su fila, filtrar por campo y guardar una plantilla. El original se puede descargar incluso después de ajustar la importación.
5. Consulta **Cuantificación** para revisar subtotales, detalle e incidencias. Una celda vacía señala una magnitud sin medir. En **Reportes**, elige tablas y secciones y genera un libro Excel. Los informes archivados siguen disponibles tras modificar la tabla.
6. En **Programación** fija la fecha de inicio y escribe o pega las actividades (ver abajo).
7. Puedes vincular una actividad a una tabla, una categoría y un nivel desde su detalle. Ingresa el rendimiento en unidades por día: la duración es la cantidad válida dividida por el rendimiento, redondeada hacia arriba.

Si dos ventanas modifican el mismo proyecto, la segunda recibe un aviso para actualizar los datos antes de guardar. Guardar en un proyecto no bloquea a los demás.

### Programación en una sola pantalla

La tabla editable y el diagrama de Gantt comparten filas: desplazarse, seleccionar o plegar una fase afecta a ambos.

- **Cargar actividades:** escribe el nombre y la duración (días laborables; 0 crea un hito). Enter añade otra fila, Tab pasa de celda y las flechas cambian de fila. Puedes pegar varias filas copiadas de Excel (columnas *nombre* y *duración*; la fila de encabezados se omite).
- **Fases y orden:** selecciona actividades (Mayús+clic selecciona un rango) y pulsa *Agrupar en fase* (por ejemplo «Cimentación», «Estructura», «Instalaciones») o *Encadenar* para vincularlas en orden con fin a comienzo. Los códigos EDT se renumeran solos.
- **Inicio y Fin en la tabla:** pulsa la fecha y escribe otra. Cambiar el *Inicio* fija «No empezar antes del» esa fecha (como en Project); cambiar el *Fin* ajusta la duración en días laborables.
- **Predecesoras:** escribe el número de fila como en Project (`1`, `1.2`, `1.2CC`, `3FC+2`, varias separadas por `;`) o búscalas por nombre. Cada vínculo muestra su código y su significado: **FC** «Empieza cuando termine…», **CC** «Empieza cuando empiece…», **FF** «Termina cuando termine…», **CF** «Termina cuando empiece…».
- **Enlazar arrastrando:** arrastra una barra del Gantt hasta otra fila y esa actividad empezará cuando termine la primera.
- **Detalle de la actividad**, en bloques: *Resumen* (cuándo empieza y termina, cuánto dura y cuánto margen tiene), *¿Por qué estas fechas?* (qué dependencia o fecha manda y qué fines de semana o festivos la movieron), *¿De qué depende?* (cómo se relaciona con cada actividad y los días de espera), *Fechas obligatorias* (opcional) y, plegados, el calendario propio y la duración desde cantidades.
- **Cálculo en vivo:** cada cambio se recalcula en el servidor sin guardarlo. Los errores aparecen en la celda o la fila; una dependencia circular nombra las actividades que la forman. *Guardar cronograma* lo almacena; el borrador sin guardar se conserva en la pestaña.
- **Gantt:** barras, fases, hitos, dependencias, ruta crítica, fines de semana y festivos sombreados y fecha de seguimiento. Escalas de días, semanas, meses o *Todo el cronograma*.
- **Seguimiento:** *Fijar línea base* guarda las fechas actuales para compararlas: barra gris y atraso o adelanto en días laborables. El porcentaje completado ya no se edita en la pantalla; los valores guardados antes se conservan en los datos y en el XML.
- **Exportación:** XML de Microsoft Project (MSPDI) con fases, hitos, calendarios, restricciones, vínculos, desfases, avance y línea base. Exporta lo guardado.

### Reglas de programación

El motor (`planner_api/planning.py`) programa «lo antes posible» desde el inicio del proyecto, en días laborables enteros, con el modelo de tiempo de Project: el final de un día laborable y el comienzo del siguiente son el mismo instante de trabajo. Cada regla tiene casos concretos en `tests_web/test_scheduling_rules.py`.

| Regla | Comportamiento implementado |
| --- | --- |
| FC (FS) | La sucesora empieza el siguiente día laborable tras el fin de la predecesora. |
| CC (SS), FF, CF (SF) | Comienzo ≥ comienzo; fin ≥ fin; fin ≥ comienzo de la predecesora. |
| Desfases | En días laborables del calendario de la sucesora; negativos adelantan, sin empezar antes del inicio del proyecto. |
| Hitos (duración 0) | Tras un FC quedan en la fecha de fin de la predecesora (17:00); su sucesora empieza el día laborable siguiente. |
| Calendarios | Del proyecto o uno propio por actividad (días de trabajo y festivos, con o sin los del proyecto). |
| Fases | Del primer inicio al último fin de sus actividades; duración en días laborables del proyecto; avance ponderado por duración. |
| Holgura y ruta crítica | Holgura total contra el fin del proyecto; crítica si la holgura es 0 o menor. |
| Restricciones | «No comenzar antes del» y «Debe finalizar el». |

**Diferencias conocidas con Microsoft Project.** Los resultados no se compararon con Project de escritorio; estas diferencias están identificadas en el diseño:

- Si «Debe finalizar el» es incompatible con las predecesoras, aquí se rechaza con un error; Project lo acepta y muestra holgura negativa.
- Solo días laborables enteros: no hay horas, días transcurridos («ed») ni desfases en porcentaje.
- No se vinculan fases (tareas resumen) entre sí; los vínculos son entre actividades.
- Solo las dos restricciones anteriores; Project tiene ocho.
- El avance real no reprograma el trabajo restante ni registra fechas reales.
- Con calendarios distintos, el desfase se mide en el calendario de la sucesora. Es una decisión de diseño: no se verificó cómo lo hace Project.

## Métodos de cuantificación

**Volumen de origen:** requiere nivel y volumen; el área es opcional. Selecciona **El total de la fila** para mediciones ya agregadas, o **Un elemento** para multiplicar volumen y área por la cantidad. La misma base se aplica a ambas mediciones: verifica cómo están configuradas en Revit.

**Dimensiones:** todas las dimensiones y áreas de entrada son por elemento. El volumen calculado se multiplica por la cantidad:

| Categoría | Campos específicos | Volumen por elemento | Área reportada |
| --- | --- | --- | --- |
| Columnas | Ancho, profundidad, altura | Ancho × profundidad × altura | No calculada |
| Vigas | Ancho, altura, longitud | Ancho × altura × longitud | No calculada |
| Losas | Área, espesor | Área × espesor | Área en planta |
| Muros | Longitud, altura, espesor | Longitud × altura × espesor | Una cara bruta: longitud × altura |

La aproximación dimensional supone secciones rectangulares y espesor constante, sin descuentos por huecos, uniones o solapes. Para geometrías irregulares o cantidades netas usa los valores de Revit. No se calcula acero, encofrado, desperdicio ni costos.

Cada elemento se asigna íntegramente al nivel indicado. Las etiquetas de nivel solo se limpian de espacios externos: `N1` y `Nivel 1` son niveles distintos. Los niveles se ordenan por nombre, no por elevación. Las áreas no se suman entre categorías, porque pueden representar superficies diferentes; un área vacía significa **no cuantificada**, no cero.

### Validación y trazabilidad

- Se rechazan filas con nivel vacío, valores numéricos inválidos, negativos o no finitos, y cantidades no enteras o menores que 1. Un volumen cero sí es válido.
- Los IDs duplicados se rechazan en todas sus apariciones, también entre tablas de la misma categoría del proyecto.
- Se detectan etiquetas habituales de total y subtotal en los campos de nivel, tipo e ID. Revisa también la vista previa: no todos los formatos pueden identificarse automáticamente.
- Las filas inválidas no se convierten en cero: se muestran y exportan con el motivo y la fila de origen, y el reporte se marca como parcial.
- Los números de Excel conservan su valor; los textos se interpretan con el separador decimal elegido. Las unidades anexas, como `1,25 m³`, deben coincidir con la unidad seleccionada.
- Para XLSX con fórmulas, guarda el libro recalculado en Excel antes de importar; se leen los valores almacenados.

## Pruebas

`examples/` contiene cuatro tablas sintéticas (separador `;`, decimal `,`) con **10 elementos** y **36,400 m³** en dos niveles. No son datos de un proyecto real.

```powershell
.\.venv-web\Scripts\python.exe -m pip install -r requirements-web-test.txt
.\.venv-web\Scripts\python.exe -m unittest discover -s tests -v
.\.venv-web\Scripts\python.exe -m unittest discover -s tests_web -v
Set-Location web
npm.cmd run build
.\node_modules\.bin\playwright.cmd test
```

- `tests/`: importación, formatos regionales, unidades, geometrías, exclusiones, duplicados y exportación.
- `tests_web/`: API, cuentas y aislamiento entre ellas, límites de acceso, papelera y eliminación definitiva, espacio usado, reportes, cronograma y XML. Usan bases SQLite sintéticas. `test_scheduling_rules.py` reúne los casos de las reglas de programación.
- `web/e2e/`: recorridos en navegador con Playwright.

El XML se validó con el XSD del SDK de Microsoft Project y con MPXJ 16.10.0. Queda pendiente abrirlo directamente en Microsoft Project de escritorio.

## Organización del código

- `planner_api/main.py`: rutas de la API y servicio de la interfaz compilada.
- `planner_api/auth.py`: cuentas, sesiones y límites de acceso.
- `planner_api/db.py` y `postgres.sql`: conexión a PostgreSQL o SQLite y esquema.
- `planner_api/tables.py`, `models.py`: importación, validación de datos y cálculo.
- `planner_api/planning.py`, `project_xml.py`: ruta crítica, fases, línea base y exportación a Project.
- `web/src/Schedule.tsx`, `outline.ts`: pantalla de programación y estructura de fases.
- `planner_api/social.py`: acceso con proveedores externos (desactivado en la interfaz).
- `bim_planner/`: motor de cuantificación compartido.
- `web/src/`: pantallas de la interfaz (`Overview`, `Tables`, `Schedule`, `Account`).
- `Dockerfile`: imagen que despliega Render.

## Edición Streamlit anterior

`app.py`, `bim_planner/ui.py` y `requirements.txt` corresponden a la primera versión local en Streamlit, sin cuentas ni guardado permanente. Se conserva como referencia y no forma parte de la página publicada. Para abrirla:

```powershell
.\.venv\Scripts\python.exe -m streamlit run app.py
```
