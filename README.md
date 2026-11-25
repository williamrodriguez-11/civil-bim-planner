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
| `CIVIL_BIM_HOST` | No | Dominio público, solo si usas un dominio propio. Render ya informa `RENDER_EXTERNAL_HOSTNAME` automáticamente. |

El `Dockerfile` ya configura Uvicorn para confiar en el proxy de Render (`--proxy-headers` y `FORWARDED_ALLOW_IPS`), de modo que cada visitante se identifica por su propia dirección.

No hace falta un disco persistente en Render: con `DATABASE_URL` definido, todo se guarda en Neon.

### Límites del plan gratuito

- **Render Free** suspende el servicio tras unos 15 minutos sin visitas. La siguiente visita tarda alrededor de un minuto en responder mientras se reactiva. La memoria es de 512 MB, por eso la app limita a dos los cálculos de contraseña simultáneos.
- **Neon Free** ofrece 0,5 GB de almacenamiento y suspende la base cuando no se usa; la primera consulta tras la pausa tarda un poco más. Los archivos importados (hasta 16 MiB cada uno) y los reportes Excel se guardan dentro de la base, así que son lo que más espacio ocupa. Los elementos enviados a la papelera siguen ocupando espacio.

## Cuentas y seguridad

- Desde **Crear una cuenta** se elige un correo o nombre de usuario y una contraseña de 12 a 256 caracteres. La misma cuenta funciona desde cualquier equipo.
- Las contraseñas se guardan con scrypt y una sal aleatoria; la sesión dura 14 días en una cookie `HttpOnly` y `Secure`.
- Cada dirección admite 60 intentos de acceso o registro cada 10 minutos, y cada cuenta 20 intentos de inicio de sesión en el mismo periodo. Al superarlos, la página pide esperar diez minutos.
- Por ahora no hay cambio ni recuperación de contraseña desde la interfaz.

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
6. En **Programación**, define el inicio del proyecto, los días laborables y los festivos. Un código EDT como `1.2.1` crea una actividad dentro de una fase y un capítulo. Asigna sus nombres y configura duración, restricciones de fecha, predecesoras, desfases y porcentaje ejecutado.
7. Puedes vincular una actividad a una tabla, una categoría y un nivel. Ingresa el rendimiento en unidades por día. La duración se obtiene redondeando hacia arriba el cociente entre la cantidad válida y el rendimiento. Una modificación incompatible con fechas fijas o mediciones vinculadas se rechaza y conserva la revisión anterior.

Si dos ventanas modifican el mismo proyecto, la segunda recibe un aviso para actualizar los datos antes de guardar. Guardar en un proyecto no bloquea a los demás.

### Seguimiento del cronograma

El cronograma trabaja en días laborables enteros. La holgura se calcula recorriendo la red de precedencias hacia atrás. El avance planificado se distribuye linealmente entre las fechas de cada actividad y el indicador global pondera el avance real por duración.

La tabla de actividades y el Gantt comparten filas. Selecciona el nombre o la barra para editar. **Más columnas** muestra el porcentaje previsto, la holgura y la cantidad BIM. El buscador acepta nombres o códigos EDT; el filtro de ruta crítica y la escala permiten revisar la red.

- **% completado** es el porcentaje registrado por el usuario, entre 0 y 100. No se calcula a partir del tiempo transcurrido ni de la cantidad BIM.
- **% previsto** es la proporción de días laborables transcurridos al cierre de la fecha de seguimiento, respecto de la duración vigente. No representa una línea base. En **Calendario y seguimiento** puede fijarse una fecha de corte; vacía utiliza la fecha actual del servidor.
- **No comenzar antes del** establece el comienzo más temprano permitido. **Debe finalizar el** fija una fecha obligatoria de fin, que debe ser laborable y compatible con la duración y las dependencias.
- Las relaciones se muestran en español: **FC** (FS), **CC** (SS), **FF** (FF) y **CF** (SF). Un desfase positivo espera días laborables; uno negativo adelanta el vínculo.

El cronograma se exporta como XML de Microsoft Project (MSPDI), con ocho horas por jornada y la fecha de seguimiento cuando está fijada. Todavía no incluye recursos, nivelación, líneas base ni reprogramación del trabajo restante.

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
- `tests_web/`: API, cuentas y aislamiento entre ellas, límites de acceso, papelera, reportes, cronograma y XML. Usan bases SQLite sintéticas.
- `web/e2e/`: recorridos en navegador con Playwright.

El XML se validó con el XSD del SDK de Microsoft Project y con MPXJ 16.10.0. Queda pendiente abrirlo directamente en Microsoft Project de escritorio.

## Organización del código

- `planner_api/main.py`: rutas de la API y servicio de la interfaz compilada.
- `planner_api/auth.py`: cuentas, sesiones y límites de acceso.
- `planner_api/db.py` y `postgres.sql`: conexión a PostgreSQL o SQLite y esquema.
- `planner_api/tables.py`, `models.py`: importación, validación de datos y cálculo.
- `planner_api/planning.py`, `project_xml.py`: ruta crítica y exportación a Project.
- `planner_api/social.py`: acceso con proveedores externos (desactivado en la interfaz).
- `bim_planner/`: motor de cuantificación compartido.
- `web/src/`: pantallas de la interfaz (`Overview`, `Tables`, `Schedule`, `Account`).
- `Dockerfile`: imagen que despliega Render.

## Edición Streamlit anterior

`app.py`, `bim_planner/ui.py` y `requirements.txt` corresponden a la primera versión local en Streamlit, sin cuentas ni guardado permanente. Se conserva como referencia y no forma parte de la página publicada. Para abrirla:

```powershell
.\.venv\Scripts\python.exe -m streamlit run app.py
```
