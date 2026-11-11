FROM node:24-bookworm-slim AS frontend
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.13-slim
WORKDIR /app
COPY requirements*.txt ./
RUN pip install --no-cache-dir -r requirements-web.txt
COPY planner_api/ planner_api/
COPY bim_planner/ bim_planner/
COPY --from=frontend /web/dist web/dist
ENV CIVIL_BIM_DB=/var/data/planner.sqlite3
CMD ["sh", "-c", "exec python -m uvicorn planner_api.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
