# CIVIL BIM Planner

La plataforma web local reúne las tablas de Revit, las cantidades verificadas y el cronograma en una ficha por proyecto. React y TypeScript gestionan la interacción. FastAPI aplica las reglas de ingeniería en Python y SQLite conserva los resultados y los archivos originales. La versión Streamlit previa a la migración tiene el respaldo Git `e764ab0`.

## Abrir la plataforma

La plataforma solicita una cuenta personal. Desde **Crear una cuenta**, elige un nombre de usuario y una contraseña de al menos 12 caracteres. Al volver desde cualquier equipo, usa la misma cuenta en la misma instalación.

### Publicación en internet

#### Acceso con Google, Apple y Microsoft

Cada proveedor usa una aplicación web registrada por el administrador. En Render configura `OAUTH_SESSION_SECRET` con un secreto aleatorio estable de al menos 32 bytes. Para cada proveedor habilitado, añade el par de variables indicado a continuación y registra su URL de retorno exacta.

| Proveedor | Variables en Render | URL de retorno |
| --- | --- | --- |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `https://civil-bim-planner.onrender.com/api/auth/social/google/callback` |
| Apple | `APPLE_CLIENT_ID`, `APPLE_CLIENT_SECRET` | `https://civil-bim-planner.onrender.com/api/auth/social/apple/callback` |
| Microsoft | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | `https://civil-bim-planner.onrender.com/api/auth/social/microsoft/callback` |

Google requiere un cliente OAuth de tipo aplicación web. Apple usa el Services ID y un secreto JWT firmado por el equipo de Apple Developer que debe renovarse antes de vencer. Para Microsoft, registra una aplicación web que admita cuentas personales. Para usar exclusivamente las cuentas de una organización, configura también `MICROSOFT_TENANT_ID` con su UUID. Guarda los cambios en Render y vuelve a desplegar.

El primer acceso con cada identidad crea un espacio propio. Para regresar a los mismos proyectos, usa siempre el mismo método y cuenta. Registrar un correo como usuario y autenticarlo con un proveedor son identidades independientes.

Para Render Free con Neon, selecciona Docker y configura `DATABASE_URL` en las variables del servicio con la conexión agrupada de Neon. La app crea sus tablas en PostgreSQL al arrancar y guarda allí los proyectos y los archivos. Para desarrollo, la CLI de Neon guarda la misma variable en `.env.local`, excluido de Git. La base SQLite anterior sigue disponible indicando su ruta en `CIVIL_BIM_DB` y dejando sin definir la variable de entorno `DATABASE_URL`.

El `Dockerfile` compila la interfaz y ejecuta FastAPI. En Render, crea un servicio web desde el repositorio con el runtime Docker y un disco persistente montado en `/var/data`. La base SQLite guarda allí las cuentas, proyectos y archivos. Usa una sola instancia y comparte la URL HTTPS del servicio. Render suministra el nombre del host automáticamente. En otro proveedor, configura `CIVIL_BIM_HOST` con el dominio público exacto, habilita HTTPS y monta un volumen persistente en la misma ruta.

Los proyectos creados antes de incorporar cuentas se conservan sin propietario. Para recuperarlos en tu instalación, crea tu cuenta y ejecuta desde la consola del servidor `python -m planner_api.claim_legacy TU_USUARIO` sobre la base correspondiente. El comando asigna los proyectos antiguos pendientes a la cuenta indicada.

### Ejecución en tu equipo

En el equipo preparado, ejecuta **Iniciar CIVIL BIM Planner.cmd** y abre [la aplicación local](http://127.0.0.1:8765). El mismo proceso sirve la interfaz compilada y la API. Para detenerlo, pulsa Ctrl+C en su terminal.

Para instalar la edición web en otro equipo Windows con Python 3.13 y Node 24:

```powershell
py -3.13 -m venv .venv-web
.\.venv-web\Scripts\python.exe -m pip install -r requirements-web.txt
npm.cmd --prefix web ci
npm.cmd --prefix web run build
.\.venv-web\Scripts\python.exe -m uvicorn planner_api.main:app --host 127.0.0.1 --port 8765
```

El archivo `.civil-bim/planner.sqlite3` contiene proyectos, archivos originales, opciones de lectura, plantillas, mediciones, cronogramas y versiones de reportes. Para respaldar tus datos, detén el servidor y copia esa carpeta. Git conserva el código por separado. La variable `CIVIL_BIM_DB` permite usar otra base. Las pruebas utilizan bases sintéticas independientes.

## Primer proyecto

1. Crea la ficha desde **Resumen**. Puedes cambiar de proyecto en la barra superior.
2. En **Tablas de origen**, selecciona uno o varios archivos. Revisa la vista previa de cada uno, la hoja, el encabezado y la codificación. Cada importación admite 16 MiB y 600 000 celdas. XLS utiliza xlrd y XLSX utiliza openpyxl.
3. Guarda la tabla y asigna sus campos. **Volumen de origen** lee la medición exportada. **Inventario** permite contar elementos y seleccionar mediciones disponibles de masa, longitud, área y volumen. Para una tabla mixta, indica el campo que contiene la categoría. **Dimensiones** aplica las geometrías descritas más abajo. Declara las unidades antes de calcular.
4. Selecciona familia, tipo, material y resistencia cuando existan. En las opciones adicionales puedes conservar otros atributos, excluir registros por su fila, filtrar por campo y guardar una plantilla. El original se puede descargar incluso después de ajustar la importación.
5. Consulta **Cuantificación** para revisar subtotales, detalle e incidencias. Una celda vacía señala una magnitud sin medir. En **Reportes**, genera un libro Excel que conserve esa revisión. Los informes archivados siguen disponibles tras modificar la tabla.
6. En **Programación**, define el inicio del proyecto, los días laborables y los festivos. Un código EDT como `1.2.1` crea una actividad dentro de una fase y un capítulo. Asigna sus nombres y configura duración, restricciones de fecha, predecesoras, desfases y porcentaje ejecutado. Se admiten FS, SS, FF y SF.
7. Puedes vincular una actividad a una tabla, una categoría y un nivel. Ingresa el rendimiento en unidades por día. La duración se obtiene redondeando hacia arriba el cociente entre la cantidad válida y el rendimiento. Una modificación incompatible con fechas fijas o mediciones vinculadas se rechaza y conserva la revisión anterior.

El cronograma trabaja en días laborables enteros. El intercambio XML representa cada jornada con ocho horas de trabajo. La holgura se calcula recorriendo la red de precedencias hacia atrás. El avance planificado se distribuye linealmente entre las fechas de cada actividad y el indicador global pondera el avance real por duración.

## Registro de implementación y verificación

| Fase | Comportamiento disponible | Comprobación |
| --- | --- | --- |
| 1–3 | Respaldo, interfaz web adaptable, modo oscuro y proyectos persistentes | Compilación TypeScript, navegador Edge, recarga y reapertura de la base |
| 4–5 | Importación flexible, plantillas, clasificación, exclusiones, unidades y mediciones derivadas | Pruebas de texto regional, libros XLS/XLSX, categorías mixtas, inventario y geometrías |
| 6 | Indicadores, agrupación, trazabilidad e historial de Excel | Reapertura del XLSX y cotejo de sus hojas, fuentes y totales |
| 7–8 | EDT, Gantt editable, CPM, calendarios, vínculos a cantidades y XML MSPDI | Pruebas de ciclos, relaciones, fechas, holguras y recálculo por rendimiento |
| 9 | Regresión e integración con datos sintéticos | Los cuatro ejemplos conservan 10 elementos y 36,400 m³. En Edge, una tabla de 15 m³ produce una actividad de 3 días a 5 m³/día |
| 10 | Paquete frontend compilable y arranque local desde FastAPI | Servidor de bucle local. Un despliegue compartido requerirá configurar acceso, permisos y copias de seguridad |

La validación de intercambio utilizó el XSD del SDK de Microsoft Project y una lectura independiente con MPXJ 16.10.0. Se recuperaron cuatro actividades bajo tres grupos EDT, sus fechas, un festivo y las cuatro clases de relación con sus desfases. Queda pendiente la apertura directa en Microsoft Project de escritorio, cuya automatización COM devolvió `0x80080005`. Los reportes PDF y las pruebas de carga con archivos reales de obra quedan para una fase posterior. [SDK oficial](https://www.microsoft.com/en-us/download/details.aspx?id=30435).

Para reproducir las pruebas en Windows con Microsoft Edge instalado:

```powershell
.\.venv-web\Scripts\python.exe -m pip install -r requirements-web-test.txt
.\.venv-web\Scripts\python.exe -m unittest discover -s tests -v
.\.venv-web\Scripts\python.exe -m unittest discover -s tests_web -v
Set-Location web
npm.cmd run build
.\node_modules\.bin\playwright.cmd test
```

La API local expone su contrato en [la documentación interactiva](http://127.0.0.1:8765/docs). Para desarrollar la interfaz con recarga automática, ejecuta `npm.cmd --prefix web run dev` con la API activa en el puerto 8765.

## Edición original de Streamlit

Aplicación local en Streamlit para cuantificar tablas de Revit por categoría y nivel. El módulo de programación de obra se conserva como punto de entrada para el futuro cronograma Gantt.

## Ejecutar en Windows

Desde la carpeta del proyecto, en PowerShell:

```powershell
.\.venv\Scripts\python.exe -m streamlit run app.py
```

Las dependencias instaladas se documentan en `requirements.txt`. Para preparar otro entorno con Python 3.13:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## Cuantificación

1. Abre **Cuantificación BIM** y carga una tabla en cada categoría que necesites: columnas, vigas, losas o muros. Se admite una tabla por categoría; consolida tablas adicionales antes de cargarlas.
2. Usa CSV, TXT o TSV exportados desde Revit, o un XLSX con una hoja tabular. No se leen archivos RVT, IFC ni XLS antiguos. Para textos se detectan UTF-8, UTF-16 con BOM y CP1252; puedes seleccionar explícitamente codificación y separador. Para XLSX selecciona la hoja.
3. Si hay un título antes de los campos, ajusta la **fila de encabezados**, numerada desde 1. Cada columna debe tener un nombre único y no vacío. Se conservan los números de fila para revisar incidencias. En texto con saltos dentro de campos entrecomillados, el número corresponde al registro, no a la línea física.
4. Revisa la vista previa. Excluye filas de títulos, unidades, subtotales o totales. Si la tabla mezcla categorías, selecciona el campo de categoría y los valores que deben incluirse. No cargues los mismos elementos en más de una categoría.
5. Asigna el **nivel**, familia/tipo, ID y cantidad según estén disponibles. Los nombres habituales se sugieren, pero deben revisarse. Sin campo de cantidad, una fila equivale a un elemento. Las tablas agrupadas requieren su campo de cantidad si representan varios elementos.
6. Selecciona método, separador decimal y unidades de cada magnitud. Los números reales de Excel conservan su valor sin depender del separador decimal; los textos se interpretan según la configuración. Las unidades anexas, como `1,25 m³`, deben coincidir con la unidad seleccionada. No se infieren unidades del encabezado.
7. Revisa el resumen y las incidencias. Puedes filtrar los niveles en pantalla. Descarga el Excel: siempre incluye **todos los niveles**, con los filtros de origen y exclusiones aplicados.

### Métodos y supuestos

**Volumen de Revit:** requiere nivel y volumen. El área es opcional. Selecciona **El total de la fila** para mediciones ya agregadas, o **Un elemento** para multiplicar volumen y área por la cantidad. La misma base se aplica a ambas mediciones: verifica cómo están configuradas en Revit. No se multiplica un total de fila de nuevo.

**Dimensiones:** todas las dimensiones y áreas de entrada son por elemento. El volumen calculado se multiplica por la cantidad:

| Categoría | Campos específicos | Volumen por elemento | Área reportada |
| --- | --- | --- | --- |
| Columnas | Ancho, profundidad, altura | Ancho × profundidad × altura | No calculada |
| Vigas | Ancho, altura, longitud | Ancho × altura × longitud | No calculada |
| Losas | Área, espesor | Área × espesor | Área en planta |
| Muros | Longitud, altura, espesor | Longitud × altura × espesor | Una cara bruta: longitud × altura |

La aproximación dimensional supone secciones rectangulares y espesor constante, sin descuentos por huecos, uniones o solapes. Para geometrías irregulares o cantidades netas usa los valores de Revit. No se calcula acero, encofrado, desperdicio ni costos. Los resultados son cantidades según la tabla y la configuración del usuario.

Cada elemento se asigna íntegramente al nivel indicado: no se divide automáticamente entre pisos. Las etiquetas de nivel solo se limpian de espacios externos; `N1` y `Nivel 1` siguen siendo niveles distintos. Los niveles se ordenan por nombre, no por elevación.

Las salidas se expresan en m³, m² y unidades. Los cálculos conservan precisión; el reporte muestra tres decimales. Las áreas no se suman globalmente entre categorías, porque pueden representar superficies diferentes. Un área vacía significa **no cuantificada**, no cero.

### Validación y trazabilidad

- Se rechazan filas con nivel vacío, valores numéricos inválidos, negativos, no finitos o cantidades no enteras/menores que 1. Un volumen cero sí es válido.
- Los IDs duplicados dentro de la categoría cargada se rechazan en todas sus apariciones; excluye la fila duplicada o corrige la fuente. Los IDs son opcionales; sin ellos no se puede detectar repetición de elementos de forma fiable.
- Se detectan etiquetas habituales de total/subtotal en los campos asignados de nivel, tipo e ID. Revisa también la vista previa: no todos los formatos de subtotales pueden identificarse automáticamente.
- Las filas inválidas no se convierten en cero. Se muestran y exportan con el motivo y la fila de origen. Si hay filas rechazadas, el reporte se identifica en pantalla como parcial.
- El Excel contiene resumen por categoría/nivel, detalle, incidencias, configuración, fuentes importadas y criterios. Se genera en memoria y se descarga localmente. Los valores fuente que parecen fórmulas se guardan como texto.
- Para XLSX con fórmulas, guarda el libro recalculado en Excel antes de importar; se leen sus valores almacenados.
- Las cargas y configuraciones viven en la sesión de Streamlit; no hay base de datos ni guardado permanente de proyectos. Cambiar un archivo o su estructura reinicia los controles asociados. No hay publicación ni envío externo de tablas.

## Ejemplos y pruebas

`examples/` contiene cuatro tablas sintéticas pequeñas con separador `;`, decimal `,`, longitudes en m, áreas en m² y volúmenes en m³. Cada fila tiene mediciones totales en modo directo. Las dimensiones también permiten reproducirlas: volumen total **36,400 m³**, **10 elementos**, repartidos en dos niveles. No son datos de un proyecto real.

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

Se verifican importación UTF-16/CP1252/XLSX, formatos regionales, unidades, las cuatro geometrías, cantidades agrupadas, exclusiones, duplicados, errores, exportación y navegación/configuración de Streamlit. Las pruebas de interfaz usan `AppTest` con cargas de archivos sintéticos, cambios de controles y exportación real en memoria.

## Organización

- `app.py`: punto de entrada y navegación.
- `bim_planner/importer.py`: lectura y validación de tablas.
- `bim_planner/quantities.py`: configuración, validación y cálculos, sin interfaz.
- `bim_planner/exporter.py`: generación del reporte XLSX.
- `bim_planner/ui.py`: controles y resultados de cuantificación.
- `bim_planner/scheduling.py`: módulo conservado para programación de obra.
- `tests/`: pruebas automatizadas.

No se ha implementado todavía el Gantt, la persistencia de proyectos ni una conexión directa a la API de Revit.
