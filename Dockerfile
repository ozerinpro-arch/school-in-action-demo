FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS frontend
WORKDIR /demo
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json index.html playwright.config.ts ./
COPY public ./public
COPY src ./src
COPY tests ./tests
RUN npm run build

FROM python:3.12.16-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 SHKOLA_DB_PATH=/data/demo.sqlite3
WORKDIR /demo
COPY requirements.lock ./
RUN pip install --no-cache-dir --no-deps -r requirements.lock \
    && pip check \
    && mkdir /data \
    && chown 10001:10001 /data
COPY server ./server
COPY --from=frontend /demo/dist ./dist
USER 10001:10001
EXPOSE 5188
CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "5188", "--no-proxy-headers", "--no-access-log"]
