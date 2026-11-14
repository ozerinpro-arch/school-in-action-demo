FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS frontend
WORKDIR /demo/full-school/app
COPY full-school/app/package.json full-school/app/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY full-school/app/index.html full-school/app/tsconfig.json full-school/app/vite.config.ts ./
COPY full-school/app/public/ ./public/
COPY full-school/app/src/ ./src/
COPY full-school/app/scripts/ ./scripts/
RUN npx --no-install tsc --noEmit \
    && node scripts/build-portal.mjs \
    && SHKOLA_STAFF_BUILD_BASE=/school-staff/ node scripts/build-staff.mjs

FROM python:3.12.16-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /demo/full-school
COPY full-school/app/requirements.lock .
RUN pip install --no-cache-dir -r requirements.lock \
    && pip check \
    && install -d -m 0700 -o 10001 -g 10001 /tmp/school-demo
COPY full-school/app/server/ ./app/server/
COPY full-school/local-runtime/ ./local-runtime/
COPY --from=frontend /demo/full-school/app/dist/ ./app/dist/
COPY --from=frontend /demo/full-school/app/dist-staff/ ./app/dist-staff/
USER 10001:10001
EXPOSE 5261
CMD ["python", "-B", "local-runtime/serve.py", "--container"]
