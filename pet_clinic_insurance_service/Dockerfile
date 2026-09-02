FROM --platform=linux/amd64 public.ecr.aws/docker/library/python:3.10

WORKDIR /app
RUN mkdir -p /app/tmp && \
    export TMPDIR=/app/tmp && \
    pip install --no-cache-dir django djangorestframework boto3 py_eureka_client psycopg2 requests && \
    pip install --no-cache-dir opentelemetry-distro opentelemetry-exporter-otlp && \
    pip install --no-cache-dir cloudwatch-plugin-otel && \
    opentelemetry-bootstrap -a install

COPY . /app
EXPOSE 8000
