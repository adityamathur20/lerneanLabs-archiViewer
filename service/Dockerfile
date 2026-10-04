# syntax=docker/dockerfile:1
# The API tier. archiAgent is deliberately absent: spec §5.2 forbids importing
# it, and the surest way to honour that is for the import to be impossible.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY pyproject.toml ./
COPY archiagent_service ./archiagent_service
COPY alembic ./alembic
COPY alembic.ini ./

RUN pip install --no-cache-dir . \
 && adduser --system --no-create-home --uid 10001 appuser
USER appuser

EXPOSE 8000
CMD ["uvicorn", "archiagent_service.api:app", "--host", "0.0.0.0", "--port", "8000"]
