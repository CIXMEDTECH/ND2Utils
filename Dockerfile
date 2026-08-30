# syntax=docker/dockerfile:1
FROM node:22-bookworm AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend ./
RUN npm run build

FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 libgl1 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
COPY backend/pyproject.toml /app/backend/pyproject.toml
COPY backend/nd2utils /app/backend/nd2utils
RUN pip install --no-cache-dir /app/backend
COPY --from=web /src/frontend/dist /app/frontend/dist
ENV ND2UTILS_DATA_DIR=/data \
    ND2UTILS_BIND_HOST=0.0.0.0 \
    ND2UTILS_PORT=8080
EXPOSE 8080
VOLUME ["/data"]
WORKDIR /app/backend
CMD ["uvicorn", "nd2utils.main:app", "--host", "0.0.0.0", "--port", "8080"]
